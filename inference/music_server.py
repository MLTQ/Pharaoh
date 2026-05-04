"""
Pharaoh Music Server — port 18003
Wraps ACE-Step 1.5 (ACEStepPipeline).

Model directory: PHARAOH_MUSIC_MODEL_DIR (default ~/pharaoh-models/music)
The directory must contain ace_step_transformer/, music_dcae_f8c8/,
music_vocoder/, umt5-base/ subfolders (downloaded from HuggingFace
ACE-Step/ACE-Step-v1-3.5B).

Install (the PyPI sdist is broken, so install from git):
  conda activate pharoah
  pip install git+https://github.com/ace-step/ACE-Step.git
  pip install torchcodec   # ACE-Step deps don't pull this in but newer
                            # torchaudio.save() dispatches through it
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

PORT            = int(os.environ.get("PHARAOH_MUSIC_PORT",    18003))
MODEL_VARIANT   = os.environ.get("PHARAOH_MUSIC_VARIANT",  "ACE-Step-v1-3.5B")
MUSIC_MODEL_DIR = Path(os.environ.get("PHARAOH_MUSIC_MODEL_DIR", "~/pharaoh-models/music")).expanduser()

app = FastAPI(title="Pharaoh Music Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()

STEMS = ["vocals", "backing_vocals", "drums", "bass", "guitar", "keyboard",
         "percussion", "strings", "synth", "fx", "brass", "woodwinds"]

_pipeline   = None         # ACEStepPipeline instance
_load_lock  = asyncio.Lock()
OOM_MARKER  = "MUSIC_OOM"  # FE matches this prefix to surface a memory toast

REQUIRED_DIRS = ["ace_step_transformer", "music_dcae_f8c8", "music_vocoder", "umt5-base"]


def _model_dir_status() -> dict:
    if not MUSIC_MODEL_DIR.is_dir():
        return {"ok": False, "reason": f"PHARAOH_MUSIC_MODEL_DIR not found: {MUSIC_MODEL_DIR}"}
    missing = [d for d in REQUIRED_DIRS if not (MUSIC_MODEL_DIR / d).is_dir()]
    if missing:
        return {"ok": False, "reason": (
            f"Missing checkpoint subdirs in {MUSIC_MODEL_DIR}: {', '.join(missing)}. "
            f"Download with: hf download ACE-Step/ACE-Step-v1-3.5B --local-dir {MUSIC_MODEL_DIR}"
        )}
    return {"ok": True, "reason": ""}


def _is_memory_error(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in ("OutOfMemoryError", "MemoryError"):
        return True
    msg = str(exc).lower()
    return any(s in msg for s in (
        "out of memory", "cuda oom", "mps backend out of memory",
        "cannot allocate", "memory allocation",
    ))


def _do_load() -> None:
    """Construct the pipeline and eagerly load weights so /generate responses are fast."""
    global _pipeline
    from acestep.pipeline_ace_step import ACEStepPipeline

    log.info(f"Loading ACE-Step from {MUSIC_MODEL_DIR}")
    pipe = ACEStepPipeline(
        checkpoint_dir=str(MUSIC_MODEL_DIR),
        dtype="bfloat16",
    )
    # Construction is lazy — force the weight load now so we surface errors here
    # instead of from a worker thread mid-generation.
    pipe.load_checkpoint(str(MUSIC_MODEL_DIR))
    _pipeline = pipe
    log.info("ACE-Step loaded.")


async def _ensure_model() -> str | None:
    """Make sure the pipeline is loaded. Returns an error string on failure
    (prefixed with OOM_MARKER for memory-related failures), else None."""
    if _pipeline is not None:
        return None

    status = _model_dir_status()
    if not status["ok"]:
        return status["reason"]

    async with _load_lock:
        if _pipeline is not None:
            return None
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _do_load)
        except ImportError as exc:
            return (
                f"acestep package not installed: {exc}. "
                f"Run: pip install git+https://github.com/ace-step/ACE-Step.git "
                f"(the PyPI sdist build is broken)."
            )
        except Exception as exc:
            log.exception("ACE-Step auto-load failed")
            if _is_memory_error(exc):
                return f"{OOM_MARKER}: Not enough memory to load ACE-Step. Free a model in the model manager and retry."
            return f"Auto-load failed: {exc}"
    return None


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


# ── Background worker ────────────────────────────────────────────────────────

async def _run_music(job_id: str, params: dict) -> None:
    jobs.update(job_id, status="running", progress=0.02)

    err = await _ensure_model()
    if err:
        log.warning(f"Job {job_id} failed: {err}")
        jobs.update(job_id, status="failed", error=err)
        return

    jobs.update(job_id, progress=0.05)
    try:
        endpoint = params.get("_endpoint", "text2music")
        out_path = params["output_path"]
        seed     = int(params.get("seed", 0)) or None
        steps    = int(params.get("diffusion_steps", 60))
        duration = float(params.get("duration_seconds", 30.0))

        # ACEStepPipeline writes the audio to save_path itself, so we just need
        # to make sure the parent dir exists and pass the .wav path through.
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)

        loop = asyncio.get_running_loop()
        jobs.update(job_id, progress=0.10)

        manual_seeds = [seed] if seed else None
        common_kwargs = dict(
            format="wav",
            audio_duration=duration,
            infer_step=steps,
            manual_seeds=manual_seeds,
            save_path=out_path,
            batch_size=int(params.get("batch_size", 1)),
        )

        # ACEStepPipeline.__call__ does `len(lyrics) > 0` etc. without None-checks,
        # so empty-string is required for unset text fields, not None.
        if endpoint == "text2music":
            caption = params.get("caption", "") or ""
            lyrics  = params.get("lyrics",  "") or ""
            ref     = params.get("reference_audio_path", "") or ""
            await loop.run_in_executor(
                None,
                lambda: _pipeline(
                    task="text2music",
                    prompt=caption,
                    lyrics=lyrics,
                    audio2audio_enable=bool(ref),
                    ref_audio_input=ref,
                    ref_audio_strength=0.5,
                    **common_kwargs,
                ),
            )
        elif endpoint == "cover":
            await loop.run_in_executor(
                None,
                lambda: _pipeline(
                    task="audio2audio",
                    prompt=params.get("caption", "") or "",
                    lyrics="",
                    audio2audio_enable=True,
                    ref_audio_input=params["source_audio_path"],
                    ref_audio_strength=float(params.get("cover_strength", 0.5)),
                    **common_kwargs,
                ),
            )
        elif endpoint == "repaint":
            await loop.run_in_executor(
                None,
                lambda: _pipeline(
                    task="repaint",
                    prompt=params.get("caption", "") or "",
                    lyrics="",
                    src_audio_path=params["source_audio_path"],
                    repaint_start=int(params.get("start_ms", 0)),
                    repaint_end=int(params.get("end_ms", 10000)),
                    **common_kwargs,
                ),
            )
        else:
            raise ValueError(f"Unsupported music endpoint: {endpoint}")

        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path)

    except Exception as exc:
        log.exception("ACE-Step inference failed")
        if _is_memory_error(exc):
            jobs.update(job_id, status="failed", error=f"{OOM_MARKER}: {exc}")
        else:
            jobs.update(job_id, status="failed", error=str(exc))


def _submit(params: dict, endpoint: str) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "music", endpoint, params)
    asyncio.create_task(_run_music(job_id, params))
    return {"job_id": job_id}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    status = _model_dir_status()
    return {
        "status": "ok",
        "model_loaded": _pipeline is not None,
        "model_variant": MODEL_VARIANT,
        "vram_mb": 8192 if _pipeline is not None else 0,
        "stub": False,
        "model_dir": str(MUSIC_MODEL_DIR),
        "model_dir_ready": status["ok"],
        "model_dir_error": status["reason"],
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
    global _pipeline
    _pipeline = None
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
