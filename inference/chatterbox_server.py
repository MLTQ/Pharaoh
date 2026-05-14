"""
Pharaoh Chatterbox Server — port 18005

Wraps Chatterbox Turbo (Resemble AI, 0.5B) for 0-shot voice cloning with
inline paralinguistic tags ([sigh], [chuckle], [laugh], etc.).

Model: resemble-ai/chatterbox — turbo variant (supports tags + cloning).
Install: pip install chatterbox-tts

Typical RAM footprint: ~4–6 GB (CPU), ~2 GB VRAM (GPU/MPS).
Isolated venv: inference/.venv-chatterbox
"""
import asyncio
import datetime
import json
import logging
import os
from pathlib import Path
from typing import Optional

import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from _common import JobStore, new_job_id

log = logging.getLogger(__name__)

PORT = int(os.environ.get("PHARAOH_CHATTERBOX_PORT", 18005))

app = FastAPI(title="Pharaoh Chatterbox Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()

_model = None
_load_lock = asyncio.Lock()
OOM_MARKER = "CHATTERBOX_OOM"


# ── Sidecar helper ────────────────────────────────────────────────────────────

def _write_sidecar(audio_path: str, meta: dict) -> None:
    """Write a .meta.json sidecar next to the generated audio file."""
    sidecar = {
        "model":              meta.get("model", "chatterbox-turbo"),
        "model_variant":      meta.get("model_variant", "chatterbox-turbo-0.5B"),
        "prompt":             meta.get("prompt", ""),
        "instruct":           None,  # tags are inline in prompt text
        "speaker":            None,
        "language":           None,
        "seed":               meta.get("seed", 0),
        "temperature":        meta.get("temperature"),
        "top_p":              None,
        "duration_target_ms": None,
        "duration_actual_ms": meta.get("duration_actual_ms"),
        "sample_rate":        meta.get("sample_rate"),
        "generated_at":       datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "parent":             meta.get("parent"),
        "take_index":         meta.get("take_index", 1),
        "qa_status":          "unreviewed",
        "qa_notes":           "",
    }
    try:
        Path(str(audio_path) + ".meta.json").write_text(json.dumps(sidecar, indent=2))
    except Exception as exc:
        log.warning(f"Failed to write sidecar for {audio_path}: {exc}")


# ── Model management ──────────────────────────────────────────────────────────

def _is_memory_error(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in ("OutOfMemoryError", "MemoryError"):
        return True
    msg = str(exc).lower()
    return any(s in msg for s in (
        "out of memory", "cuda oom", "mps backend out of memory",
        "cannot allocate", "memory allocation",
    ))


def _detect_device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def _do_load() -> None:
    global _model
    from chatterbox.tts import ChatterboxTTS  # type: ignore

    device = _detect_device()
    log.info(f"Loading Chatterbox Turbo on device={device}")
    _model = ChatterboxTTS.from_pretrained(device)
    log.info("Chatterbox Turbo loaded.")


async def _ensure_model() -> Optional[str]:
    """Load model if not loaded. Returns error string on failure, None on success."""
    if _model is not None:
        return None
    async with _load_lock:
        if _model is not None:
            return None
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _do_load)
        except ImportError as exc:
            return (
                f"chatterbox-tts package not installed: {exc}. "
                f"Run: uv pip install chatterbox-tts  (in inference/.venv-chatterbox)"
            )
        except Exception as exc:
            log.exception("Chatterbox load failed")
            if _is_memory_error(exc):
                return f"{OOM_MARKER}: Not enough memory to load Chatterbox. Free a model first."
            return f"Load failed: {exc}"
    return None


# ── Request model ─────────────────────────────────────────────────────────────

class CloneParams(BaseModel):
    job_id: Optional[str] = None
    text: str
    """Dialogue text. May include inline paralinguistic tags like [sigh], [chuckle], [laugh]."""
    ref_audio_path: str
    """Absolute path to a reference WAV for voice identity (palette reference clip)."""
    ref_transcript: str = ""
    """Optional transcript of ref audio. Not required for Chatterbox Turbo."""
    exaggeration: float = 0.5
    """0–1: how strongly to colour the vocal performance. 0=neutral, 1=max expression."""
    cfg_weight: float = 0.5
    """Classifier-free guidance strength. Higher = more faithful to ref, less varied."""
    temperature: float = 0.8
    seed: int = 0
    output_path: str


# ── Background worker ─────────────────────────────────────────────────────────

async def _run_clone(job_id: str, params: CloneParams) -> None:
    jobs.update(job_id, status="running", progress=0.02)

    err = await _ensure_model()
    if err:
        log.warning(f"Job {job_id} failed: {err}")
        jobs.update(job_id, status="failed", error=err)
        return

    jobs.update(job_id, progress=0.10)
    try:
        out_path = Path(params.output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        ref_path = Path(params.ref_audio_path)
        if not ref_path.is_file():
            jobs.update(job_id, status="failed", error=f"ref_audio_path not found: {ref_path}")
            return

        loop = asyncio.get_running_loop()
        jobs.update(job_id, progress=0.15)

        # Chatterbox uses a generator pattern — run blocking call in executor
        import torch

        def _generate():
            generator = torch.manual_seed(params.seed) if params.seed else None
            wav = _model.generate(
                params.text,
                audio_prompt_path=str(ref_path),
                exaggeration=params.exaggeration,
                cfg_weight=params.cfg_weight,
                temperature=params.temperature,
                **({"generator": generator} if generator is not None else {}),
            )
            return wav

        jobs.update(job_id, progress=0.20)
        wav_tensor = await loop.run_in_executor(None, _generate)
        jobs.update(job_id, progress=0.90)

        # wav_tensor is a torch.Tensor [1, N] at _model.sr sample rate
        sr = _model.sr
        wav_np = wav_tensor.squeeze().cpu().numpy()
        sf.write(str(out_path), wav_np, sr)

        duration_ms = int(len(wav_np) / sr * 1000)
        _write_sidecar(str(out_path), {
            "model": "chatterbox-turbo",
            "model_variant": "chatterbox-turbo-0.5B",
            "prompt": params.text,
            "seed": params.seed,
            "temperature": params.temperature,
            "duration_actual_ms": duration_ms,
            "sample_rate": sr,
            "parent": params.ref_audio_path,
        })
        jobs.update(job_id, status="complete", progress=1.0, output_path=str(out_path))

    except Exception as exc:
        log.exception("Chatterbox generation failed")
        if _is_memory_error(exc):
            jobs.update(job_id, status="failed", error=f"{OOM_MARKER}: {exc}")
        else:
            jobs.update(job_id, status="failed", error=str(exc))


def _submit(params: CloneParams) -> dict:
    job_id = params.job_id or new_job_id()
    params_dict = params.model_dump() if hasattr(params, "model_dump") else params.dict()
    jobs.create(job_id, "chatterbox", "clone", params_dict)
    asyncio.create_task(_run_clone(job_id, params))
    return {"job_id": job_id, "status": "queued"}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": _model is not None,
        "model_variant": "chatterbox-turbo-0.5B",
        "vram_mb": 2048 if _model is not None else 0,
        "stub": False,
        "device": _detect_device(),
    }


@app.post("/generate/clone")
async def generate_clone(p: CloneParams) -> dict:
    if not p.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    if not p.ref_audio_path:
        raise HTTPException(status_code=400, detail="ref_audio_path is required")
    return _submit(p)


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.post("/load")
async def load() -> dict:
    err = await _ensure_model()
    if err:
        return {"status": "error", "error": err}
    return {"status": "loaded"}


@app.post("/unload")
async def unload() -> dict:
    global _model
    _model = None
    import gc
    gc.collect()
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
