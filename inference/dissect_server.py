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
import io
import logging
import os
import shutil
import zipfile
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from _common import (
    JobStore, inference_lock, is_server_owned, new_job_id, remap_path,
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
            jobs.update(job_id, status="failed", error=f"{exc.__class__.__name__}: {exc}")
        finally:
            _cancel.discard(job_id)
            # A remote client's upload is a whole episode; don't let them pile up.
            if is_server_owned(input_path) and "uploads" in Path(input_path).parts:
                Path(input_path).unlink(missing_ok=True)


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


@app.get("/files/{job_id}")
async def download_bundle(job_id: str) -> StreamingResponse:
    """Zip of the job's import directory, for remote clients.

    The directory is deleted after the zip is built when it is server-owned
    scratch; in same-machine mode it IS the client's import dir and is kept.
    """
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    manifest = job.get("output_path")
    if job["status"] != "complete" or not manifest or not Path(manifest).is_file():
        raise HTTPException(status_code=404, detail="output not available")
    root = Path(manifest).parent

    def build() -> bytes:
        buf = io.BytesIO()
        # Stems are already PCM; deflate buys little and costs a lot of CPU.
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(root).as_posix())
        return buf.getvalue()

    data = await asyncio.to_thread(build)
    if is_server_owned(str(manifest)):
        shutil.rmtree(root, ignore_errors=True)
    return StreamingResponse(
        io.BytesIO(data), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="dissect-{job_id}.zip"'},
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


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
