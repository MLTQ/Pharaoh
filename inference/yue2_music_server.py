"""
Pharaoh Music Server (YuE2) — port 18003.

Pharaoh's music engine on NVIDIA machines: YuE2-3B (m-a-p) plans an ABC score
and renders it to 48 kHz stereo. Same API as music_server.py (ACE-Step), so
every caller keeps working; start_servers.sh picks this one when
inference/.venv-yue2 exists.

- /generate/text2music is YuE2. `instrumental` (default true) moves the
  planned vocal line to the instrument voice, so cues have no singing.
- /generate/repaint and /generate/cover run ACE-Step v1 in a one-shot
  subprocess (ace_step_worker.py in .venv-music), because YuE2 can only
  re-render a whole score.

Weights come from the Hugging Face cache (setup.sh yue2 downloads them).
Needs a BF16-capable NVIDIA GPU; peaks around 8 GB.
"""
import asyncio
import datetime
import gc
import json
import logging
import os
import subprocess
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

import yue2_score
from _common import (JobStore, inference_lock, is_server_owned, new_job_id, register_upload_route,
                     remap_path, server_output_path, spawn_job)

log = logging.getLogger(__name__)

PORT = int(os.environ.get("PHARAOH_MUSIC_PORT", 18003))
MODEL_REPO = os.environ.get("PHARAOH_YUE2_MODEL", "m-a-p/YuE2-3B")
VAE_REPO = os.environ.get("PHARAOH_YUE2_VAE", "m-a-p/YuE2-Vae")
DEVICE = os.environ.get("PHARAOH_YUE2_DEVICE", "cuda")
SCRIPT_DIR = Path(__file__).parent
ACE_PYTHON = Path(os.environ.get("PHARAOH_MUSIC_PYTHON", SCRIPT_DIR / ".venv-music/bin/python3"))

SAMPLE_RATE = 48000
TOKENS_PER_SECOND = 25      # YuE2 semantic tokens per second of audio
MIN_SECONDS = 10.0          # the model emits at least 200 tokens (~8 s)
MAX_SECONDS = 330.0         # 9000-token ceiling is 360 s; leave room for the ending
ENDING_SECONDS = 10.0       # let a cue finish its phrase past the target
FADE_SECONDS = 2.0          # applied when the token cap cut the music off
OOM_MARKER = "MUSIC_OOM"    # FE matches this prefix to surface a memory toast
MODEL_NAME = "yue2-3b"

