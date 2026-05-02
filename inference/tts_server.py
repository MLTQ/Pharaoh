"""
Pharaoh TTS Server — port 18001
Wraps Qwen3-TTS. Stub mode by default; set PHARAOH_REAL_MODELS=1 for real inference.

Real-mode requirements:
    pip install qwen-tts soundfile
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

PORT          = int(os.environ.get("PHARAOH_TTS_PORT",    18001))
REAL          = os.environ.get("PHARAOH_REAL_MODELS", "0") == "1"
MODEL_VARIANT = os.environ.get("PHARAOH_TTS_VARIANT",  "Qwen3-TTS-12Hz-1.7B-CustomVoice")
TTS_MODEL_DIR = Path(os.environ.get("PHARAOH_TTS_MODEL_DIR", "~/pharaoh-models/tts")).expanduser()

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

# Map speaker IDs to qwen-tts voice names
_SPEAKER_MAP = {
    "Vivian":   "Vivian",
    "Lili":     "Lili",
    "Magnus":   "Magnus",
    "Jinchen":  "Jinchen",
    "Chengdu":  "Chengdu",
    "Dynamic":  "Dynamic",
    "Ryan":     "Ryan",
    "Japanese": "Japanese",
    "Korean":   "Korean",
}

# ── TTS model state ─────────────────────────────────────────────────────────

_tts_model = None   # Qwen3TTSModel instance


def _load_tts_model() -> None:
    global _tts_model
    import torch
    from qwen_tts import Qwen3TTSModel

    if not TTS_MODEL_DIR.is_dir():
        raise RuntimeError(f"TTS model directory not found: {TTS_MODEL_DIR}")

    device_map = "mps" if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() \
                else "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16

    log.info(f"Loading Qwen3-TTS from {TTS_MODEL_DIR} on {device_map}")
    _tts_model = Qwen3TTSModel.from_pretrained(
        str(TTS_MODEL_DIR),
        device_map=device_map,
        dtype=dtype,
    )
    log.info("Qwen3-TTS loaded.")


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


# ── Background workers ───────────────────────────────────────────────────────

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
    duration = max(0.5, words * 0.35)
    await write_wav_stub(output_path, duration_seconds=duration, sample_rate=24000)
    jobs.update(job_id, status="complete", progress=1.0, output_path=output_path)


def _lang_label(code: str) -> str:
    _map = {"en": "English", "zh": "Chinese", "de": "German", "fr": "French",
            "ja": "Japanese", "ko": "Korean", "es": "Spanish", "pt": "Portuguese",
            "it": "Italian", "nl": "Dutch"}
    return _map.get(code, "English")


async def _run_tts_real(job_id: str, params: dict) -> None:
    """Real Qwen3-TTS inference via qwen-tts package."""
    global _tts_model

    if _tts_model is None:
        jobs.update(job_id, status="failed", error="TTS model not loaded — call /load first")
        return

    jobs.update(job_id, status="running", progress=0.1)
    try:
        import soundfile as sf
        import torch

        endpoint  = params.get("_endpoint", "custom_voice")
        out_path  = params["output_path"]
        text      = params["text"]
        language  = _lang_label(params.get("language", "en"))
        seed      = int(params.get("seed", 0))

        if seed:
            torch.manual_seed(seed)

        loop = asyncio.get_event_loop()

        if endpoint == "voice_design":
            voice_desc = params.get("voice_description", "")
            wavs, sr = await loop.run_in_executor(
                None,
                lambda: _tts_model.generate_voice_design(
                    text=text,
                    language=language,
                    voice_description=voice_desc,
                ),
            )
        elif endpoint == "voice_clone":
            ref_path   = params.get("ref_audio_path", "")
            ref_text   = params.get("ref_transcript", "")
            wavs, sr = await loop.run_in_executor(
                None,
                lambda: _tts_model.generate_voice_clone(
                    text=text,
                    language=language,
                    ref_audio=ref_path,
                    ref_text=ref_text,
                ),
            )
        else:
            # custom_voice
            speaker = _SPEAKER_MAP.get(params.get("speaker", "Vivian"), "Vivian")
            instruct = params.get("instruct", "")
            wavs, sr = await loop.run_in_executor(
                None,
                lambda: _tts_model.generate(
                    text=text,
                    language=language,
                    speaker=speaker,
                    instruct=instruct,
                ),
            )

        jobs.update(job_id, progress=0.9)

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        await loop.run_in_executor(
            None,
            lambda: sf.write(out_path, wavs[0], sr),
        )

        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path)

    except Exception as exc:
        log.exception("Qwen3-TTS inference failed")
        jobs.update(job_id, status="failed", error=str(exc))


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

    if REAL:
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _load_tts_model)
        except Exception as exc:
            log.exception("Failed to load TTS model")
            return {"status": "error", "error": str(exc)}

    _model_loaded = True
    return {"status": "loaded", "variant": MODEL_VARIANT}


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded, _tts_model
    _model_loaded = False
    _tts_model = None
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
