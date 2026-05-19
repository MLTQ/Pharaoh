"""
Pharaoh Post Server - port 18004.

Owns neural post-processing work that must run on the ML host. The first
endpoint wraps AudioSR for 48 kHz audio super-resolution.
"""
import asyncio
import datetime
import json
import logging
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel

from _common import JobStore, new_job_id, remap_path, register_upload_route, server_output_path

log = logging.getLogger(__name__)


def _write_sidecar(audio_path: str, meta: dict) -> None:
    """Write a .meta.json sidecar next to the generated audio file."""
    sidecar = {
        "model":              meta.get("model", ""),
        "model_variant":      meta.get("model_variant", ""),
        "prompt":             meta.get("prompt", ""),
        "instruct":           None,
        "speaker":            None,
        "language":           None,
        "seed":               meta.get("seed", 0),
        "temperature":        None,
        "top_p":              None,
        "duration_target_ms": meta.get("duration_target_ms"),
        "duration_actual_ms": meta.get("duration_actual_ms"),
        "sample_rate":        meta.get("sample_rate"),
        "generated_at":       datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "parent":             meta.get("parent"),
        "take_index":         1,
        "qa_status":          "unreviewed",
        "qa_notes":           "",
    }
    try:
        Path(str(audio_path) + ".meta.json").write_text(json.dumps(sidecar, indent=2))
    except Exception as exc:
        log.warning(f"Failed to write sidecar for {audio_path}: {exc}")

PORT = int(os.environ.get("PHARAOH_POST_PORT", 18004))
AUDIOSR_CLI = Path(
    os.environ.get("PHARAOH_AUDIOSR_CLI", Path(sys.executable).parent / "audiosr")
).expanduser()

app = FastAPI(title="Pharaoh Post Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
register_upload_route(app)
jobs = JobStore()


class UpscaleParams(BaseModel):
    job_id: Optional[str] = None
    input_path: str
    output_path: str
    model_name: str = "basic"
    ddim_steps: int = 50
    guidance_scale: float = 3.5
    seed: int = 0


def _audiosr_status() -> dict:
    if not AUDIOSR_CLI.is_file():
        return {
            "ok": False,
            "reason": (
                f"AudioSR CLI not found at {AUDIOSR_CLI}. "
                "Run: PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh"
            ),
        }
    return {"ok": True, "reason": ""}


def _model_dump(model: BaseModel) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _newest_wav(root: Path) -> Optional[Path]:
    newest: Optional[tuple[float, Path]] = None
    for path in root.rglob("*.wav"):
        mtime = path.stat().st_mtime
        if newest is None or mtime > newest[0]:
            newest = (mtime, path)
    return newest[1] if newest else None


def _extract_last_percent(text: str) -> Optional[float]:
    found = None
    for match in re.finditer(r"(\d{1,3})%", text):
        found = min(1.0, max(0.0, int(match.group(1)) / 100.0))
    return found


async def _read_stream(stream: asyncio.StreamReader, job_id: str, chunks: list[str]) -> None:
    max_progress = 0.1
    while True:
        chunk = await stream.read(1024)
        if not chunk:
            return
        text = chunk.decode("utf-8", errors="replace")
        chunks.append(text)
        percent = _extract_last_percent(text)
        if percent is not None:
            progress = 0.1 + percent * 0.8
            if progress > max_progress:
                max_progress = progress
                jobs.update(job_id, status="running", progress=progress)


async def _run_upscale(job_id: str, params: UpscaleParams) -> None:
    status = _audiosr_status()
    if not status["ok"]:
        jobs.update(job_id, status="failed", error=status["reason"])
        return

    input_path = Path(params.input_path)
    resolved_output = remap_path(params.output_path) or server_output_path(job_id)
    output_path = Path(resolved_output)
    if not input_path.is_file():
        jobs.update(job_id, status="failed", error=f"input audio not found: {input_path}")
        return

    output_path.parent.mkdir(parents=True, exist_ok=True)
    jobs.update(job_id, status="running", progress=0.03)
    tmp = Path(tempfile.mkdtemp(prefix="pharaoh-audiosr-"))
    chunks: list[str] = []

    try:
        proc = await asyncio.create_subprocess_exec(
            str(AUDIOSR_CLI),
            "-i",
            str(input_path),
            "-s",
            str(tmp),
            "--model_name",
            params.model_name,
            "--ddim_steps",
            str(params.ddim_steps),
            "-gs",
            str(params.guidance_scale),
            "--seed",
            str(params.seed),
            "--suffix",
            "pharaoh",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        jobs.update(job_id, progress=0.08)
        assert proc.stdout is not None
        assert proc.stderr is not None
        await asyncio.gather(
            _read_stream(proc.stdout, job_id, chunks),
            _read_stream(proc.stderr, job_id, chunks),
        )
        returncode = await proc.wait()
        if returncode != 0:
            msg = "".join(chunks)[-4000:] or f"AudioSR exited with {returncode}"
            jobs.update(job_id, status="failed", error=f"AudioSR failed:\n{msg}")
            return

        generated = _newest_wav(tmp)
        if generated is None:
            jobs.update(job_id, status="failed", error="AudioSR completed without producing a WAV")
            return

        jobs.update(job_id, progress=0.92)
        shutil.copyfile(generated, output_path)
        _write_sidecar(resolved_output, {
            "model": "audiosr", "model_variant": f"AudioSR-{params.model_name}",
            "prompt": f"[upscale: {params.input_path}]",
            "seed": params.seed, "sample_rate": 48000,
            "parent": str(params.input_path),
        })
        jobs.update(job_id, status="complete", progress=1.0, output_path=resolved_output)
    except Exception as exc:
        log.exception("AudioSR upscale failed")
        jobs.update(job_id, status="failed", error=str(exc))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _submit(params: UpscaleParams) -> dict:
    job_id = params.job_id or new_job_id()
    jobs.create(job_id, "post", "upscale", _model_dump(params))
    asyncio.create_task(_run_upscale(job_id, params))
    return {"job_id": job_id, "status": "queued"}


@app.get("/health")
async def health() -> dict:
    status = _audiosr_status()
    return {
        "status": "ok",
        "model_loaded": status["ok"],
        "model_variant": "AudioSR",
        "vram_mb": 0,
        "stub": False,
        "audiosr_ready": status["ok"],
        "audiosr_error": status["reason"],
        "audiosr_cli": str(AUDIOSR_CLI),
    }


@app.post("/generate/upscale")
async def generate_upscale(p: UpscaleParams) -> dict:
    if p.model_name not in ("basic", "speech"):
        raise HTTPException(status_code=400, detail="model_name must be basic or speech")
    return _submit(p)


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.get("/files/{job_id}")
async def download_file(job_id: str) -> FileResponse:
    """Stream the output file for a completed job, then delete it from the server.

    Used by remote clients to retrieve generated audio without needing shared
    filesystem access.  The file (and its .meta.json sidecar) are removed after
    the response is fully sent, keeping server-output/ clean automatically.
    """
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    output_path = job.get("output_path")
    if not output_path or not Path(output_path).is_file():
        raise HTTPException(status_code=404, detail="output file not available")

    def _cleanup():
        for p in [output_path, output_path + ".meta.json"]:
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:
                pass

    return FileResponse(
        output_path,
        media_type="audio/wav",
        filename=Path(output_path).name,
        background=BackgroundTask(_cleanup),
    )


@app.post("/load")
async def load() -> dict:
    status = _audiosr_status()
    if not status["ok"]:
        return {"status": "error", "error": status["reason"]}
    return {"status": "loaded"}


@app.post("/unload")
async def unload() -> dict:
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
