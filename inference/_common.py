"""Shared helpers for Pharaoh inference servers."""
import asyncio
import struct
import time
import uuid
from typing import Any

import aiofiles


def new_job_id() -> str:
    return str(uuid.uuid4())


def make_silence_wav(duration_seconds: float = 0.5, sample_rate: int = 48000) -> bytes:
    """Generate a minimal silent WAV file in memory."""
    num_samples = int(sample_rate * duration_seconds)
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = num_samples * block_align
    chunk_size = 36 + data_size

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", chunk_size, b"WAVE",
        b"fmt ", 16,
        1,              # PCM
        num_channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data", data_size,
    )
    return header + b"\x00" * data_size


async def write_wav_stub(output_path: str, duration_seconds: float, sample_rate: int = 48000) -> None:
    data = make_silence_wav(duration_seconds, sample_rate)
    async with aiofiles.open(output_path, "wb") as f:
        await f.write(data)


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
