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
  inference/.venv-rvc    — rvc-python, soundfile, librosa (Python 3.9; conversion)
  inference/.venv-applio — Applio + torch (Python 3.11; training)

Training:
  POST /train calls applio_train_worker.py in .venv-applio, which drives
  Applio's preprocess → feature-extract → VITS-train pipeline automatically.
  Set up with: PHARAOH_INSTALL_APPLIO=1 ./inference/setup.sh

  Voice CONVERSION (POST /convert) uses rvc-python directly and works
  independently of Applio — training is a one-time pre-production step.
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

from _common import JobStore, new_job_id, remap_path

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

def _do_train(params: TrainParams, job_id: str = "") -> None:
    """
    Multi-step RVC training pipeline via Applio.

    Calls applio_train_worker.py in the .venv-applio Python environment.
    Applio handles HuBERT feature extraction, preprocessing, and VITS training.

    Requires: PHARAOH_INSTALL_APPLIO=1 ./inference/setup.sh (one-time).

    Flow:
      1. Validate corpus WAV files.
      2. Copy corpus to Applio's dataset directory for this model.
      3. Call applio_train_worker.py via subprocess (Applio venv Python).
      4. Move output .pth and .index to the requested output_model_path / output_index_path.
    """
    import json
    import shutil
    import subprocess
    import tempfile

    import soundfile as sf  # type: ignore

    # ── Locate Applio ─────────────────────────────────────────────────────────
    script_dir = Path(__file__).parent
    applio_dir  = Path(os.environ.get("PHARAOH_APPLIO_DIR",  str(script_dir / ".applio")))
    applio_venv = Path(os.environ.get("PHARAOH_APPLIO_VENV", str(script_dir / ".venv-applio")))
    applio_python = applio_venv / "bin" / "python3"
    worker_script = script_dir / "applio_train_worker.py"

    if not applio_dir.is_dir() or not applio_python.is_file():
        missing = []
        if not applio_dir.is_dir():
            missing.append(f"Applio repo not found at {applio_dir}")
        if not applio_python.is_file():
            missing.append(f"Applio venv not found at {applio_venv}")
        raise NotImplementedError(
            "Applio is not installed. Run once to set up:\n"
            "  PHARAOH_INSTALL_APPLIO=1 ./inference/setup.sh\n\n"
            + "\n".join(missing) + "\n\n"
            f"RVC conversion (POST /convert) works without Applio."
        )

    if not worker_script.is_file():
        raise FileNotFoundError(f"applio_train_worker.py not found at {worker_script}")

    # ── Validate corpus files ──────────────────────────────────────────────────
    valid_paths = []
    for p in params.corpus_paths:
        if not Path(p).is_file():
            log.warning(f"Corpus file not found, skipping: {p}")
            continue
        valid_paths.append(p)

    if not valid_paths:
        raise ValueError("No valid WAV files in corpus_paths")

    log.info(f"Training corpus: {len(valid_paths)} files")

    # ── Copy corpus to Applio dataset dir ────────────────────────────────────
    # Applio expects all training audio in one flat directory under
    # assets/datasets/{model_name}/ (relative to the Applio repo root).
    model_name  = params.character_name.replace(" ", "_")
    dataset_dir = applio_dir / "assets" / "datasets" / model_name
    dataset_dir.mkdir(parents=True, exist_ok=True)

    for p in valid_paths:
        dst = dataset_dir / Path(p).name
        if not dst.exists():
            shutil.copy2(p, dst)

    log.info(f"Corpus staged at: {dataset_dir}  ({len(valid_paths)} files)")

    # ── Write params JSON and invoke worker ───────────────────────────────────
    worker_params = {
        "applio_dir":   str(applio_dir),
        "dataset_path": str(dataset_dir),
        "model_name":   model_name,
        "sample_rate":  params.sample_rate,
        "epochs":       params.epochs,
        "batch_size":   params.batch_size,
        "f0_method":    "rmvpe",
        "gpu":          "0",
    }

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(worker_params, f)
        params_file = f.name

    def _progress(prog: float, msg: str) -> None:
        """Update job store from the executor thread (GIL-safe for CPython dicts)."""
        if job_id:
            jobs.update(job_id, progress=prog, message=msg)

    import re
    _EPOCH_RE = re.compile(r"(\d+)/(\d+)\s*\[")

    try:
        log.info("Launching Applio training worker …")
        _progress(0.02, "Starting Applio…")

        proc = subprocess.Popen(
            [str(applio_python), str(worker_script), params_file],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,              # line-buffered
            cwd=str(applio_dir),
        )

        in_training = False
        total_epochs = params.epochs

        for raw in iter(proc.stdout.readline, ""):
            line = raw.rstrip()
            if not line:
                continue

            # Mirror to server stdout so logs stay readable
            print(line, flush=True)

            # ── Structured progress from worker ──────────────────────────────
            if line.startswith("PROGRESS:"):
                parts = line.split(":", 2)
                if len(parts) == 3:
                    try:
                        _progress(float(parts[1]), parts[2])
                    except ValueError:
                        pass
                if "Training" in line:
                    in_training = True
                continue

            # ── Epoch/step progress during VITS training ──────────────────────
            if in_training:
                m = _EPOCH_RE.search(line)
                if m:
                    cur, tot = int(m.group(1)), int(m.group(2))
                    if tot > 0 and cur <= tot:
                        frac = cur / tot
                        prog = 0.47 + frac * 0.47
                        _progress(prog, f"Training… {cur}/{tot} steps")

        proc.stdout.close()
        ret = proc.wait(timeout=60)
        if ret != 0:
            raise RuntimeError(
                f"Applio training worker exited with code {ret}. "
                f"Check rvc_server stdout for details."
            )
    finally:
        Path(params_file).unlink(missing_ok=True)

    # ── Locate and move output files ──────────────────────────────────────────
    logs_dir = applio_dir / "logs" / model_name
    pth_files = sorted(
        logs_dir.glob("*.pth"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    index_files = sorted(
        logs_dir.glob("added_*.index"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    ) or sorted(
        logs_dir.glob("*.index"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )

    if not pth_files:
        raise RuntimeError(
            f"Training completed but no .pth found in {logs_dir}. "
            f"Check Applio logs for errors."
        )

    # Copy (not move) so Applio's own logs dir stays intact for re-training.
    out_pth = Path(params.output_model_path)
    out_pth.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pth_files[0], out_pth)
    log.info(f"Model saved: {out_pth}")

    if index_files and params.output_index_path:
        out_idx = Path(params.output_index_path)
        out_idx.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(index_files[0], out_idx)
        log.info(f"Index saved: {out_idx}")


def _do_convert(params: ConvertParams) -> None:
    """
    Blocking RVC voice conversion via applio_infer_worker.py.

    Routes through Applio's run_infer_script (using .venv-applio) so that the
    same contentvec/768-dim architecture used during training is used at
    inference time.  This avoids the rvc-python v1/v2 mismatch
    (SynthesizerTrnMs256NSFsid vs SynthesizerTrnMs768NSFsid).
    """
    import json
    import subprocess
    import tempfile

    script_dir    = Path(__file__).parent
    applio_dir    = Path(os.environ.get("PHARAOH_APPLIO_DIR",  str(script_dir / ".applio")))
    applio_venv   = Path(os.environ.get("PHARAOH_APPLIO_VENV", str(script_dir / ".venv-applio")))
    applio_python = applio_venv / "bin" / "python3"
    worker_script = script_dir / "applio_infer_worker.py"

    if not applio_python.is_file():
        raise RuntimeError(
            f"Applio venv not found at {applio_venv}. "
            "Run: PHARAOH_INSTALL_APPLIO=1 ./inference/setup.sh"
        )
    if not worker_script.is_file():
        raise FileNotFoundError(f"applio_infer_worker.py not found at {worker_script}")

    Path(params.output_path).parent.mkdir(parents=True, exist_ok=True)

    worker_params = {
        "applio_dir":    str(applio_dir),
        "input_path":    params.input_path,
        "output_path":   params.output_path,
        "pth_path":      params.model_path,
        "index_path":    params.index_path or "",
        "pitch_shift":   params.pitch_shift,
        "index_rate":    params.index_rate,
        "f0_method":     params.f0_method,
        "filter_radius": params.filter_radius,
        "rms_mix_rate":  params.rms_mix_rate,
        "protect":       params.protect,
    }

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(worker_params, f)
        params_file = f.name

    try:
        log.info(f"Launching Applio inference worker for {params.input_path}")
        result = subprocess.run(
            [str(applio_python), str(worker_script), params_file],
            capture_output=True,
            text=True,
            cwd=str(applio_dir),
        )
        # Mirror worker output to server log
        if result.stdout:
            for line in result.stdout.splitlines():
                log.info(f"[applio-infer] {line}")
        if result.stderr:
            for line in result.stderr.splitlines():
                log.warning(f"[applio-infer] {line}")

        if result.returncode != 0:
            raise RuntimeError(
                f"applio_infer_worker exited {result.returncode}. "
                f"stderr: {result.stderr[-2000:]}"
            )
    finally:
        Path(params_file).unlink(missing_ok=True)

    if not Path(params.output_path).is_file():
        raise RuntimeError(f"Conversion completed but output not found: {params.output_path}")

    log.info(f"RVC conversion done: {params.output_path}")


# ── Async background workers ──────────────────────────────────────────────────

async def _run_train(job_id: str, params: TrainParams) -> None:
    """Background task: run RVC training and update job store."""
    jobs.update(job_id, status="running", progress=0.05)
    # Remap client-side absolute paths to the server's local projects dir.
    params = params.model_copy(update={
        "corpus_paths":      [remap_path(p) for p in params.corpus_paths],
        "output_model_path": remap_path(params.output_model_path),
        "output_index_path": remap_path(params.output_index_path),
    })

    loop = asyncio.get_running_loop()
    try:
        Path(params.output_model_path).parent.mkdir(parents=True, exist_ok=True)
        Path(params.output_index_path).parent.mkdir(parents=True, exist_ok=True)

        jobs.update(job_id, progress=0.10)
        import functools
        await loop.run_in_executor(None, functools.partial(_do_train, params, job_id))

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
    # Remap client-side absolute paths to the server's local projects dir.
    params = params.model_copy(update={
        "input_path":  remap_path(params.input_path),
        "output_path": remap_path(params.output_path),
    })
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
        "model_loaded": True,   # conversion now uses applio_infer_worker (no singleton)
        "model_variant": "rvc-v2",
        "vram_mb": 0,
        "stub": False,
        "device": _detect_device(),
    }


@app.post("/train")
async def train(p: TrainParams) -> dict:
    """
    Submit an RVC training job (runs via Applio in .venv-applio).

    Training is compute-heavy: ~10–30 min on Apple Silicon MPS, ~5–10 min on
    a CUDA GPU, for 100 epochs on a typical corpus.
    Returns a job_id immediately; poll GET /jobs/{job_id} for progress.

    Requires: PHARAOH_INSTALL_APPLIO=1 ./inference/setup.sh (one-time setup).
    If Applio is not installed the job will fail immediately with setup instructions.
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
