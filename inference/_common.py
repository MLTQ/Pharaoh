"""Shared helpers for Pharaoh inference servers."""
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional

# ── Remote path remapping ─────────────────────────────────────────────────────
#
# When Pharaoh runs with remote inference servers the Mac/Windows client sends
# absolute output paths that are valid on the *client* machine
# (e.g. /Users/max/pharaoh-projects/uuid/...) but don't exist on the server.
#
# Set PHARAOH_PROJECTS_DIR on the remote server to the local equivalent
# (e.g. /home/m/pharaoh-projects).  remap_path() then finds the UUID-shaped
# segment in any incoming path and rebuilds it under the local root.
#
# If PHARAOH_PROJECTS_DIR is unset every path is returned unchanged (local mode).

_UUID_RE = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(.*)",
    re.IGNORECASE,
)


def remap_path(path: str | None) -> str | None:
    """
    Remap a client-side absolute path to the server's local projects dir.

    /Users/max/pharaoh-projects/{uuid}/foo/bar.wav
        → /home/m/pharaoh-projects/{uuid}/foo/bar.wav

    Only activates when PHARAOH_PROJECTS_DIR is set in the environment.
    Paths that don't contain a UUID are returned unchanged (e.g. model paths).
    None is passed through as-is.
    """
    if path is None:
        return None
    local_root = os.environ.get("PHARAOH_PROJECTS_DIR", "")
    if not local_root:
        return path  # local mode — no remapping
    m = _UUID_RE.search(path)
    if not m:
        return path  # no UUID found — leave model paths / other refs alone
    # Reconstruct: local_root / uuid / rest
    return str(Path(local_root) / (m.group(1) + m.group(2)))


def new_job_id() -> str:
    return str(uuid.uuid4())


class JobStore:
    """Thread-safe in-memory job registry."""

    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}

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
