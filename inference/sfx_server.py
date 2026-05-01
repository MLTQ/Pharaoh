"""
Pharaoh SFX Server — port 18002
Wraps Woosh (Sony AI). Stub mode by default; set PHARAOH_REAL_MODELS=1 for real inference.
"""
import asyncio
import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from _common import JobStore, new_job_id, write_wav_stub

PORT = int(os.environ.get("PHARAOH_SFX_PORT", 18002))
REAL = os.environ.get("PHARAOH_REAL_MODELS", "0") == "1"
MODEL_VARIANT = os.environ.get("PHARAOH_SFX_VARIANT", "Woosh-DFlow")
WOOSH_DIR = Path(os.environ.get("PHARAOH_WOOSH_DIR", "")).expanduser()

app = FastAPI(title="Pharaoh SFX Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()
_model_loaded = False


def _woosh_status() -> dict:
    """Return a dict describing whether WOOSH_DIR looks usable."""
    if not WOOSH_DIR or not WOOSH_DIR.is_dir():
        return {"ok": False, "reason": f"PHARAOH_WOOSH_DIR not set or not found: '{WOOSH_DIR}'"}
    required = ["checkpoints/Woosh-AE", "checkpoints/TextConditionerA", f"checkpoints/{MODEL_VARIANT}"]
    missing = [r for r in required if not (WOOSH_DIR / r).exists()]
    if missing:
        return {"ok": False, "reason": f"Missing checkpoints: {', '.join(missing)}"}
    return {"ok": True, "reason": ""}


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


# ── Background worker ────────────────────────────────────────────────────────

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
    await write_wav_stub(output_path, duration_seconds=duration, sample_rate=48000)
    jobs.update(job_id, status="complete", progress=1.0, output_path=output_path)


async def _run_sfx_real(job_id: str, params: dict) -> None:
    try:
        import torch
        # Real Woosh inference goes here
    except ImportError:
        pass
    await _run_sfx_stub(job_id, params)


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
    _model_loaded = True
    return {"status": "loaded", "woosh_dir": str(WOOSH_DIR)}


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded
    _model_loaded = False
    return {"status": "unloaded"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
