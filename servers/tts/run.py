"""
Pharaoh TTS Server — port 18001
Wraps Qwen3-TTS with real inference, lazy model loading, and a job queue.

Usage:
    python run.py --host 127.0.0.1 --port 18001 \
        --model-dir ~/pharaoh-models/tts \
        --model-variant CustomVoice-1.7B
"""
import argparse
import logging
import os
import queue
import threading
import uuid
from pathlib import Path
from typing import Optional

from flask import Flask, jsonify, request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")

# ── CLI args ─────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Pharaoh Qwen3-TTS server")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=18001)
parser.add_argument("--model-dir", default=os.path.expanduser("~/pharaoh-models/tts"))
parser.add_argument("--model-variant", default="CustomVoice-1.7B",
                    choices=["CustomVoice-1.7B", "VoiceDesign-1.7B", "Base-1.7B",
                             "CustomVoice-0.6B", "Base-0.6B"])
args, _ = parser.parse_known_args()

MODEL_DIR = Path(args.model_dir).expanduser()
MODEL_VARIANT = args.model_variant

VARIANT_TO_HF_ID = {
    "CustomVoice-1.7B": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "VoiceDesign-1.7B": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "Base-1.7B":        "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    "CustomVoice-0.6B": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    "Base-0.6B":        "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
}

# Which endpoint category each variant supports
VARIANT_CATEGORY = {
    "CustomVoice-1.7B": "custom_voice",
    "VoiceDesign-1.7B": "voice_design",
    "Base-1.7B":        "voice_clone",
    "CustomVoice-0.6B": "custom_voice",
    "Base-0.6B":        "voice_clone",
}

# ── Model state ───────────────────────────────────────────────────────────────

_model = None
_model_lock = threading.Lock()
_model_loaded = False


def _get_device_dtype():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda", torch.bfloat16
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps", torch.float32
    except ImportError:
        pass
    return "cpu", None  # dtype handled in load


def _load_model():
    global _model, _model_loaded
    with _model_lock:
        if _model_loaded:
            return _model

        log.info("Loading Qwen3-TTS variant=%s ...", MODEL_VARIANT)
        import torch
        from qwen_tts import Qwen3TTS  # noqa: F401 — actual import path from qwen-tts

        device, dtype = _get_device_dtype()
        hf_id = VARIANT_TO_HF_ID[MODEL_VARIANT]

        local_only = MODEL_DIR.exists()
        model_path = str(MODEL_DIR) if local_only else hf_id

        load_kwargs: dict = {
            "device_map": "auto",
        }
        if dtype is not None:
            load_kwargs["dtype"] = dtype
        elif device == "cpu":
            import torch as _t
            load_kwargs["dtype"] = _t.float32

        if local_only:
            load_kwargs["local_files_only"] = True
            log.info("Loading from local dir: %s", MODEL_DIR)
        else:
            MODEL_DIR.mkdir(parents=True, exist_ok=True)
            log.info("Downloading from HuggingFace: %s → %s", hf_id, MODEL_DIR)

        # qwen-tts exposes Qwen3TTS.from_pretrained
        from qwen_tts import Qwen3TTS
        model = Qwen3TTS.from_pretrained(model_path, **load_kwargs)
        model.eval()

        _model = model
        _model_loaded = True
        log.info("Model loaded: %s", MODEL_VARIANT)
        return _model


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
        job_id, endpoint, params = _work_queue.get()
        try:
            _update_job(job_id, status="running", progress=0.0)
            model = _load_model()

            import torch
            import soundfile

            torch.manual_seed(params.get("seed", 0))

            output_path = params["output_path"]
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)

            if endpoint == "custom_voice":
                wavs, sr = model.generate_custom_voice(
                    text=params["text"],
                    speaker=params.get("speaker", "Vivian"),
                    language=params.get("language") or None,
                    instruct=params.get("instruct") or None,
                    top_p=params.get("top_p", 0.9),
                    temperature=params.get("temperature", 0.7),
                    max_new_tokens=params.get("max_new_tokens", 2048),
                )
                soundfile.write(output_path, wavs[0], sr)

            elif endpoint == "voice_design":
                wavs, sr = model.generate_voice_design(
                    text=params["text"],
                    instruct=params.get("voice_description", ""),
                    language=params.get("language") or None,
                    top_p=params.get("top_p", 0.9),
                    temperature=params.get("temperature", 0.7),
                    max_new_tokens=params.get("max_new_tokens", 2048),
                )
                soundfile.write(output_path, wavs[0], sr)

            elif endpoint == "voice_clone":
                wavs, sr = model.generate_voice_clone(
                    text=params["text"],
                    ref_audio=params["ref_audio_path"],
                    ref_text=params.get("ref_transcript") or None,
                    language=params.get("language") or None,
                    x_vector_only_mode=params.get("icl_mode", False),
                    top_p=params.get("top_p", 0.9),
                    temperature=params.get("temperature", 0.7),
                )
                soundfile.write(output_path, wavs[0], sr)

            _update_job(job_id, status="complete", progress=1.0, output_path=output_path)
            log.info("Job %s complete: %s", job_id, output_path)

        except Exception as exc:
            log.exception("Job %s failed", job_id)
            _update_job(job_id, status="failed", error=str(exc))
        finally:
            _work_queue.task_done()


_worker = threading.Thread(target=_worker_loop, daemon=True)
_worker.start()


def _enqueue(endpoint: str, params: dict) -> dict:
    # Variant guard
    category = VARIANT_CATEGORY[MODEL_VARIANT]
    if endpoint != category:
        return None, (
            f"Variant '{MODEL_VARIANT}' only supports '{category}' endpoint; "
            f"requested '{endpoint}'"
        )

    job_id = _new_job()
    _work_queue.put((job_id, endpoint, params))
    return {"job_id": job_id}, None


# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "model_loaded": _model_loaded,
        "model_variant": MODEL_VARIANT,
        "vram_mb": _vram_mb(),
        "stub": False,
    })


@app.post("/generate/custom_voice")
def generate_custom_voice():
    body = request.get_json(force=True)
    result, err = _enqueue("custom_voice", body)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(result)


@app.post("/generate/voice_design")
def generate_voice_design():
    body = request.get_json(force=True)
    result, err = _enqueue("voice_design", body)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(result)


@app.post("/generate/voice_clone")
def generate_voice_clone():
    body = request.get_json(force=True)
    result, err = _enqueue("voice_clone", body)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(result)


@app.get("/jobs/<job_id>")
def get_job(job_id: str):
    job = _get_job(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)


if __name__ == "__main__":
    app.run(host=args.host, port=args.port)
