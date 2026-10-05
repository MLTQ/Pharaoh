"""MOSS-SoundEffect v2 worker for the SFX server.

Runs in inference/.venv-moss (its own torch/transformers), started by
sfx_server.py and kept alive so the ~10 GB of weights load once. Jobs arrive
as JSON lines on stdin; each reply is one line on stdout prefixed with
REPLY_PREFIX (the libraries print their own chatter on stdout too).

Request:  {"id", "prompt", "seconds", "steps", "cfg_scale", "seed", "negative_prompt", "output_path"}
Reply:    {"id", "ok": true, "output_path", "duration_ms", "sample_rate"}
       or {"id", "ok": false, "error"}

VRAM management is on: each stage moves only the model it needs onto the GPU
(peak ~9 GB, so it fits beside Breeze on a 24 GB card). It doesn't change the
numbers — the output matches an all-on-GPU run to 24-bit precision.

The pipeline always denoises its full 30 s canvas and crops; never shrink
`max_inference_seconds` to save memory — the model only works at the length
it was trained on, and shorter canvases come out as noise.
"""

import json
import os
import sys
import time
import traceback

REPLY_PREFIX = "@@MOSS "
MODEL_ID = os.environ.get("PHARAOH_MOSS_MODEL", "OpenMOSS-Team/MOSS-SoundEffect-v2.0")
MAX_SECONDS = 30.0


def reply(obj: dict) -> None:
    sys.stdout.write(REPLY_PREFIX + json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> None:
    import soundfile as sf
    import torch
    from moss_soundeffect_v2 import MossSoundEffectPipeline

    t = time.time()
    pipe = MossSoundEffectPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16, device="cuda")
    pipe.engine.vram_management_enabled = True
    pipe.engine.load_models_to_device([])  # park everything until a stage needs it
    torch.cuda.empty_cache()
    reply({"ready": True, "load_s": round(time.time() - t, 1), "sample_rate": pipe.sample_rate})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            seconds = max(0.5, min(float(req.get("seconds", 5.0)), MAX_SECONDS))
            audio = pipe(
                prompt=req["prompt"],
                seconds=seconds,
                num_inference_steps=int(req.get("steps", 100)),
                cfg_scale=float(req.get("cfg_scale", 4.0)),
                seed=int(req.get("seed", 0)),
                negative_prompt=req.get("negative_prompt", "") or "",
            )
            wav = audio[0].float().cpu().numpy().T  # (T, C)
            peak = float(abs(wav).max()) if wav.size else 0.0
            if peak > 1.0:
                wav = wav / peak
            out = req["output_path"]
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            sf.write(out, wav, pipe.sample_rate, subtype="PCM_24")
            reply({"id": req["id"], "ok": True, "output_path": out,
                   "duration_ms": int(len(wav) / pipe.sample_rate * 1000), "sample_rate": pipe.sample_rate})
        except Exception as exc:  # keep serving; the server reports the failure
            traceback.print_exc(file=sys.stderr)
            reply({"id": req.get("id"), "ok": False, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
