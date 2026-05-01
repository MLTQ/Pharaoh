"""
Pharaoh Music Server — port 18003
Wraps ACE-Step pipeline. Real inference, lazy model loading, job queue.

Setup (run once by user):
    git clone https://github.com/ACE-Step/ACE-Step
    cd ACE-Step && pip install -e .

Usage:
    python run.py --host 127.0.0.1 --port 18003 \
        --model-dir ~/pharaoh-models/music \
        --ace-step-dir ~/path/to/ACE-Step
"""
import argparse
import logging
import os
import queue
import shutil
import sys
import threading
import uuid
from pathlib import Path
from typing import Optional

from flask import Flask, jsonify, request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("music")

# ── CLI args ─────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Pharaoh ACE-Step music server")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=18003)
parser.add_argument("--model-dir", default=os.path.expanduser("~/pharaoh-models/music"))
parser.add_argument("--ace-step-dir", default="",
                    help="Path to ACE-Step repo root (sys.path injection if not pip-installed)")
args, _ = parser.parse_known_args()

MODEL_DIR = Path(args.model_dir).expanduser()

# Inject ACE-Step into path if provided and not already installed
if args.ace_step_dir:
    ace_step_dir = Path(args.ace_step_dir).expanduser()
    if str(ace_step_dir) not in sys.path:
        sys.path.insert(0, str(ace_step_dir))

# ── Model state ───────────────────────────────────────────────────────────────

_pipeline = None
_model_lock = threading.Lock()
_model_loaded = False


def _get_dtype_str() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "bfloat16"
    except ImportError:
        pass
    return "float32"


def _load_model():
    global _pipeline, _model_loaded
    with _model_lock:
        if _model_loaded:
            return _pipeline

        log.info("Loading ACE-Step pipeline from %s ...", MODEL_DIR)
        from acestep.pipeline_ace_step import ACEStepPipeline

        dtype = _get_dtype_str()
        pipeline = ACEStepPipeline(
            checkpoint_dir=str(MODEL_DIR),
            dtype=dtype,
            cpu_offload=False,
        )

        _pipeline = pipeline
        _model_loaded = True
        log.info("ACE-Step pipeline loaded (dtype=%s)", dtype)
        return _pipeline


def _vram_mb() -> int:
    try:
        import torch
        if torch.cuda.is_available():
            return int(torch.cuda.memory_allocated() // (1024 * 1024))
    except Exception:
        pass
    return 0


# ── Job store ─────────────────────────────────────────────────────────────────

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _new_job() -> str:
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "status": "pending",
            "progress": 0.0,
            "output_path": None,
            "error": None,
        }
    return job_id


def _update_job(job_id: str, **kwargs):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)


def _get_job(job_id: str) -> Optional[dict]:
    with _jobs_lock:
        return dict(_jobs[job_id]) if job_id in _jobs else None


# ── Worker thread ─────────────────────────────────────────────────────────────

_work_queue: queue.Queue = queue.Queue()


def _worker_loop():
    while True:
        job_id, params = _work_queue.get()
        try:
            _update_job(job_id, status="running", progress=0.0)
            pipeline = _load_model()

            output_path = params["output_path"]
            save_dir = os.path.dirname(output_path) or "."
            Path(save_dir).mkdir(parents=True, exist_ok=True)

            # Map Rust/frontend params → ACEStepPipeline params
            caption           = params.get("caption", "")
            lyrics            = params.get("lyrics", "")
            audio_duration    = float(params.get("duration_seconds", 30.0))
            infer_step        = max(1, int(params.get("diffusion_steps", 60)))
            seed              = int(params.get("seed", 0))
            batch_size        = int(params.get("batch_size", 1))
            ref_audio_input   = params.get("reference_audio_path", "") or None

            # lm_model_size, language, thinking_mode, bpm, key → not in ACEStepPipeline

            pipeline_kwargs = dict(
                prompt=caption,
                lyrics=lyrics,
                audio_duration=audio_duration,
                infer_step=infer_step,
                manual_seeds=[seed],
                batch_size=batch_size,
                save_path=save_dir,
            )

            if ref_audio_input:
                pipeline_kwargs["ref_audio_input"] = ref_audio_input
                pipeline_kwargs["audio2audio_enable"] = True
                pipeline_kwargs["ref_audio_strength"] = 0.5

            results = pipeline(**pipeline_kwargs)

            # results is a list; audio file paths are all elements except the last
            # (last element is a metadata dict). Take results[0] for the first audio.
            generated_path = results[0]

            if str(generated_path) != str(output_path):
                shutil.move(str(generated_path), output_path)

            _update_job(job_id, status="complete", progress=1.0, output_path=output_path)
            log.info("Job %s complete: %s", job_id, output_path)

        except Exception as exc:
            log.exception("Job %s failed", job_id)
            _update_job(job_id, status="failed", error=str(exc))
        finally:
            _work_queue.task_done()


_worker = threading.Thread(target=_worker_loop, daemon=True)
_worker.start()


# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "model_loaded": _model_loaded,
        "model_variant": "ACE-Step-v1-3.5B",
        "vram_mb": _vram_mb(),
        "stub": False,
    })


@app.post("/generate/text2music")
def generate_text2music():
    body = request.get_json(force=True)
    job_id = _new_job()
    _work_queue.put((job_id, body))
    return jsonify({"job_id": job_id})


@app.get("/jobs/<job_id>")
def get_job(job_id: str):
    job = _get_job(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)


if __name__ == "__main__":
    app.run(host=args.host, port=args.port)
