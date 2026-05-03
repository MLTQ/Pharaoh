"""
Pharaoh TTS Server — port 18001
Wraps Qwen3-TTS. Requires: pip install qwen-tts soundfile

Model directory layout (PHARAOH_TTS_MODEL_DIR, default ~/pharaoh-models/tts):
  Flat  : ~/pharaoh-models/tts/          — single model, used for any endpoint
  Typed : ~/pharaoh-models/tts/custom_voice/  — CustomVoice models
          ~/pharaoh-models/tts/voice_design/  — VoiceDesign models
          ~/pharaoh-models/tts/base/          — Base/clone models

When the typed layout is present, the server auto-loads the right model
for each endpoint without needing an explicit /load call.
"""
import asyncio
import logging
import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from _common import JobStore, new_job_id

log = logging.getLogger(__name__)

PORT           = int(os.environ.get("PHARAOH_TTS_PORT",    18001))
MODEL_VARIANT  = os.environ.get("PHARAOH_TTS_VARIANT",  "Qwen3-TTS")
TTS_MODEL_DIR  = Path(os.environ.get("PHARAOH_TTS_MODEL_DIR",       "~/pharaoh-models/tts")).expanduser()
TOKENIZER_DIR  = Path(os.environ.get("PHARAOH_TTS_TOKENIZER_DIR",   "~/pharaoh-models/tts/tokenizer")).expanduser()

