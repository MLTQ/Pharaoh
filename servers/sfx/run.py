"""
Pharaoh SFX Server — port 18002
Wraps Sony Woosh (DFlow / Flow). Real inference, lazy model loading, job queue.

Duration is ALWAYS ~5 seconds regardless of what the client requests.
The latent tensor shape (1, 128, 501) is hardcoded by Woosh.

Setup (run once by user):
    git clone https://github.com/SonyResearch/Woosh
    cd Woosh && uv sync --extra cuda

Usage:
    python run.py --host 127.0.0.1 --port 18002 \
        --model-dir ~/pharaoh-models/sfx \
        --woosh-dir ~/path/to/Woosh
"""
import argparse
import logging
import os
import queue
import sys
import threading
import uuid
from pathlib import Path
from typing import Optional

from flask import Flask, jsonify, request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sfx")

# ── CLI args ─────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Pharaoh Woosh SFX server")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=18002)
parser.add_argument("--model-dir", default=os.path.expanduser("~/pharaoh-models/sfx"))
parser.add_argument("--woosh-dir", required=True,
                    help="Path to the Woosh repository root (git clone of SonyResearch/Woosh)")
args, _ = parser.parse_known_args()

MODEL_DIR = Path(args.model_dir).expanduser()
WOOSH_DIR = Path(args.woosh_dir).expanduser()

# Inject Woosh into the path so we can import from it
if str(WOOSH_DIR) not in sys.path:
    sys.path.insert(0, str(WOOSH_DIR))

# ── Model state ───────────────────────────────────────────────────────────────

_ldm = None
_model_lock = threading.Lock()
_model_loaded = False
_model_variant_used = "unknown"


def _get_device():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def _load_model():
    global _ldm, _model_loaded, _model_variant_used
    with _model_lock:
        if _model_loaded:
            return _ldm

        from woosh.model.flowmap_from_pretrained import FlowMapFromPretrained
        from woosh.components.base import LoadConfig

        device = _get_device()

        dflow_ckpt = MODEL_DIR / "checkpoints" / "Woosh-DFlow"
        flow_ckpt  = MODEL_DIR / "checkpoints" / "Woosh-Flow"

        if dflow_ckpt.exists():
            ckpt_path = dflow_ckpt
            _model_variant_used = "Woosh-DFlow"
            log.info("Loading Woosh-DFlow (faster, 4 steps) from %s", ckpt_path)
        elif flow_ckpt.exists():
            ckpt_path = flow_ckpt
            _model_variant_used = "Woosh-Flow"
            log.info("Loading Woosh-Flow fallback from %s", ckpt_path)
        else:
            raise FileNotFoundError(
                f"No Woosh checkpoint found under {MODEL_DIR / 'checkpoints'}. "
                "Expected Woosh-DFlow or Woosh-Flow."
            )

        ldm = FlowMapFromPretrained(LoadConfig(path=str(ckpt_path)))
        ldm = ldm.eval().to(device)

        _ldm = ldm
        _model_loaded = True
        log.info("Model loaded: %s on %s", _model_variant_used, device)
        return _ldm


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

# Fixed latent shape → always ~5 seconds at 48 kHz
_FIXED_LATENT_SHAPE = (1, 128, 501)
_FIXED_DURATION_S = 5.0


def _worker_loop():
    while True:
        job_id, params = _work_queue.get()
        try:
            _update_job(job_id, status="running", progress=0.0)
            ldm = _load_model()

            import torch
            import torchaudio
            from woosh.inference.flowmap_sampler import sample_euler

            device = next(ldm.parameters()).device

            seed    = params.get("seed", 0)
            steps   = min(int(params.get("steps", 4)), 8)
            prompt  = params["prompt"]
            output_path = params["output_path"]

            torch.manual_seed(seed)

            noise = torch.randn(*_FIXED_LATENT_SHAPE).to(device)
            cond = ldm.get_cond(
                {"audio": None, "description": [prompt]},
                no_dropout=True,
                device=device,
            )

            # renoise schedule — always 4 values, truncate/pad to match num_steps
            base_renoise = [0, 0.5, 0.5, 0.3]
            if steps < len(base_renoise):
                renoise = base_renoise[:steps]
            else:
                # Pad with zeros for any extra steps
                renoise = base_renoise + [0.0] * (steps - len(base_renoise))

            with torch.inference_mode():
                x_fake = sample_euler(
                    model=ldm,
                    noise=noise,
                    cond=cond,
                    num_steps=steps,
                    renoise=renoise,
                    cfg=4.5,
                )
                audio = ldm.autoencoder.inverse(x_fake)  # (1, 1, T)

            audio = audio[0].cpu()  # (1, T)
            peak = audio.abs().amax().clamp(min=1.0)
            audio = audio / peak

            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            torchaudio.save(output_path, audio, sample_rate=48000)

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
        "model_variant": _model_variant_used,
        "vram_mb": _vram_mb(),
        "stub": False,
    })


@app.post("/generate/t2a")
def generate_t2a():
    body = request.get_json(force=True)

    # Warn if caller sends a duration other than ~5s — we always produce ~5s
    requested_duration = body.get("duration_seconds")
    if requested_duration is not None and float(requested_duration) != _FIXED_DURATION_S:
        log.warning(
            "Client requested duration_seconds=%.1f but Woosh always generates ~%.1fs "
            "(latent shape is fixed at %s). Ignoring the requested duration.",
            float(requested_duration), _FIXED_DURATION_S, _FIXED_LATENT_SHAPE,
        )

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
