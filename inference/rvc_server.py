"""
Pharaoh RVC Server — port 18006

Implements a two-stage voice pipeline on top of the Chatterbox TTS server:

  Stage 1 — Chatterbox corpus generation (handled by MCP build_corpus tool):
    Generate N WAV takes of a character's test line using the approved emotional
    palette as voice-clone references. Output goes to:
      characters/{id}/rvc_corpus/{emotion}_{i}.wav

  Stage 2 — RVC training + inference (this server):
    POST /train   — fine-tune an RVC v2 model on the Chatterbox corpus WAVs.
    POST /convert — run RVC voice conversion on any WAV (e.g. a TTS take).
    GET  /models  — list .pth files in a directory.

The net effect is a lightweight custom voice that retains the naturalness of
Chatterbox (paralinguistic tags, zero-shot expression) but consistently sounds
like a specific character rather than a reference clip.

Dependencies:
  pip install rvc-python soundfile librosa  (inference/.venv-rvc)

Training caveat:
  rvc-python exposes inference well but training support varies by version.
  If rvc_python.train is unavailable, _do_train() raises NotImplementedError
  with instructions for using the full Applio/RVC repository instead.
  Voice CONVERSION (POST /convert) always works and is the primary use-case
  during production — training is a one-time pre-production step.
"""
import asyncio
import datetime
import json
import logging
import os
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from _common import JobStore, new_job_id

log = logging.getLogger(__name__)

PORT = int(os.environ.get("PHARAOH_RVC_PORT", 18006))

