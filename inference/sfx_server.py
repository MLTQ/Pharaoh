"""
Pharaoh SFX Server — port 18002
Wraps Woosh (Sony AI). Stub mode by default; set PHARAOH_REAL_MODELS=1 for real inference.
"""
import asyncio
import logging
import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from _common import JobStore, new_job_id, write_wav_stub

log = logging.getLogger(__name__)

PORT        = int(os.environ.get("PHARAOH_SFX_PORT",     18002))
REAL        = os.environ.get("PHARAOH_REAL_MODELS", "0") == "1"
MODEL_VARIANT = os.environ.get("PHARAOH_SFX_VARIANT",  "Woosh-DFlow")
WOOSH_DIR   = Path(os.environ.get("PHARAOH_WOOSH_DIR",  "")).expanduser()

SAMPLE_RATE   = 48000
LATENT_CHANS  = 128
FRAMES_PER_S  = 100.2   # empirical: 501 latent frames ≈ 5 s

app = FastAPI(title="Pharaoh SFX Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()
_model_loaded = False

# ── Woosh model state ────────────────────────────────────────────────────────

_ldm    = None   # FlowMapFromPretrained instance
_device = None   # "cuda" | "mps" | "cpu"


def _woosh_status() -> dict:
    """Return a dict describing whether WOOSH_DIR looks usable."""
    if not WOOSH_DIR or not WOOSH_DIR.is_dir():
        return {"ok": False, "reason": f"PHARAOH_WOOSH_DIR not set or not found: '{WOOSH_DIR}'"}
    required = ["checkpoints/Woosh-AE", "checkpoints/TextConditionerA", f"checkpoints/{MODEL_VARIANT}"]
    missing = [r for r in required if not (WOOSH_DIR / r).exists()]
    if missing:
        return {"ok": False, "reason": f"Missing checkpoints: {', '.join(missing)}"}
    return {"ok": True, "reason": ""}


def _resolve_device() -> str:
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load_sfx_model() -> None:
    """Load Woosh model synchronously (run via executor so we don't block event loop)."""
    global _ldm, _device
    import sys
    import torch

    # Ensure the Woosh repo is importable
    woosh_src = str(WOOSH_DIR)
    if woosh_src not in sys.path:
        sys.path.insert(0, woosh_src)

    from woosh.components.base import LoadConfig
    from woosh.model.flowmap_from_pretrained import FlowMapFromPretrained

    _device = _resolve_device()
    ckpt = str(WOOSH_DIR / "checkpoints" / MODEL_VARIANT)
    log.info(f"Loading Woosh model from {ckpt} on {_device}")
    _ldm = FlowMapFromPretrained(LoadConfig(path=ckpt))
    _ldm = _ldm.eval().to(_device)
    log.info("Woosh model loaded.")


# ── Request models ──────────────────────────────────────────────────────────

class T2AParams(BaseModel):
    prompt: str
    duration_seconds: float = 3.0
    model_variant: str = "Woosh-DFlow"
    steps: int = 4
    seed: int = 0
    output_path: str


class V2AParams(BaseModel):
    video_path: str
    prompt_override: str = ""
    model_variant: str = "Woosh-DVFlow"
    steps: int = 4
    seed: int = 0
    output_path: str


# ── Background workers ───────────────────────────────────────────────────────

async def _run_sfx_stub(job_id: str, params: dict) -> None:
    """Simulate SFX generation: fake progress, write stub WAV at 48kHz (mono)."""
    jobs.update(job_id, status="running", progress=0.0)
    steps = int(params.get("steps", 4)) * 2
    for i in range(steps):
        await asyncio.sleep(0.15)
        jobs.update(job_id, progress=(i + 1) / steps)

    output_path = params["output_path"]
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    duration = float(params.get("duration_seconds", 3.0))
    await write_wav_stub(output_path, duration_seconds=duration, sample_rate=SAMPLE_RATE)
    jobs.update(job_id, status="complete", progress=1.0, output_path=output_path)


async def _run_sfx_real(job_id: str, params: dict) -> None:
    global _ldm, _device

    if _ldm is None:
        jobs.update(job_id, status="failed", error="Model not loaded — call /load first")
        return

    jobs.update(job_id, status="running", progress=0.05)
    try:
        import sys
        import torch
        import torchaudio

        woosh_src = str(WOOSH_DIR)
        if woosh_src not in sys.path:
            sys.path.insert(0, woosh_src)
        from woosh.inference.flowmap_sampler import sample_euler

        prompt   = params["prompt"]
        steps    = int(params.get("steps", 4))
        seed     = int(params.get("seed", 0))
        duration = float(params.get("duration_seconds", 3.0))
        out_path = params["output_path"]

        torch.manual_seed(seed)

        latent_frames = max(50, round(duration * FRAMES_PER_S))
        noise = torch.randn(1, LATENT_CHANS, latent_frames).to(_device)

        jobs.update(job_id, progress=0.15)

        cond = _ldm.get_cond(
            {"audio": None, "description": [prompt]},
            no_dropout=True,
            device=_device,
        )

        jobs.update(job_id, progress=0.25)

        # Build renoise schedule (first element is always 0)
        if steps == 4:
            renoise = [0, 0.5, 0.5, 0.3]
        else:
            # Linearly interpolate a schedule
            renoise = [0] + [0.5 * (1 - i / (steps - 1)) for i in range(1, steps)]

        loop = asyncio.get_event_loop()

        def _infer():
            with torch.inference_mode():
                x = sample_euler(
                    model=_ldm,
                    noise=noise,
                    cond=cond,
                    num_steps=steps,
                    renoise=renoise,
                    cfg=4.5,
                )
                return _ldm.autoencoder.inverse(x)

        audio = await loop.run_in_executor(None, _infer)

        jobs.update(job_id, progress=0.85)

        audio = audio.cpu().float()
        peak = audio.abs().amax(dim=-1, keepdim=True).clamp(min=1.0)
        audio = audio / peak

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        await loop.run_in_executor(None, lambda: torchaudio.save(out_path, audio[0], sample_rate=SAMPLE_RATE))

        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path)

    except Exception as exc:
        log.exception("Woosh inference failed")
        jobs.update(job_id, status="failed", error=str(exc))


def _submit(params: dict) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "sfx", params.get("_endpoint", "t2a"), params)
    worker = _run_sfx_real if REAL else _run_sfx_stub
    asyncio.create_task(worker(job_id, params))
    return {"job_id": job_id}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    ws = _woosh_status()
    return {
        "status": "ok",
        "model_loaded": _model_loaded,
        "model_variant": MODEL_VARIANT,
        "vram_mb": 2048 if _model_loaded else 0,
        "stub": not REAL,
        "woosh_dir": str(WOOSH_DIR),
        "woosh_ready": ws["ok"],
        "woosh_error": ws["reason"],
    }


@app.post("/generate/t2a")
async def generate_t2a(p: T2AParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "t2a"})


@app.post("/generate/v2a")
async def generate_v2a(p: V2AParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "v2a"})


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.post("/load")
async def load() -> dict:
    global _model_loaded
    ws = _woosh_status()
    if REAL and not ws["ok"]:
        return {"status": "error", "error": ws["reason"]}

    if REAL:
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _load_sfx_model)
        except Exception as exc:
            log.exception("Failed to load Woosh model")
            return {"status": "error", "error": str(exc)}

    _model_loaded = True
    return {"status": "loaded", "woosh_dir": str(WOOSH_DIR)}


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded, _ldm
    _model_loaded = False
    _ldm = None
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
