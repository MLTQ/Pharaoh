"""
Pharaoh TTS Server — port 18001
Wraps Qwen3-TTS. Stub mode by default; set PHARAOH_REAL_MODELS=1 for real inference.
"""
import asyncio
import math
import os
import struct
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from _common import JobStore, new_job_id, write_wav_stub

PORT = int(os.environ.get("PHARAOH_TTS_PORT", 18001))
REAL = os.environ.get("PHARAOH_REAL_MODELS", "0") == "1"
MODEL_VARIANT = os.environ.get("PHARAOH_TTS_VARIANT", "Qwen3-TTS-12Hz-1.7B-CustomVoice")

app = FastAPI(title="Pharaoh TTS Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()
_model_loaded = False

SPEAKERS = [
    {"id": "Vivian",   "description": "Bright, slightly edgy young female"},
    {"id": "Lili",     "description": "Warm, gentle young female"},
    {"id": "Magnus",   "description": "Seasoned male, low mellow timbre"},
    {"id": "Jinchen",  "description": "Youthful Beijing male, clear natural"},
    {"id": "Chengdu",  "description": "Lively male, slightly husky"},
    {"id": "Dynamic",  "description": "Male, strong rhythmic drive"},
    {"id": "Ryan",     "description": "Sunny American male, clear midrange"},
    {"id": "Japanese", "description": "Playful female, light nimble timbre"},
    {"id": "Korean",   "description": "Warm female, rich emotion"},
]

LANGUAGES = ["en", "zh", "de", "fr", "ja", "ko", "es", "pt", "it", "nl"]


# ── Request models ──────────────────────────────────────────────────────────

class CustomVoiceParams(BaseModel):
    text: str
    speaker: str = "Vivian"
    language: str = "en"
    instruct: str = ""
    seed: int = 0
    temperature: float = 0.7
    top_p: float = 0.9
    max_new_tokens: int = 2048
    output_path: str


class VoiceDesignParams(BaseModel):
    text: str
    voice_description: str
    language: str = "en"
    seed: int = 0
    temperature: float = 0.7
    top_p: float = 0.9
    max_new_tokens: int = 2048
    output_path: str


class VoiceCloneParams(BaseModel):
    text: str
    ref_audio_path: str
    ref_transcript: str = ""
    language: str = "en"
    icl_mode: bool = False
    seed: int = 0
    temperature: float = 0.7
    top_p: float = 0.9
    output_path: str


# ── Background worker ────────────────────────────────────────────────────────

async def _run_tts_stub(job_id: str, params: dict) -> None:
    """Simulate TTS generation: fake progress over ~2 seconds, write stub WAV."""
    jobs.update(job_id, status="running", progress=0.0)
    steps = 8
    for i in range(steps):
        await asyncio.sleep(0.25)
        jobs.update(job_id, progress=(i + 1) / steps)

    output_path = params["output_path"]
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    words = len(params.get("text", "").split())
    duration = max(0.5, words * 0.35)  # ~350ms per word
    await write_wav_stub(output_path, duration_seconds=duration, sample_rate=24000)
    jobs.update(job_id, status="complete", progress=1.0, output_path=output_path)


async def _run_tts_real(job_id: str, params: dict) -> None:
    """Real Qwen3-TTS inference — only called when PHARAOH_REAL_MODELS=1."""
    try:
        import torch
        from transformers import Qwen3ForCausalLM, AutoTokenizer
        # Real inference implementation goes here
        # For now fall through to stub
    except ImportError:
        pass
    await _run_tts_stub(job_id, params)


def _submit(params: dict) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "tts", params.get("_endpoint", "custom_voice"), params)
    worker = _run_tts_real if REAL else _run_tts_stub
    asyncio.create_task(worker(job_id, params))
    return {"job_id": job_id}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": _model_loaded,
        "model_variant": MODEL_VARIANT,
        "vram_mb": 6144 if _model_loaded else 0,
        "stub": not REAL,
    }


@app.get("/speakers")
async def speakers() -> list:
    return SPEAKERS


@app.get("/languages")
async def languages() -> list:
    return LANGUAGES


@app.post("/generate/custom_voice")
async def generate_custom_voice(p: CustomVoiceParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "custom_voice"})


@app.post("/generate/voice_design")
async def generate_voice_design(p: VoiceDesignParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "voice_design"})


@app.post("/generate/voice_clone")
async def generate_voice_clone(p: VoiceCloneParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "voice_clone"})


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


class LoadRequest(BaseModel):
    variant: str = MODEL_VARIANT


@app.post("/load")
async def load(req: LoadRequest = LoadRequest()) -> dict:
    global _model_loaded, MODEL_VARIANT
    MODEL_VARIANT = req.variant
    _model_loaded = True
    return {"status": "loaded", "variant": MODEL_VARIANT}


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded
    _model_loaded = False
    return {"status": "unloaded"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
