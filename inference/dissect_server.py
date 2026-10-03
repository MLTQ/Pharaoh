"""
Pharaoh Dissect Server — port 18007

Takes an existing audio drama apart: dialogue / music / effects stems
(BandIt Plus, DnR), who-spoke-when (Nemotron-3-Diarization), cross-chunk
speaker linking (TitaNet), transcripts (Parakeet TDT 0.6B v3) and a shortlist
of clean solo reference clips per speaker. The pipeline itself lives in
`dissect_pipeline.py`; this module is the HTTP/job shell around it.

A job writes a self-contained import directory (manifest.json + stems/ +
candidates/). Local clients pass that directory as `output_path` and read it in
place. Remote clients send an empty `output_path` and fetch the directory as a
zip from GET /files/{job_id}.

Isolated venv: inference/.venv-dissect (Python 3.12, NeMo from source).
"""
import asyncio
import logging
import json
import os
import shutil
import sys
import threading
import time
import zipfile
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel

from _common import (
    SERVER_OUTPUT_DIR, JobStore, inference_lock, is_server_owned, new_job_id, remap_path,
    register_upload_route, server_output_path, spawn_job,
)
import dissect_pipeline as dp

log = logging.getLogger(__name__)

PORT = int(os.environ.get("PHARAOH_DISSECT_PORT", 18007))

