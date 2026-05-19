"""Shared helpers for Pharaoh inference servers."""
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

# ── Remote path remapping ─────────────────────────────────────────────────────
#
# When Pharaoh runs with remote inference servers the Mac/Windows client sends
# absolute output paths that are valid on the *client* machine
# (e.g. /Users/max/pharaoh-projects/uuid/...) but don't exist on the server.
#
# Two modes:
#   Explicit: set PHARAOH_PROJECTS_DIR on the remote server.  Every UUID-based
#             path is rebuilt under that local root.
#   Auto:     if PHARAOH_PROJECTS_DIR is unset and the incoming path's root is
#             not accessible on this filesystem (e.g. /Users/max on Linux), the
#             path is remapped into ./server-output/ inside the inference dir.
#             This requires zero configuration on the server — just start it.
#
# The client retrieves output via GET /files/{job_id} which streams the file
# and then deletes it from the server, keeping the server-output dir clean.

_SCRIPT_DIR = Path(__file__).parent
SERVER_OUTPUT_DIR = _SCRIPT_DIR / "server-output"

_UUID_RE = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(.*)",
    re.IGNORECASE,
)


def server_output_path(job_id: str, ext: str = ".wav") -> str:
    """
    Return a server-local output path for a job.

    Used when the client sends an empty output_path (remote mode) — the
    server generates a stable path under ./server-output/{job_id}/output.wav
    so the client can retrieve it via GET /files/{job_id}.
    """
    out = SERVER_OUTPUT_DIR / job_id / f"output{ext}"
    out.parent.mkdir(parents=True, exist_ok=True)
    return str(out)


def remap_path(path: Optional[str]) -> Optional[str]:
    """
    Remap a client-side absolute path so the server can write it locally.

    Modes (in priority order):
      1. path is None or empty → caller should use server_output_path() instead.
         remap_path returns None so the caller can detect this.
      2. PHARAOH_PROJECTS_DIR env var set → rebuild path under that root using
         the UUID segment extracted from the client path.
      3. Otherwise → return unchanged (local/same-machine mode).

    Paths without a UUID (model files, config, etc.) are always returned as-is.
    """
    if not path:
        return None

    explicit_root = os.environ.get("PHARAOH_PROJECTS_DIR", "")
    if explicit_root:
        m = _UUID_RE.search(path)
        return str(Path(explicit_root) / (m.group(1) + m.group(2))) if m else path

    return path


def new_job_id() -> str:
    return str(uuid.uuid4())


def register_upload_route(app) -> None:
    """Register POST /upload on a FastAPI app.

    Accepts raw bytes body + ?filename= query param (content-type:
    application/octet-stream). Saves to SERVER_OUTPUT_DIR/uploads/filename
    and returns {"server_path": str(dest)}.

    Called by every inference server so that remote clients can upload
    input files (ref audio, source audio, etc.) before submitting a job.
    """
    from fastapi import Query, Request as _Request

    @app.post("/upload")
    async def upload_file(request: _Request, filename: str = Query(...)):
        content = await request.body()
        dest = SERVER_OUTPUT_DIR / "uploads" / filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return {"server_path": str(dest)}


class JobStore:
    """Thread-safe in-memory job registry."""

    def __init__(self) -> None:
        self._jobs: Dict[str, Dict[str, Any]] = {}

    def create(self, job_id: str, model: str, endpoint: str, params: dict) -> dict:
        job = {
            "job_id": job_id,
            "model": model,
            "endpoint": endpoint,
            "params": params,
            "status": "pending",
            "progress": 0.0,
            "output_path": None,
            "error": None,
            "message": None,
            "created_at": time.time(),
        }
        self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Optional[dict]:
        return self._jobs.get(job_id)

    def update(self, job_id: str, **kwargs) -> None:
        if job_id in self._jobs:
            self._jobs[job_id].update(kwargs)

    def response(self, job_id: str) -> dict:
        j = self._jobs[job_id]
        return {
            "job_id": j["job_id"],
            "status": j["status"],
            "progress": j["progress"],
            "output_path": j["output_path"],
            "error": j["error"],
            "message": j.get("message"),
        }