app = FastAPI(title="Pharaoh RVC Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()

# Lazy-loaded RVCInference instance; guarded by _load_lock.
_model = None
_load_lock = asyncio.Lock()


# ── Sidecar helper ────────────────────────────────────────────────────────────

def _write_sidecar(audio_path: str, meta: dict) -> None:
    """Write a .meta.json sidecar next to the converted audio file."""
    sidecar = {
        "model":           meta.get("model", "rvc"),
        "model_variant":   meta.get("model_variant", "rvc-v2"),
        "parent":          meta.get("parent"),
        "rvc_model_path":  meta.get("rvc_model_path"),
        "pitch_shift":     meta.get("pitch_shift", 0),
        "index_rate":      meta.get("index_rate", 0.5),
        "f0_method":       meta.get("f0_method", "rmvpe"),
        "generated_at":    datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "qa_status":       "unreviewed",
    }
    try:
        Path(str(audio_path) + ".meta.json").write_text(json.dumps(sidecar, indent=2))
    except Exception as exc:
        log.warning(f"Failed to write sidecar for {audio_path}: {exc}")


# ── Device detection ──────────────────────────────────────────────────────────

def _detect_device() -> str:
    """Return 'cuda', 'mps', or 'cpu' depending on what PyTorch sees."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def _is_memory_error(exc: BaseException) -> bool:
    """True if exc looks like a GPU/CPU OOM error."""
    name = type(exc).__name__
    if name in ("OutOfMemoryError", "MemoryError"):
        return True
    msg = str(exc).lower()
    return any(s in msg for s in (
        "out of memory", "cuda oom", "mps backend out of memory",
        "cannot allocate", "memory allocation",
    ))


# ── Model management ──────────────────────────────────────────────────────────

def _do_load() -> None:
    """Blocking: create the RVCInference singleton. Called in an executor."""
    global _model
    from rvc_python.infer import RVCInference  # type: ignore
    device = _detect_device()
    log.info(f"Initialising RVCInference on device={device}")
    _model = RVCInference(device=device)
    log.info("RVCInference ready.")


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
                f"rvc-python not installed: {exc}. "
                f"Run: uv pip install rvc-python  (in inference/.venv-rvc)"
            )
        except Exception as exc:
            log.exception("RVC load failed")
            if _is_memory_error(exc):
                return f"OOM: Not enough memory to initialise RVC. Free a model first."
            return f"Load failed: {exc}"
    return None


# ── Pydantic request models ───────────────────────────────────────────────────

class TrainParams(BaseModel):
    job_id: Optional[str] = None
    corpus_paths: list[str]
    """Absolute paths to WAV files (Chatterbox output) that form the training corpus."""
    output_model_path: str
    """Absolute path where the trained .pth model file should be saved."""
    output_index_path: str
    """Absolute path where the trained .index FAISS file should be saved."""
    character_name: str = "voice"
    """Short name used for RVC internals (no spaces recommended)."""
    sample_rate: int = 48000
    """Target sample rate; RVC supports 40000 and 48000."""
    epochs: int = 100
    batch_size: int = 4


class ConvertParams(BaseModel):
    job_id: Optional[str] = None
    input_path: str
    """Absolute path to the source WAV (e.g. a Chatterbox TTS take)."""
    output_path: str
    """Absolute path where the RVC-converted WAV should be saved."""
    model_path: str
    """Absolute path to the .pth model file."""
    index_path: str = ""
    """Absolute path to the .index FAISS file (optional but recommended for quality)."""
    pitch_shift: int = 0
    """Semitone shift applied to pitch. Range: -12 to +12."""
    f0_method: str = "rmvpe"
    """Pitch extraction method: 'pm', 'harvest', 'crepe', or 'rmvpe' (best quality)."""
    index_rate: float = 0.5
    """0–1: strength of FAISS index retrieval. Higher = more like training corpus."""
    filter_radius: int = 3
    """0–7: median filter on pitch curve. Higher = smoother but slower."""
    rms_mix_rate: float = 0.25
    """0–1: blend of input vs output RMS envelope. 0 = use output envelope."""
    protect: float = 0.33
    """0–0.5: protect voiceless consonants from pitch shifting."""


# ── Blocking worker functions (run in executor) ───────────────────────────────

def _do_train(params: TrainParams) -> None:
    """
    Multi-step RVC training pipeline.

    NOTE: Full RVC training (feature extraction + VITS fine-tuning) requires
    a significant portion of the RVC/Applio codebase that rvc-python does not
    always expose as a clean Python API. If rvc_python.train is unavailable,
    this function raises NotImplementedError with instructions for using the
    full Applio repository.

    Steps when the API is available:
      1. Resample all corpus WAVs to target sample_rate using librosa.
      2. Run HuBERT feature extraction (bundled in rvc-python).
      3. Train the VITS model with rvc_python.train().
      4. Export .pth and .index files to the specified output paths.
    """
    import soundfile as sf  # type: ignore

    try:
        import librosa  # type: ignore
    except ImportError:
        raise ImportError("librosa is required for training. pip install librosa")

    # ── Step 1: Validate and optionally resample corpus files ────────────────
    valid_paths = []
    for p in params.corpus_paths:
        if not Path(p).is_file():
            log.warning(f"Corpus file not found, skipping: {p}")
            continue
        data, sr = sf.read(p)
        if sr != params.sample_rate:
            # Resample in-memory; write a temp file adjacent to source
            log.info(f"Resampling {p} from {sr}→{params.sample_rate}")
            import numpy as np  # type: ignore
            if data.ndim > 1:
                data = data.mean(axis=1)  # collapse to mono
            data_resampled = librosa.resample(data.astype(float), orig_sr=sr, target_sr=params.sample_rate)
            tmp_path = str(p) + f"._tmp_{params.sample_rate}.wav"
            sf.write(tmp_path, data_resampled, params.sample_rate)
            valid_paths.append(tmp_path)
        else:
            valid_paths.append(p)

    if not valid_paths:
        raise ValueError("No valid WAV files in corpus_paths")

    # ── Step 2: Attempt to call rvc_python training API ──────────────────────
    try:
        # rvc-python training API surface varies by version.
        # Try the most common entry points in order of preference.
        # NOTE: fairseq (a dep of rvc-python training) has a known dataclass
        # incompatibility with Python 3.10+. If it triggers, we raise a clear
        # NotImplementedError directing the user to Applio instead.
        try:
            from rvc_python import train as rvc_train  # type: ignore
        except Exception as import_err:
            if "mutable default" in str(import_err) or "default_factory" in str(import_err) or "fairseq" in str(import_err).lower():
                raise NotImplementedError(
                    f"rvc-python training is incompatible with Python {__import__('sys').version.split()[0]} "
                    f"due to a fairseq dataclass bug. Use Applio for one-time model training:\n"
                    f"  1. Install Applio: https://github.com/IAHispano/Applio\n"
                    f"  2. Add corpus from: {params.corpus_paths[0] if params.corpus_paths else 'rvc_corpus/'}\n"
                    f"  3. Train → export {params.character_name}.pth + .index\n"
                    f"  4. Place them in: {Path(params.output_model_path).parent}\n"
                    f"RVC conversion (POST /convert) is unaffected and works normally."
                ) from import_err
            raise
        rvc_train(
            audio_paths=valid_paths,
            model_name=params.character_name,
            save_path=params.output_model_path,
            index_path=params.output_index_path,
            sample_rate=params.sample_rate,
            epochs=params.epochs,
            batch_size=params.batch_size,
        )
        log.info(f"RVC training complete: {params.output_model_path}")
    except (ImportError, AttributeError) as exc:
        raise NotImplementedError(
            f"rvc-python does not expose a training API in this installation ({exc}). "
            f"To train an RVC model, use the full Applio repository:\n"
            f"  git clone https://github.com/IAHispano/Applio\n"
            f"  cd Applio && python run.py\n"
            f"Then copy the resulting .pth and .index files to:\n"
            f"  model:  {params.output_model_path}\n"
            f"  index:  {params.output_index_path}\n"
            f"Once those files exist, POST /convert will work normally."
        )


def _do_convert(params: ConvertParams) -> None:
    """
    Blocking RVC voice conversion using the loaded RVCInference singleton.
    Loads the requested model, converts the input file, writes the output.
    """
    global _model

    # Load the specific character model into the singleton
    _model.load_model(params.model_path, params.index_path or "")
    log.info(f"Loaded RVC model: {params.model_path}")

    Path(params.output_path).parent.mkdir(parents=True, exist_ok=True)

    _model.infer_file(
        params.input_path,
        params.output_path,
        f0method=params.f0_method,
        f0_up_key=params.pitch_shift,
        index_rate=params.index_rate,
        filter_radius=params.filter_radius,
        rms_mix_rate=params.rms_mix_rate,
        protect=params.protect,
    )
    log.info(f"RVC conversion done: {params.output_path}")


# ── Async background workers ──────────────────────────────────────────────────

async def _run_train(job_id: str, params: TrainParams) -> None:
    """Background task: run RVC training and update job store."""
    jobs.update(job_id, status="running", progress=0.05)

    loop = asyncio.get_running_loop()
    try:
        Path(params.output_model_path).parent.mkdir(parents=True, exist_ok=True)
        Path(params.output_index_path).parent.mkdir(parents=True, exist_ok=True)

        jobs.update(job_id, progress=0.10)
        await loop.run_in_executor(None, _do_train, params)

        # Verify outputs exist
        if not Path(params.output_model_path).exists():
            jobs.update(job_id, status="failed",
                        error=f"Training completed but .pth not found at {params.output_model_path}")
            return

        jobs.update(
            job_id,
            status="complete",
            progress=1.0,
            output_path=params.output_model_path,
        )
    except NotImplementedError as exc:
        jobs.update(job_id, status="failed", error=str(exc))
    except Exception as exc:
        log.exception("RVC training failed")
        jobs.update(job_id, status="failed", error=str(exc))


async def _run_convert(job_id: str, params: ConvertParams) -> None:
    """Background task: run RVC conversion and update job store."""
    jobs.update(job_id, status="running", progress=0.05)

    err = await _ensure_model()
    if err:
        jobs.update(job_id, status="failed", error=err)
        return

    jobs.update(job_id, progress=0.15)

    if not Path(params.input_path).is_file():
        jobs.update(job_id, status="failed",
                    error=f"input_path not found: {params.input_path}")
        return

    if params.model_path and not Path(params.model_path).is_file():
        jobs.update(job_id, status="failed",
                    error=f"model_path not found: {params.model_path}")
        return

    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, _do_convert, params)
        jobs.update(job_id, progress=0.90)

        _write_sidecar(params.output_path, {
            "model": "rvc",
            "model_variant": "rvc-v2",
            "parent": params.input_path,
            "rvc_model_path": params.model_path,
            "pitch_shift": params.pitch_shift,
            "index_rate": params.index_rate,
            "f0_method": params.f0_method,
        })
        jobs.update(job_id, status="complete", progress=1.0, output_path=params.output_path)

    except Exception as exc:
        log.exception("RVC conversion failed")
        if _is_memory_error(exc):
            jobs.update(job_id, status="failed", error=f"OOM: {exc}")
        else:
            jobs.update(job_id, status="failed", error=str(exc))


# ── Submit helpers ────────────────────────────────────────────────────────────

def _submit_train(params: TrainParams) -> dict:
    """Enqueue a training job and return immediately."""
    job_id = params.job_id or new_job_id()
    jobs.create(job_id, "rvc", "train", params.model_dump())
    asyncio.create_task(_run_train(job_id, params))
    return {"job_id": job_id, "status": "queued"}


def _submit_convert(params: ConvertParams) -> dict:
    """Enqueue a conversion job and return immediately."""
    job_id = params.job_id or new_job_id()
    jobs.create(job_id, "rvc", "convert", params.model_dump())
    asyncio.create_task(_run_convert(job_id, params))
    return {"job_id": job_id, "status": "queued"}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    """Return server and model-load status."""
    return {
        "status": "ok",
        "model_loaded": _model is not None,
        "model_variant": "rvc-v2",
        "vram_mb": 0,
        "stub": False,
        "device": _detect_device(),
    }


@app.post("/train")
async def train(p: TrainParams) -> dict:
    """
    Submit an RVC training job.

    Training is compute-heavy (10–20 min on GPU for 100 epochs).
    Returns a job_id immediately; poll GET /jobs/{job_id} for progress.

    If rvc-python does not expose a training API in this installation, the job
    will fail with a NotImplementedError describing the Applio fallback path.
    """
    if not p.corpus_paths:
        raise HTTPException(status_code=400, detail="corpus_paths must not be empty")
    if not p.output_model_path or not p.output_index_path:
        raise HTTPException(status_code=400, detail="output_model_path and output_index_path are required")
    return _submit_train(p)


@app.post("/convert")
async def convert(p: ConvertParams) -> dict:
    """
    Submit an RVC voice-conversion job.

    Converts a single WAV (typically a Chatterbox TTS take) using the specified
    .pth model. Returns a job_id immediately; poll GET /jobs/{job_id}.
    """
    if not p.input_path:
        raise HTTPException(status_code=400, detail="input_path is required")
    if not p.output_path:
        raise HTTPException(status_code=400, detail="output_path is required")
    if not p.model_path:
        raise HTTPException(status_code=400, detail="model_path is required")
    return _submit_convert(p)


@app.get("/models")
async def list_models(models_dir: str = Query(..., description="Directory to scan for .pth files")) -> dict:
    """
    List trained RVC models in a directory.

    Scans models_dir for .pth files and returns their paths and sizes.
    Also lists adjacent .index files when found.
    """
    d = Path(models_dir)
    if not d.is_dir():
        raise HTTPException(status_code=404, detail=f"models_dir not found: {models_dir}")
    models = []
    for pth in sorted(d.rglob("*.pth")):
        index_candidates = list(pth.parent.glob(pth.stem + "*.index"))
        models.append({
            "model_path": str(pth),
            "index_path": str(index_candidates[0]) if index_candidates else "",
            "size_bytes": pth.stat().st_size,
        })
    return {"models_dir": models_dir, "count": len(models), "models": models}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    """Poll a job for status, progress, output_path, and error."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.post("/load")
async def load() -> dict:
    """Eagerly load the RVCInference singleton (normally lazy-loaded on first convert)."""
    err = await _ensure_model()
    if err:
        return {"status": "error", "error": err}
    return {"status": "loaded"}


@app.post("/unload")
async def unload() -> dict:
    """Release the RVCInference singleton to free VRAM/RAM."""
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
