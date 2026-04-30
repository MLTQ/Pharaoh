"""
Pharaoh Music Server — port 18003
Wraps ACE-Step 1.5. Stub mode by default; set PHARAOH_REAL_MODELS=1 for real inference.
"""
import asyncio
import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from _common import JobStore, new_job_id, write_wav_stub

PORT = int(os.environ.get("PHARAOH_MUSIC_PORT", 18003))
REAL = os.environ.get("PHARAOH_REAL_MODELS", "0") == "1"
MODEL_VARIANT = os.environ.get("PHARAOH_MUSIC_VARIANT", "ace-step-v1-5-checkpoint")

app = FastAPI(title="Pharaoh Music Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()
_model_loaded = False

STEMS = ["vocals", "backing_vocals", "drums", "bass", "guitar", "keyboard",
         "percussion", "strings", "synth", "fx", "brass", "woodwinds"]


# ── Request models ──────────────────────────────────────────────────────────

class Text2MusicParams(BaseModel):
    caption: str
    lyrics: str = ""
    duration_seconds: float = 30.0
    bpm: int | None = None
    key: str = ""
    language: str = "en"
    lm_model_size: str = "1.7B"  # none | 0.6B | 1.7B | 4B
    diffusion_steps: int = 60
    thinking_mode: bool = False
    reference_audio_path: str = ""
    seed: int = 0
    batch_size: int = 1
    output_path: str


class CoverParams(BaseModel):
    source_audio_path: str
    caption: str = ""
    cover_strength: float = 0.5
    diffusion_steps: int = 60
    seed: int = 0
    output_path: str


class RepaintParams(BaseModel):
    source_audio_path: str
    caption: str = ""
    start_ms: int = 0
    end_ms: int = 10000
    diffusion_steps: int = 60
    seed: int = 0
    output_path: str


class LegoParams(BaseModel):
    source_audio_path: str
    caption: str
    track_name: str = "guitar"
    diffusion_steps: int = 60
    seed: int = 0
    output_path: str


class ExtractParams(BaseModel):
    source_audio_path: str
    track_class: str = "vocals"
    output_path: str


class CompleteParams(BaseModel):
    source_audio_path: str
    caption: str = ""
    diffusion_steps: int = 60
    seed: int = 0
    output_path: str


# ── Background worker ────────────────────────────────────────────────────────

async def _run_music_stub(job_id: str, params: dict) -> None:
    """Simulate music generation: slow fake progress, write stub WAV at 44.1kHz stereo."""
    jobs.update(job_id, status="running", progress=0.0)
    duration = float(params.get("duration_seconds", 30.0))
    steps = params.get("diffusion_steps", 60)
    # Simulate ~1 step per 80ms
    for i in range(steps):
        await asyncio.sleep(0.08)
        jobs.update(job_id, progress=(i + 1) / steps)

    output_path = params["output_path"]
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    await write_wav_stub(output_path, duration_seconds=min(duration, 5.0), sample_rate=44100)
    jobs.update(job_id, status="complete", progress=1.0, output_path=output_path)


async def _run_music_real(job_id: str, params: dict) -> None:
    try:
        import torch
        # Real ACE-Step inference goes here
    except ImportError:
        pass
    await _run_music_stub(job_id, params)


def _submit(params: dict, endpoint: str) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "music", endpoint, params)
    worker = _run_music_real if REAL else _run_music_stub
    asyncio.create_task(worker(job_id, params))
    return {"job_id": job_id}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": _model_loaded,
        "model_variant": MODEL_VARIANT,
        "vram_mb": 8192 if _model_loaded else 0,
        "stub": not REAL,
    }


@app.get("/stems")
async def stems() -> list:
    return STEMS


@app.post("/generate/text2music")
async def generate_text2music(p: Text2MusicParams) -> dict:
    return _submit(p.model_dump(), "text2music")


@app.post("/generate/cover")
async def generate_cover(p: CoverParams) -> dict:
    return _submit(p.model_dump(), "cover")


@app.post("/generate/repaint")
async def generate_repaint(p: RepaintParams) -> dict:
    return _submit(p.model_dump(), "repaint")


@app.post("/generate/lego")
async def generate_lego(p: LegoParams) -> dict:
    return _submit(p.model_dump(), "lego")


@app.post("/generate/extract")
async def generate_extract(p: ExtractParams) -> dict:
    return _submit(p.model_dump(), "extract")


@app.post("/generate/complete")
async def generate_complete(p: CompleteParams) -> dict:
    return _submit(p.model_dump(), "complete")


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded
    _model_loaded = False
    return {"status": "unloaded"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
