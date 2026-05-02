"""Shared helpers for Pharaoh inference servers."""
import time
import uuid
from typing import Any


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
            "created_at": time.time(),
        }
        self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> dict | None:
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
        }
