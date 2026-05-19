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


def _path_root_accessible(path: str) -> bool:
    """True if the first 3 path components exist on this machine."""
    parts = Path(path).parts
    if len(parts) < 2:
        return True
    probe = Path(*parts[: min(3, len(parts))])
    return probe.exists()


def remap_path(path: Optional[str]) -> Optional[str]:
    """
    Remap a client-side absolute path so the server can write it locally.

    Priority:
      1. PHARAOH_PROJECTS_DIR env var → explicit remap root
      2. Path root inaccessible on this machine → ./server-output/
      3. Path root accessible → return unchanged (local mode)

    Paths without a UUID (model files, etc.) are always returned unchanged.
    None is passed through as-is.
    """
    if path is None:
        return None

    explicit_root = os.environ.get("PHARAOH_PROJECTS_DIR", "")
    if explicit_root:
        m = _UUID_RE.search(path)
        return str(Path(explicit_root) / (m.group(1) + m.group(2))) if m else path

    # Auto-mode: remap only if the path's root doesn't exist locally
    if not _path_root_accessible(path):
        m = _UUID_RE.search(path)
        if m:
            return str(SERVER_OUTPUT_DIR / (m.group(1) + m.group(2)))

    return path


def new_job_id() -> str:
    return str(uuid.uuid4())


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