app = FastAPI(title="Pharaoh Music Server (YuE2)", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
register_upload_route(app)
jobs = JobStore()

_pipe = None
_load_lock = asyncio.Lock()


def _weights_status() -> dict:
    """Whether both snapshots are already in the Hugging Face cache."""
    try:
        from huggingface_hub import snapshot_download
        for repo in (MODEL_REPO, VAE_REPO):
            snapshot_download(repo, local_files_only=True)
        return {"ok": True, "reason": ""}
    except Exception:
        return {"ok": False, "reason": (
            f"YuE2 weights not downloaded. Run: ./inference/setup.sh yue2 "
            f"(or hf download {MODEL_REPO} && hf download {VAE_REPO})")}


def _ace_available() -> bool:
    import ace_step_tasks
    return ACE_PYTHON.is_file() and ace_step_tasks.model_dir_status()["ok"]


def _is_memory_error(exc: BaseException) -> bool:
    if type(exc).__name__ in ("OutOfMemoryError", "MemoryError"):
        return True
    msg = str(exc).lower()
    return any(s in msg for s in ("out of memory", "cuda oom", "cannot allocate"))


def _do_load() -> None:
    global _pipe
    from yue2 import YuE2Pipeline
    log.info(f"Loading YuE2 ({MODEL_REPO}, {VAE_REPO}) on {DEVICE}")
    pipe = YuE2Pipeline.from_pretrained(MODEL_REPO, vae=VAE_REPO, device=DEVICE, progress=False)
    pipe._load_model()  # load weights now so errors surface here, not mid-job
    _pipe = pipe
    log.info("YuE2 loaded.")


def _do_unload() -> None:
    global _pipe
    if _pipe is not None:
        _pipe.close()
    _pipe = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


async def _ensure_model() -> str | None:
    """Load the pipeline if needed. Returns an error string, else None."""
    if _pipe is not None:
        return None
    status = _weights_status()
    if not status["ok"]:
        return status["reason"]
    async with _load_lock:
        if _pipe is not None:
            return None
        try:
            await asyncio.get_running_loop().run_in_executor(None, _do_load)
        except ImportError as exc:
            return f"yue2 package not installed: {exc}. Run: ./inference/setup.sh yue2"
        except Exception as exc:
            log.exception("YuE2 load failed")
            if _is_memory_error(exc):
                return f"{OOM_MARKER}: Not enough GPU memory to load YuE2. Free a model in the model manager and retry."
            return f"Auto-load failed: {exc}"
    return None


# ── Request models ──────────────────────────────────────────────────────────

class Text2MusicParams(BaseModel):
    caption: str
    lyrics: str = ""
    duration_seconds: float = 30.0
    bpm: int | None = None
    key: str = ""
    instrumental: bool = True
    seed: int = 0
    output_path: str = ""
    take_index: int = 1
    # ACE-Step-only fields (lm_model_size, diffusion_steps, ...) are accepted and ignored.


class CoverParams(BaseModel):
    source_audio_path: str
    caption: str = ""
    cover_strength: float = 0.5
    duration_seconds: float = 30.0
    diffusion_steps: int = 60
    seed: int = 0
    output_path: str = ""


class RepaintParams(BaseModel):
    source_audio_path: str
    caption: str = ""
    start_ms: int = 0
    end_ms: int = 10000
    duration_seconds: float = 30.0
    diffusion_steps: int = 60
    seed: int = 0
    output_path: str = ""


# ── YuE2 generation ──────────────────────────────────────────────────────────

def _compose(params: dict, progress) -> tuple[np.ndarray, dict]:
    """Plan, shape the score, render. Returns (audio [samples, channels], details)."""
    from yue2 import SymbolicPlan  # noqa: F401  (import check: fail early, not mid-plan)

    duration = min(max(float(params["duration_seconds"]), MIN_SECONDS), MAX_SECONDS)
    instrumental = bool(params.get("instrumental", True))
    bpm = int(params["bpm"]) if params.get("bpm") else None
    seed = int(params.get("seed") or 0) or int.from_bytes(os.urandom(4), "little")
    style = yue2_score.style_text(params["caption"], bpm, params.get("key", ""), instrumental)
    lyrics = params.get("lyrics", "") or ""
    plan_lyrics = yue2_score.planning_lyrics(duration) if instrumental or not lyrics.strip() else lyrics

    # 1. Plan. The planner writes far more score than a cue needs (4-9 minutes
    #    from three section tags), so stop it at roughly what the target needs.
    #    Fast music runs up to ~26 ABC tokens per second.
    #    Songs keep the full budget so every lyric line gets music.
    abc_cap = int(min(4096, max(800, 400 + 30 * duration))) if instrumental else 4096
    planned = []
    plan = _pipe.plan(style=style, lyrics=plan_lyrics, cot="full", seed=seed,
                      abc_sampling={"max_tokens": abc_cap},
                      on_token=lambda *_: planned.append(1) or progress(0.05 + 0.25 * len(planned) / abc_cap))
    abc = yue2_score.repair(plan.abc, instrumental)

    # 2. Shape it: exact tempo, vocals moved to the instrument voice, cut to length.
    if bpm:
        abc = yue2_score.set_tempo(abc, bpm)
    if instrumental:
        abc = yue2_score.trim(yue2_score.instrumental(abc), duration)
        lyrics = yue2_score.section_tags(abc)
    else:
        lyrics = plan_lyrics

    # 3. Render. Capping the tokens bounds the length when the model plays past the score.
    cap = int((duration + ENDING_SECONDS) * TOKENS_PER_SECOND)
    seen = []
    song = _pipe(style=style, lyrics=lyrics, cot="full", seed=seed, abc=abc,
                 semantic_sampling={"max_tokens": cap},
                 on_token=lambda *_: seen.append(1) or progress(0.3 + 0.55 * min(len(seen) / cap, 1.0)))
    progress(0.95)
    audio = np.asarray(song.audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if song.semantic.truncated:
        n = min(len(audio), int(FADE_SECONDS * SAMPLE_RATE))
        audio[-n:] *= np.linspace(1.0, 0.0, n, dtype=np.float32)[:, None]
    return audio, {
        "model": MODEL_NAME, "model_variant": "YuE2-3B + YuE2-Vae", "seed": seed,
        "instrumental": instrumental, "style": style, "score_abc": abc,
        "cut_off": bool(song.semantic.truncated),
    }


def _write_outputs(out_path: str, audio: np.ndarray, details: dict, params: dict) -> None:
    import soundfile as sf
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_path, np.clip(audio, -1.0, 1.0), SAMPLE_RATE, subtype="PCM_24")
    Path(out_path + ".score.abc").write_text(details["score_abc"], encoding="utf-8")
    sidecar = {
        "model": MODEL_NAME, "model_variant": details["model_variant"],
        "prompt": params.get("caption", ""), "instruct": details["style"],
        "speaker": None, "language": None, "seed": details["seed"],
        "temperature": None, "top_p": None,
        "duration_target_ms": int(float(params["duration_seconds"]) * 1000),
        "duration_actual_ms": int(len(audio) * 1000 / SAMPLE_RATE),
        "sample_rate": SAMPLE_RATE,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "parent": None, "take_index": int(params.get("take_index", 1)),
        "qa_status": "unreviewed", "qa_notes": "",
    }
    Path(out_path + ".meta.json").write_text(json.dumps(sidecar, indent=2))


async def _run_yue2(job_id: str, params: dict) -> None:
    jobs.update(job_id, status="running", progress=0.01)
    async with inference_lock():
        err = await _ensure_model()
        if err:
            jobs.update(job_id, status="failed", error=err)
            return
        try:
            out_path = remap_path(params.get("output_path")) or server_output_path(job_id)
            progress = lambda p: jobs.update(job_id, progress=round(p, 3))  # noqa: E731
            loop = asyncio.get_running_loop()
            audio, details = await loop.run_in_executor(None, lambda: _compose(params, progress))
            await loop.run_in_executor(None, lambda: _write_outputs(out_path, audio, details, params))
            jobs.update(job_id, status="complete", progress=1.0, output_path=out_path,
                        result={k: v for k, v in details.items() if k != "score_abc"}
                        | {"score_path": out_path + ".score.abc"})
        except Exception as exc:
            log.exception("YuE2 generation failed")
            error = f"{OOM_MARKER}: {exc}" if _is_memory_error(exc) else str(exc)
            jobs.update(job_id, status="failed", error=error)


async def _run_ace(job_id: str, endpoint: str, params: dict) -> None:
    """Repaint/cover through ACE-Step v1 in its own interpreter."""
    jobs.update(job_id, status="running", progress=0.02)
    if not _ace_available():
        jobs.update(job_id, status="failed", error=(
            f"{endpoint} needs ACE-Step v1: ./inference/setup.sh core (creates .venv-music) and "
            f"hf download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music"))
        return
    async with inference_lock():
        out_path = remap_path(params.get("output_path")) or server_output_path(job_id)
        # Two 3B+ models don't both fit smaller cards; YuE2 reloads in seconds.
        await asyncio.get_running_loop().run_in_executor(None, _do_unload)
        jobs.update(job_id, progress=0.1)
        job = json.dumps({"endpoint": endpoint, "params": params, "output_path": out_path})
        proc = await asyncio.create_subprocess_exec(
            str(ACE_PYTHON), str(SCRIPT_DIR / "ace_step_worker.py"), job,
            cwd=str(SCRIPT_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        _, stderr = await proc.communicate()
        if proc.returncode != 0 or not Path(out_path).is_file():
            tail = stderr.decode(errors="replace").strip().splitlines()[-5:]
            error = "ACE-Step worker failed: " + " | ".join(tail)
            if "out of memory" in error.lower():
                error = f"{OOM_MARKER}: {error}"
            jobs.update(job_id, status="failed", error=error)
            return
        spliced = False
        if endpoint == "repaint":
            spliced = await asyncio.get_running_loop().run_in_executor(
                None, lambda: _splice_repaint(params["source_audio_path"], out_path,
                                              int(params.get("start_ms", 0)), int(params.get("end_ms", 10000))))
        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path,
                    result={"model": "ace-step-v1", "model_variant": "ACE-Step-v1-3.5B",
                            "endpoint": endpoint, "spliced": spliced})


SPLICE_FADE_SECONDS = 0.1


def _splice_repaint(source_path: str, repainted_path: str, start_ms: int, end_ms: int) -> bool:
    """Keep the source outside the repaint window; crossfade in only the new section.

    ACE-Step re-encodes the whole file through its VAE and writes 16-bit, so
    without this a repaint degrades audio it was asked to leave alone.
    Returns False (keeping ACE-Step's file) when the formats don't line up.
    """
    import soundfile as sf
    src, sr = sf.read(source_path, dtype="float32", always_2d=True)
    new, sr_new = sf.read(repainted_path, dtype="float32", always_2d=True)
    if sr != sr_new or src.shape[1] != new.shape[1]:
        log.warning(f"Repaint not spliced: {sr}/{src.shape[1]}ch source vs {sr_new}/{new.shape[1]}ch output")
        return False
    fade = int(SPLICE_FADE_SECONDS * sr)
    a = max(0, int(start_ms * sr / 1000) - fade)
    b = min(len(src), len(new), int(end_ms * sr / 1000) + fade)
    if b - a <= 2 * fade:
        return False
    w = np.ones(b - a, dtype=np.float32)
    w[:fade] = np.linspace(0, 1, fade, dtype=np.float32)
    w[-fade:] = np.linspace(1, 0, fade, dtype=np.float32)
    out = src.copy()
    out[a:b] = src[a:b] * (1 - w[:, None]) + new[a:b] * w[:, None]
    subtype = sf.info(source_path).subtype
    sf.write(repainted_path, out, sr, subtype=subtype if subtype in ("PCM_24", "PCM_32", "FLOAT") else "PCM_24")
    return True


def _submit(params: dict, endpoint: str) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "music", endpoint, params)
    if endpoint == "text2music":
        spawn_job(_run_yue2(job_id, params))
    else:
        spawn_job(_run_ace(job_id, endpoint, params))
    return {"job_id": job_id}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    status = _weights_status()
    return {
        "status": "ok",
        "engine": "yue2",
        "model_loaded": _pipe is not None,
        "model_variant": "YuE2-3B",
        "vram_mb": 8500 if _pipe is not None else 0,
        "stub": False,
        "model_dir": MODEL_REPO,
        "model_dir_ready": status["ok"],
        "model_dir_error": status["reason"],
        "capabilities": {"text2music": True, "instrumental": True,
                         "repaint": _ace_available(), "cover": _ace_available()},
    }


@app.post("/generate/text2music")
async def generate_text2music(p: Text2MusicParams) -> dict:
    return _submit(p.model_dump(), "text2music")


@app.post("/generate/cover")
async def generate_cover(p: CoverParams) -> dict:
    return _submit(p.model_dump(), "cover")


@app.post("/generate/repaint")
async def generate_repaint(p: RepaintParams) -> dict:
    return _submit(p.model_dump(), "repaint")


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    if jobs.get(job_id) is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.get("/files/{job_id}")
async def download_file(job_id: str) -> FileResponse:
    """Stream a finished job's audio, then remove it if this server owns it."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    output_path = job.get("output_path")
    if not output_path or not Path(output_path).is_file():
        raise HTTPException(status_code=404, detail="output file not available")

    def _cleanup():
        # Only reap files under server-output/; locally output_path IS the project asset.
        if not is_server_owned(output_path):
            return
        for p in (output_path, output_path + ".meta.json", output_path + ".score.abc"):
            Path(p).unlink(missing_ok=True)

    return FileResponse(output_path, media_type="audio/wav", filename=Path(output_path).name,
                        background=BackgroundTask(_cleanup))


@app.post("/load")
async def load() -> dict:
    err = await _ensure_model()
    return {"status": "error", "error": err} if err else {"status": "loaded"}


@app.post("/unload")
async def unload() -> dict:
    async with inference_lock():
        await asyncio.get_running_loop().run_in_executor(None, _do_unload)
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