app = FastAPI(title="Pharaoh TTS Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()

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

_LANG_LABEL = {
    "en": "English", "zh": "Chinese", "de": "German", "fr": "French",
    "ja": "Japanese", "ko": "Korean", "es": "Spanish", "pt": "Portuguese",
    "it": "Italian", "nl": "Dutch",
}

# Each endpoint requires a specific tts_model_type
_ENDPOINT_TYPE = {
    "custom_voice": "custom_voice",
    "voice_design":  "voice_design",
    "voice_clone":   "base",
}

# ── TTS model state ─────────────────────────────────────────────────────────

_tts_model    = None   # Qwen3TTSModel instance
_loaded_type  = None   # str: "custom_voice" | "voice_design" | "base"
_model_loaded = False
_load_lock    = asyncio.Lock()  # prevent concurrent loads


def _resolve_model_dir(required_type: str) -> Path | None:
    """
    Find the model directory for the requested type.
    Prefers typed subdirectory; falls back to flat TTS_MODEL_DIR.
    """
    subdir = TTS_MODEL_DIR / required_type
    if subdir.is_dir():
        return subdir
    if TTS_MODEL_DIR.is_dir():
        return TTS_MODEL_DIR  # flat layout — may be wrong type, will error on load
    return None


def _do_load(model_dir: Path) -> str:
    """Load model from directory synchronously. Returns tts_model_type."""
    global _tts_model, _loaded_type, _model_loaded
    import torch
    from qwen_tts.inference.qwen3_tts_model import Qwen3TTSModel

    device_map = (
        "mps"    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        else "cuda:0" if torch.cuda.is_available()
        else "cpu"
    )

    if not TOKENIZER_DIR.is_dir():
        raise FileNotFoundError(
            f"Shared speech-tokenizer directory not found. Download it once:\n"
            f"  hf download Qwen/Qwen3-TTS-Tokenizer-12Hz --local-dir {TOKENIZER_DIR}"
        )

    # speech_tokenizer/ — neural codec model, symlink from shared dir
    speech_tok_link = model_dir / "speech_tokenizer"
    if not speech_tok_link.exists():
        speech_tok_link.symlink_to(TOKENIZER_DIR.resolve())
        log.info(f"Linked {speech_tok_link} -> {TOKENIZER_DIR}")

    # Text tokenizer files — identical across all Qwen3-TTS variants. If a
    # variant's download is incomplete (e.g. VoiceDesign missing merges.txt),
    # fill in from TOKENIZER_DIR or any sibling variant dir that has it.
    text_tok_files = (
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.json",
        "merges.txt",
    )
    sibling_dirs = [p for p in TTS_MODEL_DIR.iterdir()
                    if p.is_dir() and p != model_dir and p.resolve() != TOKENIZER_DIR.resolve()] \
                   if TTS_MODEL_DIR.is_dir() else []

    for fname in text_tok_files:
        dst = model_dir / fname
        if dst.exists() or dst.is_symlink():
            continue
        candidates = [TOKENIZER_DIR / fname, *(s / fname for s in sibling_dirs)]
        src = next((c for c in candidates if c.is_file()), None)
        if src is not None:
            dst.symlink_to(src.resolve())
            log.info(f"Linked {dst} -> {src}")

    log.info(f"Loading Qwen3-TTS from {model_dir} on {device_map}")
    model = Qwen3TTSModel.from_pretrained(
        str(model_dir),
        device_map=device_map,
        torch_dtype=torch.bfloat16,
    )
    _tts_model    = model
    _loaded_type  = model.model.tts_model_type
    _model_loaded = True
    log.info(f"Qwen3-TTS loaded — type={_loaded_type}")
    return _loaded_type


async def _ensure_model(required_type: str) -> str | None:
    """
    Make sure the right model type is loaded.
    Returns an error string if it can't be loaded, else None.
    """
    global _tts_model, _loaded_type, _model_loaded

    # Already correct
    if _tts_model is not None and _loaded_type == required_type:
        return None

    # Wrong type loaded — fail immediately rather than blocking for a multi-minute reload
    if _tts_model is not None and _loaded_type != required_type:
        return (
            f"Wrong model loaded: '{_loaded_type}' is active but '{required_type}' is "
            f"required for this endpoint. Go to Models, unload it, then load the correct checkpoint. "
            f"Or place the '{required_type}' weights in {TTS_MODEL_DIR}/{required_type}/"
        )

    # No model loaded yet — attempt auto-load under lock
    async with _load_lock:
        # Re-check inside lock (another task may have loaded by now)
        if _tts_model is not None and _loaded_type == required_type:
            return None
        if _tts_model is not None:
            return (
                f"Wrong model loaded: '{_loaded_type}' is active but '{required_type}' is required."
            )

        model_dir = _resolve_model_dir(required_type)
        if model_dir is None:
            return (
                f"No model directory found for '{required_type}'. "
                f"Place model weights in {TTS_MODEL_DIR}/{required_type}/ "
                f"or put a single model in {TTS_MODEL_DIR}/"
            )
        try:
            loop = asyncio.get_running_loop()
            loaded = await loop.run_in_executor(None, lambda: _do_load(model_dir))
            if loaded != required_type:
                # Loaded wrong type from flat dir — clear so server state stays clean
                _tts_model = None
                _loaded_type = None
                _model_loaded = False
                return (
                    f"Loaded model is type '{loaded}' but '{required_type}' is required. "
                    f"Place the correct model weights in {TTS_MODEL_DIR}/{required_type}/"
                )
        except Exception as exc:
            log.exception("Auto-load failed")
            return f"Auto-load failed: {exc}"
    return None


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

async def _run_tts(job_id: str, params: dict) -> None:
    endpoint      = params.get("_endpoint", "custom_voice")
    required_type = _ENDPOINT_TYPE.get(endpoint, "custom_voice")

    jobs.update(job_id, status="running", progress=0.02)

    try:
        # Auto-load correct model if needed
        log.info(f"Job {job_id}: need '{required_type}' model (loaded: {_loaded_type!r})")
        err = await _ensure_model(required_type)
        if err:
            log.warning(f"Job {job_id} failed: {err}")
            jobs.update(job_id, status="failed", error=err)
            return

        jobs.update(job_id, progress=0.15)
        import soundfile as sf
        import torch

        out_path = params["output_path"]
        language = _LANG_LABEL.get(params.get("language", "en"), "English")
        seed     = int(params.get("seed", 0))

        if seed:
            torch.manual_seed(seed)

        loop = asyncio.get_running_loop()

        if endpoint == "voice_design":
            wavs, sr = await loop.run_in_executor(
                None,
                lambda: _tts_model.generate_voice_design(
                    text=params["text"],
                    instruct=params.get("voice_description", ""),
                    language=language,
                    temperature=params.get("temperature", 0.7),
                    top_p=params.get("top_p", 0.9),
                    max_new_tokens=params.get("max_new_tokens", 2048),
                ),
            )
        elif endpoint == "voice_clone":
            wavs, sr = await loop.run_in_executor(
                None,
                lambda: _tts_model.generate_voice_clone(
                    text=params["text"],
                    language=language,
                    ref_audio=params.get("ref_audio_path", ""),
                    ref_text=params.get("ref_transcript") or None,
                    x_vector_only_mode=not params.get("icl_mode", False),
                    temperature=params.get("temperature", 0.7),
                    top_p=params.get("top_p", 0.9),
                ),
            )
        else:
            wavs, sr = await loop.run_in_executor(
                None,
                lambda: _tts_model.generate_custom_voice(
                    text=params["text"],
                    speaker=params.get("speaker", "Vivian"),
                    language=language,
                    instruct=params.get("instruct") or None,
                    temperature=params.get("temperature", 0.7),
                    top_p=params.get("top_p", 0.9),
                    max_new_tokens=params.get("max_new_tokens", 2048),
                ),
            )

        jobs.update(job_id, progress=0.9)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        await loop.run_in_executor(None, lambda: sf.write(out_path, wavs[0], sr))
        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path)

    except Exception as exc:
        log.exception("Qwen3-TTS inference failed")
        jobs.update(job_id, status="failed", error=str(exc))


def _submit(params: dict) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "tts", params.get("_endpoint", "custom_voice"), params)
    asyncio.create_task(_run_tts(job_id, params))
    return {"job_id": job_id}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": _model_loaded,
        "model_variant": f"{MODEL_VARIANT} ({_loaded_type})" if _loaded_type else MODEL_VARIANT,
        "vram_mb": 6144 if _model_loaded else 0,
        "stub": False,
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
    type: str = ""  # "custom_voice" | "voice_design" | "base" | "" (auto-detect)


@app.post("/load")
async def load(req: LoadRequest = LoadRequest()) -> dict:
    required_type = req.type or "custom_voice"
    err = await _ensure_model(required_type)
    if err:
        return {"status": "error", "error": err}
    return {"status": "loaded", "type": _loaded_type}


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded, _tts_model, _loaded_type
    _model_loaded = False
    _tts_model    = None
    _loaded_type  = None
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
