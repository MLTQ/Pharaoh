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
#
# Multiple variants can be held in memory simultaneously. Loading a new variant
# does not unload existing ones — if the OS runs out of memory the load will
# fail, and the server returns a structured error so the FE can prompt the user
# to free a slot via the model manager.
_tts_models: dict[str, "object"] = {}   # tts_model_type -> Qwen3TTSModel
_load_lock   = asyncio.Lock()           # serializes loads (concurrent loads of
                                        # multi-GB checkpoints would thrash)

OOM_MARKER = "TTS_OOM"  # error prefix the FE matches to show a memory toast


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
    """Load model from directory synchronously. Returns tts_model_type.
    Adds the model to _tts_models keyed by its detected type."""
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
    loaded_type = model.model.tts_model_type
    _tts_models[loaded_type] = model
    log.info(f"Qwen3-TTS loaded — type={loaded_type} (held: {sorted(_tts_models)})")
    return loaded_type


def _is_memory_error(exc: BaseException) -> bool:
    """Heuristic: detect OOM-style failures across CUDA/MPS/CPU paths."""
    name = type(exc).__name__
    if name in ("OutOfMemoryError", "MemoryError"):
        return True
    msg = str(exc).lower()
    return any(s in msg for s in (
        "out of memory", "cuda oom", "mps backend out of memory",
        "cannot allocate", "memory allocation",
    ))


async def _ensure_model(required_type: str) -> str | None:
    """
    Make sure the required model type is loaded. Adds it alongside any already-
    loaded variants — does not unload anything. On failure, returns an error
    string (prefixed with OOM_MARKER if memory-related) so the caller can
    surface it appropriately. Returns None on success.
    """
    if required_type in _tts_models:
        return None

    model_dir = _resolve_model_dir(required_type)
    if model_dir is None:
        return (
            f"No model directory found for '{required_type}'. "
            f"Place model weights in {TTS_MODEL_DIR}/{required_type}/ "
            f"or put a single model in {TTS_MODEL_DIR}/"
        )

    async with _load_lock:
        # Re-check inside lock — another coroutine may have loaded it by now
        if required_type in _tts_models:
            return None

        try:
            loop = asyncio.get_running_loop()
            loaded = await loop.run_in_executor(None, lambda: _do_load(model_dir))
        except Exception as exc:
            log.exception("TTS load failed")
            if _is_memory_error(exc):
                held = ", ".join(sorted(_tts_models)) or "none"
                return (
                    f"{OOM_MARKER}: Not enough memory to load '{required_type}'. "
                    f"Currently loaded: {held}. "
                    f"Open the Models page and unload one before retrying."
                )
            return f"Auto-load failed: {exc}"

        if loaded != required_type:
            # Flat-layout dir gave us the wrong type — drop it, don't keep stale state
            _tts_models.pop(loaded, None)
            return (
                f"Loaded model is type '{loaded}' but '{required_type}' is required. "
                f"Place the correct model weights in {TTS_MODEL_DIR}/{required_type}/"
            )
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
        log.info(f"Job {job_id}: need '{required_type}' model (held: {sorted(_tts_models)})")
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

        model = _tts_models[required_type]
        loop = asyncio.get_running_loop()

        if endpoint == "voice_design":
            wavs, sr = await loop.run_in_executor(
                None,
                lambda: model.generate_voice_design(
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
                lambda: model.generate_voice_clone(
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
                lambda: model.generate_custom_voice(
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
    held = sorted(_tts_models)
    variant_label = f"{MODEL_VARIANT} ({', '.join(held)})" if held else MODEL_VARIANT
    return {
        "status": "ok",
        "model_loaded": bool(_tts_models),
        "model_variant": variant_label,
        "loaded_types": held,
        "vram_mb": 6144 * len(_tts_models),
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


class UnloadRequest(BaseModel):
    type: str = ""  # specific type to unload, or "" for all


def _free_memory_after_unload() -> None:
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


@app.post("/load")
async def load(req: LoadRequest = LoadRequest()) -> dict:
    required_type = req.type or "custom_voice"
    err = await _ensure_model(required_type)
    if err:
        return {"status": "error", "error": err}
    return {"status": "loaded", "type": required_type, "loaded_types": sorted(_tts_models)}


@app.post("/unload")
async def unload(req: UnloadRequest = UnloadRequest()) -> dict:
    if req.type:
        _tts_models.pop(req.type, None)
    else:
        _tts_models.clear()
    _free_memory_after_unload()
    return {"status": "unloaded", "loaded_types": sorted(_tts_models)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
