"""
Pharaoh Music Server — port 18003
Wraps ACE-Step 1.5. Stub mode by default; set PHARAOH_REAL_MODELS=1 for real inference.

Real-mode requirements:
    pip install ace-step
"""
import asyncio
import logging
import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from _common import JobStore, new_job_id, write_wav_stub

log = logging.getLogger(__name__)

PORT            = int(os.environ.get("PHARAOH_MUSIC_PORT",    18003))
REAL            = os.environ.get("PHARAOH_REAL_MODELS", "0") == "1"
MODEL_VARIANT   = os.environ.get("PHARAOH_MUSIC_VARIANT",  "ace-step-v1-5-checkpoint")
MUSIC_MODEL_DIR = Path(os.environ.get("PHARAOH_MUSIC_MODEL_DIR", "~/pharaoh-models/music")).expanduser()

app = FastAPI(title="Pharaoh Music Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()
_model_loaded = False

STEMS = ["vocals", "backing_vocals", "drums", "bass", "guitar", "keyboard",
         "percussion", "strings", "synth", "fx", "brass", "woodwinds"]

# ── ACE-Step model state ─────────────────────────────────────────────────────

_pipeline = None  # ACEStepPipeline instance


def _load_music_model() -> None:
    global _pipeline
    from acestep.pipeline import ACEStepPipeline

    if not MUSIC_MODEL_DIR.is_dir():
        raise RuntimeError(f"Music model directory not found: {MUSIC_MODEL_DIR}")

    log.info(f"Loading ACE-Step from {MUSIC_MODEL_DIR}")
    _pipeline = ACEStepPipeline.from_pretrained(str(MUSIC_MODEL_DIR))
    log.info("ACE-Step loaded.")


# ── Request models ──────────────────────────────────────────────────────────

class Text2MusicParams(BaseModel):
    caption: str
    lyrics: str = ""
    duration_seconds: float = 30.0
    bpm: int | None = None
    key: str = ""
    language: str = "en"
    lm_model_size: str = "1.7B"
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


# ── Background workers ───────────────────────────────────────────────────────

async def _run_music_stub(job_id: str, params: dict) -> None:
    """Simulate music generation: slow fake progress, write stub WAV at 44.1kHz stereo."""
    jobs.update(job_id, status="running", progress=0.0)
    duration = float(params.get("duration_seconds", 30.0))
    steps = params.get("diffusion_steps", 60)
    for i in range(steps):
        await asyncio.sleep(0.08)
        jobs.update(job_id, progress=(i + 1) / steps)

    output_path = params["output_path"]
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    await write_wav_stub(output_path, duration_seconds=min(duration, 5.0), sample_rate=44100)
    jobs.update(job_id, status="complete", progress=1.0, output_path=output_path)


async def _run_music_real(job_id: str, params: dict) -> None:
    """Real ACE-Step inference via ace-step package."""
    global _pipeline

    if _pipeline is None:
        jobs.update(job_id, status="failed", error="Music model not loaded — call /load first")
        return

    jobs.update(job_id, status="running", progress=0.05)
    try:
        import torch

        endpoint = params.get("_endpoint", "text2music")
        out_path = params["output_path"]
        seed     = int(params.get("seed", 0))
        steps    = int(params.get("diffusion_steps", 60))
        duration = float(params.get("duration_seconds", 30.0))

        if seed:
            torch.manual_seed(seed)

        loop = asyncio.get_event_loop()
        jobs.update(job_id, progress=0.10)

        if endpoint == "text2music":
            caption = params.get("caption", "")
            lyrics  = params.get("lyrics", "")
            bpm     = params.get("bpm")
            key     = params.get("key", "")
            ref     = params.get("reference_audio_path", "")

            audio, sr = await loop.run_in_executor(
                None,
                lambda: _pipeline.generate(
                    caption=caption,
                    lyrics=lyrics if lyrics else None,
                    duration=duration,
                    bpm=bpm,
                    key=key if key else None,
                    reference_audio_path=ref if ref else None,
                    num_inference_steps=steps,
                    seed=seed,
                ),
            )
        elif endpoint == "cover":
            audio, sr = await loop.run_in_executor(
                None,
                lambda: _pipeline.cover(
                    source_audio_path=params["source_audio_path"],
                    caption=params.get("caption", ""),
                    cover_strength=float(params.get("cover_strength", 0.5)),
                    num_inference_steps=steps,
                    seed=seed,
                ),
            )
        elif endpoint == "repaint":
            audio, sr = await loop.run_in_executor(
                None,
                lambda: _pipeline.repaint(
                    source_audio_path=params["source_audio_path"],
                    caption=params.get("caption", ""),
                    start_time=params.get("start_ms", 0) / 1000.0,
                    end_time=params.get("end_ms", 10000) / 1000.0,
                    num_inference_steps=steps,
                    seed=seed,
                ),
            )
        else:
            raise ValueError(f"Unsupported music endpoint: {endpoint}")

        jobs.update(job_id, progress=0.90)

        import soundfile as sf
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        await loop.run_in_executor(None, lambda: sf.write(out_path, audio, sr))

        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path)

    except Exception as exc:
        log.exception("ACE-Step inference failed")
        jobs.update(job_id, status="failed", error=str(exc))


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
    return _submit({**p.model_dump(), "_endpoint": "text2music"}, "text2music")


@app.post("/generate/cover")
async def generate_cover(p: CoverParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "cover"}, "cover")


@app.post("/generate/repaint")
async def generate_repaint(p: RepaintParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "repaint"}, "repaint")


@app.post("/generate/lego")
async def generate_lego(p: LegoParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "lego"}, "lego")


@app.post("/generate/extract")
async def generate_extract(p: ExtractParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "extract"}, "extract")


@app.post("/generate/complete")
async def generate_complete(p: CompleteParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "complete"}, "complete")


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.post("/load")
async def load() -> dict:
    global _model_loaded
    if REAL:
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _load_music_model)
        except Exception as exc:
            log.exception("Failed to load music model")
            return {"status": "error", "error": str(exc)}

    _model_loaded = True
    return {"status": "loaded"}


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded, _pipeline
    _model_loaded = False
    _pipeline = None
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
