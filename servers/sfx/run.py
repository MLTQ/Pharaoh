"""SFX inference server stub — returns duration_seconds of 48kHz mono WAV (220 Hz sine)."""
import argparse
import logging
import math
import os
import struct
import threading
import uuid
import wave

from flask import Flask, jsonify, request

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [SFX] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

app = Flask(__name__)

# In-memory job store: {job_id: {"status", "progress", "output_path", "error"}}
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()

MODEL_VARIANT = "woosh-sfx-stub-v3"
SAMPLE_RATE = 48000
FREQ_HZ = 220.0


def _write_sine_wav(output_path: str, freq: float, duration_sec: float, sample_rate: int, channels: int = 1) -> None:
    """Write a sine-wave WAV to output_path using only stdlib wave + struct."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    num_samples = int(sample_rate * duration_sec)
    with wave.open(output_path, "w") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        for i in range(num_samples):
            val = int(32767 * math.sin(2 * math.pi * freq * i / sample_rate))
            for _ in range(channels):
                wf.writeframes(struct.pack("<h", val))


def _run_job(job_id: str, output_path: str, duration_sec: float) -> None:
    """Background thread: write WAV and update job state."""
    log.info("Job %s started → %s (%.1fs)", job_id, output_path, duration_sec)
    with _jobs_lock:
        _jobs[job_id]["status"] = "running"
        _jobs[job_id]["progress"] = 0.0

    try:
        _write_sine_wav(output_path, FREQ_HZ, duration_sec, SAMPLE_RATE)
        with _jobs_lock:
            _jobs[job_id]["status"] = "complete"
            _jobs[job_id]["progress"] = 1.0
            _jobs[job_id]["output_path"] = output_path
        log.info("Job %s complete", job_id)
    except Exception as exc:
        with _jobs_lock:
            _jobs[job_id]["status"] = "failed"
            _jobs[job_id]["error"] = str(exc)
        log.error("Job %s failed: %s", job_id, exc)


def _submit_job(output_path: str, duration_sec: float) -> str:
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {"status": "pending", "progress": 0.0, "output_path": output_path, "error": None}
    t = threading.Thread(target=_run_job, args=(job_id, output_path, duration_sec), daemon=True)
    t.start()
    return job_id


# ── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return jsonify({"status": "ok", "model_loaded": True, "model_variant": MODEL_VARIANT, "vram_mb": 0, "stub": True})


# ── Job status ───────────────────────────────────────────────────────────────

@app.get("/jobs/<job_id>")
def job_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "output_path": job["output_path"],
        "error": job["error"],
    })


# ── Generation endpoints ─────────────────────────────────────────────────────

@app.post("/generate/t2a")
def generate_t2a():
    body = request.get_json(force=True) or {}
    output_path = body.get("output_path", f"/tmp/sfx_{uuid.uuid4()}.wav")
    duration_sec = float(body.get("duration_seconds", 3.0))
    log.info("t2a request: prompt=%s duration=%.1fs", str(body.get("prompt", ""))[:60], duration_sec)
    job_id = _submit_job(output_path, duration_sec)
    return jsonify({"job_id": job_id})


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SFX stub server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18002)
    parser.add_argument("--model-dir", default=None)
    args = parser.parse_args()

    log.info("SFX stub server starting on %s:%d (model-dir=%s)", args.host, args.port, args.model_dir)
    app.run(host=args.host, port=args.port)