app = FastAPI(title="Pharaoh Dissect Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
register_upload_route(app)
jobs = JobStore()
models = dp.Models()
# Job ids whose cancel was requested. Checked at every progress checkpoint
# (every separation batch, diarization chunk and transcription batch).
_cancel: set = set()

# ── Job persistence ───────────────────────────────────────────────────────────
#
# Finished jobs are recorded on disk so that a restart — including the
# self-restart after a CUDA fault, below — doesn't turn "failed: <reason>"
# into "server no longer knows this job" for the client polling it.
JOBS_FILE = SERVER_OUTPUT_DIR / "dissect-jobs.json"
_jobs_lock = threading.Lock()


def _persist(job_id: str) -> None:
    job = jobs.get(job_id)
    if job is None:
        return
    with _jobs_lock:
        try:
            data = json.loads(JOBS_FILE.read_text()) if JOBS_FILE.is_file() else {}
        except Exception:
            data = {}
        data[job_id] = {k: job.get(k) for k in ("status", "progress", "output_path", "error", "message")}
        data[job_id]["t"] = time.time()
        # Keep the newest 200.
        data = dict(sorted(data.items(), key=lambda kv: kv[1].get("t", 0))[-200:])
        JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = JOBS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(JOBS_FILE)


def _restore() -> None:
    """Reload finished jobs; anything that was still running died with the process."""
    try:
        data = json.loads(JOBS_FILE.read_text())
    except Exception:
        return
    for job_id, j in data.items():
        jobs.create(job_id, "dissect", "dissect", {})
        status = j.get("status")
        if status in ("running", "pending"):
            status, j["error"] = "failed", "Interrupted: the dissect server restarted while this job was running. Retry it."
        jobs.update(job_id, status=status, progress=j.get("progress", 0.0), output_path=j.get("output_path"),
                    error=j.get("error"), message=j.get("message"))


def _is_cuda_fault(exc: BaseException) -> bool:
    text = f"{exc.__class__.__name__}: {exc}"
    return "CUDA error" in text or "AcceleratorError" in text or "cudaError" in text


def _restart_soon(delay: float = 3.0) -> None:
    """Re-exec this server: after a CUDA fault the process's GPU context is
    poisoned and every later job would fail. The delay lets the client poll
    the failure first; queued jobs are recorded as interrupted."""
    def go():
        time.sleep(delay)
        for job_id, job in list(jobs._jobs.items()):
            if job.get("status") in ("running", "pending"):
                jobs.update(job_id, status="failed",
                            error="Interrupted: the dissect server restarted after a GPU fault. Retry it.")
                _persist(job_id)
        log.error("restarting dissect server after a CUDA fault")
        os.execv(sys.executable, [sys.executable] + sys.argv)
    threading.Thread(target=go, daemon=True).start()


class DissectParams(BaseModel):
    job_id: Optional[str] = None
    input_path: str
    # The import directory to write. Empty → server-owned scratch dir (remote mode).
    output_path: str = ""
    separate: bool = True
    transcribe: bool = True
    max_candidates: int = 6
    min_clip_s: float = 3.0
    max_clip_s: float = 15.0
    chunk_minutes: float = 20.0
    link_threshold: float = 0.6


def _model_dump(model: BaseModel) -> dict:
    return model.model_dump() if hasattr(model, "model_dump") else model.dict()


def _out_dir(job_id: str, output_path: str) -> Path:
    remapped = remap_path(output_path)
    if remapped:
        return Path(remapped)
    # server_output_path gives .../server-output/{job_id}/output.wav; use its dir.
    return Path(server_output_path(job_id)).parent


async def _run(job_id: str, p: DissectParams) -> None:
    input_path = remap_path(p.input_path) or p.input_path
    if not Path(input_path).is_file():
        jobs.update(job_id, status="failed", error=f"input audio not found: {input_path}")
        return
    out_dir = _out_dir(job_id, p.output_path)
    opts = dp.DissectOptions(
        separate=p.separate, transcribe=p.transcribe, max_candidates=max(1, p.max_candidates),
        min_clip_s=p.min_clip_s, max_clip_s=p.max_clip_s,
        chunk_minutes=p.chunk_minutes, link_threshold=p.link_threshold,
    )

    def progress(frac: float, message: str) -> None:
        if job_id in _cancel:
            raise dp.DissectCancelled()
        jobs.update(job_id, status="running", progress=round(frac, 3), message=message)

    jobs.update(job_id, message="Queued behind another job")
    async with inference_lock():
        try:
            if job_id in _cancel:  # cancelled while waiting for the GPU
                raise dp.DissectCancelled()
            # Checked again now: queued jobs can wait a long time behind others.
            if not Path(input_path).is_file():
                raise FileNotFoundError(f"input audio disappeared while queued: {input_path}")
            jobs.update(job_id, status="running", progress=0.0, message="Starting")
            await asyncio.to_thread(dp.run, models, input_path, out_dir, opts, progress)
            jobs.update(job_id, status="complete", progress=1.0, message="Done",
                        output_path=str(out_dir / "manifest.json"))
        except dp.DissectCancelled:
            jobs.update(job_id, status="cancelled", message="Cancelled")
            if is_server_owned(str(out_dir)):
                shutil.rmtree(out_dir, ignore_errors=True)
        except Exception as exc:
            log.exception("dissect failed")
            msg = f"{exc.__class__.__name__}: {exc}"
            if _is_cuda_fault(exc):
                msg = ("The GPU hit a fault (" + msg.splitlines()[0][:160] + "). The dissect server is "
                       "restarting itself to recover — Retry in a few seconds.")
                _restart_soon()
            jobs.update(job_id, status="failed", error=msg)
            # A failed job's partial stems are unusable; a 20 h book left 22 GB.
            if is_server_owned(str(out_dir)):
                shutil.rmtree(out_dir, ignore_errors=True)
        finally:
            _persist(job_id)
            _cancel.discard(job_id)
            # A remote client's upload is a whole episode; don't let them pile up.
            if is_server_owned(input_path) and "uploads" in Path(input_path).parts:
                Path(input_path).unlink(missing_ok=True)


class EmotionParams(BaseModel):
    job_id: Optional[str] = None
    # 16 kHz mono rendering of an import's dialogue stem (uploaded by remote clients).
    input_path: str
    # Manifest turn rows: speaker, start, end, text, overlap, words (optional).
    turns: list[dict]


async def _run_emotions(job_id: str, p: EmotionParams) -> None:
    import dissect_emotion as de

    input_path = remap_path(p.input_path) or p.input_path
    out = Path(server_output_path(job_id)).parent / "emotions.json"

    def progress(frac: float, message: str) -> None:
        if job_id in _cancel:
            raise dp.DissectCancelled()
        jobs.update(job_id, status="running", progress=round(frac, 3), message=message)

    jobs.update(job_id, message="Queued behind another job")
    async with inference_lock():
        try:
            if job_id in _cancel:
                raise dp.DissectCancelled()
            if not Path(input_path).is_file():
                raise FileNotFoundError(f"input audio not found: {input_path}")
            jobs.update(job_id, status="running", progress=0.0, message="Loading the emotion model")

            def work():
                models.emotion = models.emotion or de.EmotionTagger(models.device)
                return de.tag_file(models.emotion, input_path, p.turns, progress)

            res, vecs = await asyncio.to_thread(work)
            out.parent.mkdir(parents=True, exist_ok=True)
            (out.parent / de.VECS_FILE).write_bytes(vecs.astype("<f2").tobytes())
            out.write_text(json.dumps(res))
            jobs.update(job_id, status="complete", progress=1.0, message="Done", output_path=str(out))
        except dp.DissectCancelled:
            jobs.update(job_id, status="cancelled", message="Cancelled")
        except Exception as exc:
            log.exception("emotion tagging failed")
            msg = f"{exc.__class__.__name__}: {exc}"
            if _is_cuda_fault(exc):
                msg = ("The GPU hit a fault (" + msg.splitlines()[0][:160] + "). The dissect server is "
                       "restarting itself to recover — Retry in a few seconds.")
                _restart_soon()
            jobs.update(job_id, status="failed", error=msg)
        finally:
            _persist(job_id)
            _cancel.discard(job_id)
            if is_server_owned(input_path) and "uploads" in Path(input_path).parts:
                Path(input_path).unlink(missing_ok=True)


@app.post("/generate/emotions")
async def generate_emotions(p: EmotionParams) -> dict:
    """Tag an existing import's dialogue with emotions (imports dissected
    before emotion tagging existed). Fetch the result from /emotions/{job_id}."""
    job_id = p.job_id or new_job_id()
    jobs.create(job_id, "dissect", "emotions", {"input_path": p.input_path, "turns": len(p.turns)})
    spawn_job(_run_emotions(job_id, p))
    return {"job_id": job_id, "status": "queued"}


def _emotion_result(job_id: str) -> Path:
    job = jobs.get(job_id)
    if job is None or job.get("status") != "complete" or not job.get("output_path"):
        raise HTTPException(status_code=404, detail="no finished emotion result for this job")
    path = Path(job["output_path"])
    if not path.is_file():
        raise HTTPException(status_code=410, detail="result already collected")
    return path


@app.get("/emotions/{job_id}/vectors")
async def get_emotion_vectors(job_id: str) -> Response:
    """The utterance embeddings (N × 1024 float16, utterance order). Fetch
    these before /emotions/{job_id}, which collects and deletes the result."""
    import dissect_emotion as de

    vecs = _emotion_result(job_id).parent / de.VECS_FILE
    if not vecs.is_file():
        raise HTTPException(status_code=404, detail="no vectors for this job")
    return Response(content=vecs.read_bytes(), media_type="application/octet-stream")


@app.get("/emotions/{job_id}")
async def get_emotions(job_id: str):
    """The finished tagging result; deleted from the server once read."""
    path = _emotion_result(job_id)
    data = json.loads(path.read_text())
    if is_server_owned(str(path)):
        shutil.rmtree(path.parent, ignore_errors=True)
    return data


@app.get("/health")
async def health() -> dict:
    ml_ok, ml_reason = models.ml_available()
    sep_ok, sep_reason = models.separator_available()
    vram = 0
    if ml_ok:
        try:
            import torch
            if torch.cuda.is_available():
                vram = int(torch.cuda.memory_allocated() / 1e6)
        except Exception:
            pass
    return {
        "status": "ok",
        "model_loaded": bool(models.loaded()),
        "model_variant": "Nemotron-3-Diarization + BandIt Plus + Parakeet TDT v3",
        "vram_mb": vram,
        "stub": not ml_ok,
        "stub_reason": ml_reason,
        "separator_ready": sep_ok,
        "separator_error": sep_reason,
        "loaded": models.loaded(),
    }


@app.post("/generate/dissect")
async def generate_dissect(p: DissectParams) -> dict:
    if p.min_clip_s <= 0 or p.max_clip_s <= p.min_clip_s:
        raise HTTPException(status_code=400, detail="need 0 < min_clip_s < max_clip_s")
    job_id = p.job_id or new_job_id()
    jobs.create(job_id, "dissect", "dissect", _model_dump(p))
    spawn_job(_run(job_id, p))
    return {"job_id": job_id, "status": "queued"}


@app.post("/cancel/{job_id}")
async def cancel(job_id: str) -> dict:
    """Ask a queued or running dissect to stop at its next checkpoint."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] in ("complete", "failed", "cancelled"):
        return {"status": job["status"]}
    _cancel.add(job_id)
    jobs.update(job_id, message="Cancelling…")
    return {"status": "cancelling"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    if jobs.get(job_id) is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


class _Sink:
    """Write-only file object for zipfile that hands bytes to a generator."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.pos = 0

    def write(self, b) -> int:
        self.chunks.append(bytes(b))
        self.pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self.pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = b"".join(self.chunks)
        self.chunks.clear()
        return out


@app.get("/files/{job_id}")
async def download_bundle(job_id: str) -> StreamingResponse:
    """The job's import directory as a zip, streamed from disk (a long book's
    bundle is tens of GB — it was built in memory before).

    Server-owned scratch is deleted only after the last byte has been sent;
    an interrupted download leaves it in place so the client can try again.
    In same-machine mode the directory IS the client's import and is kept.
    """
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    manifest = job.get("output_path")
    if job["status"] != "complete" or not manifest or not Path(manifest).is_file():
        raise HTTPException(status_code=404, detail="output not available")
    root = Path(manifest).parent
    files = [p for p in sorted(root.rglob("*")) if p.is_file()]
    finished = {"ok": False}

    def stream():
        sink = _Sink()
        # Stems are FLAC/PCM; deflate buys little and costs a lot of CPU.
        with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            for path in files:
                info = zipfile.ZipInfo.from_file(path, path.relative_to(root).as_posix())
                with open(path, "rb") as src, zf.open(info, "w", force_zip64=True) as dst:
                    while True:
                        block = src.read(4 << 20)
                        if not block:
                            break
                        dst.write(block)
                        if sink.pos and sink.chunks:
                            yield sink.take()
                yield sink.take()
        tail = sink.take()
        if tail:
            yield tail
        finished["ok"] = True

    def cleanup():
        if finished["ok"] and is_server_owned(str(manifest)):
            shutil.rmtree(root, ignore_errors=True)

    return StreamingResponse(
        stream(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="dissect-{job_id}.zip"'},
        background=BackgroundTask(cleanup),
    )


@app.post("/load")
async def load() -> dict:
    ml_ok, reason = models.ml_available()
    if not ml_ok:
        return {"status": "stub", "error": reason}
    async with inference_lock():
        def _load():
            models.load_diarizer()
            models.load_embedder()
            models.load_asr()
            if models.separator_available()[0]:
                models.load_separator()
            try:
                from dissect_sounds import Tagger
                models.tagger = models.tagger or Tagger(models.device)
            except Exception:
                log.warning("sound tagger unavailable", exc_info=True)
        await asyncio.to_thread(_load)
    return {"status": "loaded", "loaded": models.loaded()}


@app.post("/unload")
async def unload() -> dict:
    async with inference_lock():
        models.unload()
    return {"status": "unloaded"}


_restore()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
