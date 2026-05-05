"""
Pharaoh SFX Server — port 18002
Wraps Woosh (Sony AI) plus optional AudioLDM long-form generation.
Requires: ~/Code/Woosh uv venv with woosh package.

Model directory: PHARAOH_WOOSH_DIR (default ~/Code/Woosh)
"""
import asyncio
import shutil
import logging
import math
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from _common import JobStore, new_job_id

log = logging.getLogger(__name__)

PORT          = int(os.environ.get("PHARAOH_SFX_PORT",    18002))
MODEL_VARIANT = os.environ.get("PHARAOH_SFX_VARIANT",  "Woosh-DFlow")
WOOSH_DIR   = Path(os.environ.get("PHARAOH_WOOSH_DIR",  "")).expanduser()
AUDIO_LDM_MODEL_ID = "cvssp/audioldm-s-full-v2"
AUDIO_LDM_LOCAL_DIR = Path(
    os.environ.get("PHARAOH_AUDIOLDM_MODEL_DIR", "~/pharaoh-models/sfx/audioldm-s-full-v2")
).expanduser()
AUDIO_LDM_MODEL = os.environ.get(
    "PHARAOH_AUDIOLDM_MODEL",
    str(AUDIO_LDM_LOCAL_DIR) if AUDIO_LDM_LOCAL_DIR.exists() else AUDIO_LDM_MODEL_ID,
)
AUDIOLDM_NATIVE_MODEL = os.environ.get("PHARAOH_AUDIOLDM_NATIVE_MODEL", "audioldm-m-full")
AUDIOLDM_PYTHON = Path(
    os.environ.get("PHARAOH_AUDIOLDM_PYTHON", Path(__file__).parent / ".venv-audioldm/bin/python3")
).expanduser()
AUDIOLDM_ENGINE = os.environ.get("PHARAOH_AUDIOLDM_ENGINE", "native").lower()
_native_audioldm_cuda_available: bool | None = None

SAMPLE_RATE   = 48000
AUDIO_LDM_SAMPLE_RATE = 16000
LATENT_CHANS  = 128
FRAMES_PER_S  = 100.2   # empirical: 501 latent frames ≈ 5 s

app = FastAPI(title="Pharaoh SFX Server", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
jobs = JobStore()
_model_loaded = False

# ── Woosh model state ────────────────────────────────────────────────────────

_ldm    = None   # FlowMapFromPretrained instance
_device = None   # "cuda" | "mps" | "cpu"
_load_lock = asyncio.Lock()  # serialize load attempts; auto-load on first generate
_audioldm_pipe = None
_audioldm_loaded_model_id = None
_audioldm_device = None
_audioldm_load_lock = asyncio.Lock()

OOM_MARKER = "SFX_OOM"  # FE matches this prefix to surface a memory toast


def _woosh_status() -> dict:
    """Return a dict describing whether WOOSH_DIR looks usable."""
    if not WOOSH_DIR or not WOOSH_DIR.is_dir():
        return {"ok": False, "reason": f"PHARAOH_WOOSH_DIR not set or not found: '{WOOSH_DIR}'"}
    required = ["checkpoints/Woosh-AE", "checkpoints/TextConditionerA", f"checkpoints/{MODEL_VARIANT}"]
    missing = [r for r in required if not (WOOSH_DIR / r).exists()]
    if missing:
        return {"ok": False, "reason": f"Missing checkpoints: {', '.join(missing)}"}
    return {"ok": True, "reason": ""}


def _resolve_device() -> str:
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load_sfx_model() -> None:
    """Load Woosh model synchronously (run via executor so we don't block event loop).

    Woosh resolves nested checkpoint paths (e.g. autoencoder = 'checkpoints/Woosh-AE')
    relative to the current working directory, so we chdir into WOOSH_DIR for the
    duration of the load and restore CWD afterwards.
    """
    global _ldm, _device
    import sys

    # Ensure the Woosh repo is importable
    woosh_src = str(WOOSH_DIR)
    if woosh_src not in sys.path:
        sys.path.insert(0, woosh_src)

    from woosh.components.base import LoadConfig
    from woosh.model.flowmap_from_pretrained import FlowMapFromPretrained

    _device = _resolve_device()
    ckpt = str(WOOSH_DIR / "checkpoints" / MODEL_VARIANT)
    log.info(f"Loading Woosh model from {ckpt} on {_device}")
    prev_cwd = os.getcwd()
    try:
        os.chdir(WOOSH_DIR)
        _ldm = FlowMapFromPretrained(LoadConfig(path=ckpt))
        _ldm = _ldm.eval().to(_device)
    finally:
        os.chdir(prev_cwd)
    log.info("Woosh model loaded.")


def _is_memory_error(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in ("OutOfMemoryError", "MemoryError"):
        return True
    msg = str(exc).lower()
    return any(s in msg for s in (
        "out of memory", "cuda oom", "mps backend out of memory",
        "cannot allocate", "memory allocation",
    ))


async def _ensure_model() -> str | None:
    """Make sure the Woosh model is loaded. Returns an error string on failure
    (prefixed with OOM_MARKER for memory-related failures), else None."""
    global _model_loaded
    if _ldm is not None:
        return None

    ws = _woosh_status()
    if not ws["ok"]:
        return ws["reason"]

    async with _load_lock:
        if _ldm is not None:
            return None
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _load_sfx_model)
        except Exception as exc:
            log.exception("Failed to auto-load Woosh model")
            if _is_memory_error(exc):
                return f"{OOM_MARKER}: Not enough memory to load Woosh. Free a model in the model manager and retry."
            return f"Auto-load failed: {exc}"
        _model_loaded = True
    return None


# ── Request models ──────────────────────────────────────────────────────────

class T2AParams(BaseModel):
    prompt: str
    duration_seconds: float = 3.0
    model_variant: str = "Woosh-DFlow"
    backend: str = "woosh"
    steps: int = 4
    seed: int = 0
    guidance_scale: float = 2.5
    negative_prompt: str = ""
    num_waveforms_per_prompt: int = 3
    output_path: str


class V2AParams(BaseModel):
    video_path: str
    prompt_override: str = ""
    model_variant: str = "Woosh-DVFlow"
    steps: int = 4
    seed: int = 0
    output_path: str


class LoadParams(BaseModel):
    variant: Optional[str] = None


# ── Background workers ───────────────────────────────────────────────────────

def _is_audioldm_request(params: dict) -> bool:
    backend = str(params.get("backend", "")).lower()
    variant = str(params.get("model_variant", "")).lower()
    return backend == "audioldm" or variant.startswith("audioldm")


def _audioldm_status() -> dict:
    if AUDIOLDM_ENGINE == "native":
        cli = _native_audioldm_cli()
        if not AUDIOLDM_PYTHON.exists():
            return {
                "ok": False,
                "reason": (
                    f"AudioLDM venv not found at {AUDIOLDM_PYTHON}. "
                    "Run: PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh"
                ),
            }
        if not cli.exists():
            return {
                "ok": False,
                "reason": (
                    f"AudioLDM CLI not found at {cli}. "
                    "Run: PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh"
                ),
            }
        return {"ok": True, "reason": ""}

    try:
        import diffusers  # noqa: F401
        import scipy  # noqa: F401
        import transformers  # noqa: F401
    except Exception as exc:
        return {
            "ok": False,
            "reason": (
                "AudioLDM optional deps missing. Run: "
                "PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh "
                f"({exc})"
            ),
        }
    return {"ok": True, "reason": ""}


def _native_audioldm_cli() -> Path:
    suffix = "Scripts/audioldm.exe" if sys.platform == "win32" else "bin/audioldm"
    return AUDIOLDM_PYTHON.parent.parent / suffix


def _native_audioldm_has_cuda() -> bool:
    """Return whether the isolated native AudioLDM torch build can use CUDA."""
    global _native_audioldm_cuda_available
    if _native_audioldm_cuda_available is not None:
        return _native_audioldm_cuda_available

    if not AUDIOLDM_PYTHON.exists():
        _native_audioldm_cuda_available = False
        return False

    try:
        import subprocess

        result = subprocess.run(
            [str(AUDIOLDM_PYTHON), "-c", "import torch; print(int(torch.cuda.is_available()))"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        _native_audioldm_cuda_available = result.stdout.strip().endswith("1")
    except Exception:
        log.exception("Failed to detect native AudioLDM CUDA support")
        _native_audioldm_cuda_available = False
    return _native_audioldm_cuda_available


async def _pump_subprocess_stream(stream, label: str, buffer: list[str]) -> None:
    """Forward subprocess output to logs while retaining tail text for errors."""
    if stream is None:
        return
    while True:
        chunk = await stream.read(1024)
        if not chunk:
            break
        text = chunk.decode(errors="replace").replace("\r", "\n").strip()
        if not text:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            buffer.append(line)
            del buffer[:-80]
            log.info("AudioLDM %s: %s", label, line)


def _resolve_audioldm_model_id(params: dict | None = None) -> str:
    raw = str((params or {}).get("model_variant") or AUDIO_LDM_MODEL)
    aliases = {
        "AudioLDM-S-Full-V2": AUDIO_LDM_MODEL,
        "audioldm-s-full-v2": AUDIO_LDM_MODEL,
        "AudioLDM-M-Full": "cvssp/audioldm-m-full",
        "audioldm-m-full": "cvssp/audioldm-m-full",
        "AudioLDM-L-Full": "cvssp/audioldm-l-full",
        "audioldm-l-full": "cvssp/audioldm-l-full",
    }
    return aliases.get(raw, raw)


def _native_audioldm_model_name(params: dict | None = None) -> str:
    raw = str((params or {}).get("model_variant") or AUDIOLDM_NATIVE_MODEL)
    aliases = {
        "AudioLDM-M-Full": "audioldm-m-full",
        "audioldm-m-full": "audioldm-m-full",
        "AudioLDM-S-Full-V2": "audioldm-s-full-v2",
        "audioldm-s-full-v2": "audioldm-s-full-v2",
        "AudioLDM-S-Full": "audioldm-s-full",
        "audioldm-s-full": "audioldm-s-full",
        "AudioLDM-L-Full": "audioldm-l-full",
        "audioldm-l-full": "audioldm-l-full",
        "AudioLDM-M-Text-FT": "audioldm-m-text-ft",
        "audioldm-m-text-ft": "audioldm-m-text-ft",
        "AudioLDM-S-Text-FT": "audioldm-s-text-ft",
        "audioldm-s-text-ft": "audioldm-s-text-ft",
    }
    return aliases.get(raw, AUDIOLDM_NATIVE_MODEL)


def _load_audioldm_model(model_id: str) -> None:
    global _audioldm_pipe, _audioldm_loaded_model_id, _audioldm_device
    import torch
    from diffusers import AudioLDMPipeline

    _audioldm_device = _resolve_device()
    dtype = torch.float16 if _audioldm_device == "cuda" else torch.float32
    log.info(f"Loading AudioLDM model {model_id} on {_audioldm_device}")
    pipe = AudioLDMPipeline.from_pretrained(model_id, torch_dtype=dtype)
    if _audioldm_device == "cuda":
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(_audioldm_device)
    _audioldm_pipe = pipe
    _audioldm_loaded_model_id = model_id
    log.info("AudioLDM model loaded.")


async def _ensure_audioldm_model(params: dict | None = None) -> str | None:
    if AUDIOLDM_ENGINE == "native":
        status = _audioldm_status()
        return None if status["ok"] else status["reason"]

    model_id = _resolve_audioldm_model_id(params)
    if _audioldm_pipe is not None and _audioldm_loaded_model_id == model_id:
        return None

    status = _audioldm_status()
    if not status["ok"]:
        return status["reason"]

    async with _audioldm_load_lock:
        if _audioldm_pipe is not None and _audioldm_loaded_model_id == model_id:
            return None
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, lambda: _load_audioldm_model(model_id))
        except Exception as exc:
            log.exception("Failed to auto-load AudioLDM model")
            if _is_memory_error(exc):
                return f"{OOM_MARKER}: Not enough memory to load AudioLDM. Free a model in the model manager and retry."
            return f"AudioLDM auto-load failed: {exc}"
    return None


def _prepare_audioldm_prompt(prompt: str) -> str:
    """Convert Pharaoh's structured director text into AudioLDM-friendly prose."""
    prompt = re.sub(r"\[([^\]:]+):\s*([^\]]+)\]", r"\2.", prompt)
    prompt = re.sub(r"\[[^\]]+\]", " ", prompt)
    prompt = re.sub(r"\s+", " ", prompt.replace("\n", ". ")).strip(" .")
    prompt = re.sub(r"\.{2,}", ".", prompt).strip(" .")
    if len(prompt) > 120:
        prompt = prompt[:120].rsplit(" ", 1)[0].strip(" .,")
    if not prompt:
        prompt = "natural environmental ambience"
    return prompt


def _native_audioldm_cli_text(prompt: str) -> str:
    """Keep prompt useful but short because upstream AudioLDM uses it as a filename."""
    prompt = re.sub(r"[^A-Za-z0-9 ,.'-]+", " ", prompt)
    prompt = re.sub(r"\s+", " ", prompt).strip(" .,")
    if len(prompt) > 80:
        prompt = prompt[:80].rsplit(" ", 1)[0].strip(" .,")
    return prompt or "natural ambience"


def _native_audioldm_duration(seconds: float) -> float:
    """Native AudioLDM requires duration to be a multiple of 2.5 seconds."""
    return max(2.5, math.ceil(seconds / 2.5) * 2.5)


def _select_audioldm_candidate(audios) -> object:
    """Pick the least-empty candidate when AudioLDM returns several waveforms."""
    import numpy as np

    candidates = list(audios)
    if not candidates:
        raise ValueError("AudioLDM returned no audio candidates")

    def score(audio) -> float:
        arr = np.asarray(audio, dtype=np.float32)
        rms = float(np.sqrt(np.mean(np.square(arr)))) if arr.size else 0.0
        peak = float(np.max(np.abs(arr))) if arr.size else 0.0
        return rms - max(0.0, peak - 0.98)

    return max(candidates, key=score)


async def _run_sfx(job_id: str, params: dict) -> None:
    if _is_audioldm_request(params):
        await _run_audioldm_sfx(job_id, params)
    else:
        await _run_woosh_sfx(job_id, params)


async def _run_woosh_sfx(job_id: str, params: dict) -> None:
    global _ldm, _device

    jobs.update(job_id, status="running", progress=0.02)

    # Auto-load on first generate — matches TTS behavior
    err = await _ensure_model()
    if err:
        log.warning(f"Job {job_id} failed: {err}")
        jobs.update(job_id, status="failed", error=err)
        return

    jobs.update(job_id, progress=0.05)
    try:
        import sys
        import torch
        import torchaudio

        woosh_src = str(WOOSH_DIR)
        if woosh_src not in sys.path:
            sys.path.insert(0, woosh_src)
        from woosh.inference.flowmap_sampler import sample_euler

        prompt   = params["prompt"]
        steps    = int(params.get("steps", 4))
        seed     = int(params.get("seed", 0))
        duration = float(params.get("duration_seconds", 3.0))
        out_path = params["output_path"]

        torch.manual_seed(seed)

        latent_frames = max(50, round(duration * FRAMES_PER_S))
        noise = torch.randn(1, LATENT_CHANS, latent_frames).to(_device)

        jobs.update(job_id, progress=0.15)

        cond = _ldm.get_cond(
            {"audio": None, "description": [prompt]},
            no_dropout=True,
            device=_device,
        )

        jobs.update(job_id, progress=0.25)

        # Build renoise schedule (first element is always 0)
        if steps == 4:
            renoise = [0, 0.5, 0.5, 0.3]
        else:
            # Linearly interpolate a schedule
            renoise = [0] + [0.5 * (1 - i / (steps - 1)) for i in range(1, steps)]

        loop = asyncio.get_event_loop()

        def _infer():
            with torch.inference_mode():
                x = sample_euler(
                    model=_ldm,
                    noise=noise,
                    cond=cond,
                    num_steps=steps,
                    renoise=renoise,
                    cfg=4.5,
                )
                return _ldm.autoencoder.inverse(x)

        audio = await loop.run_in_executor(None, _infer)

        jobs.update(job_id, progress=0.85)

        audio = audio.cpu().float()
        peak = audio.abs().amax(dim=-1, keepdim=True).clamp(min=1.0)
        audio = audio / peak

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        await loop.run_in_executor(None, lambda: torchaudio.save(out_path, audio[0], sample_rate=SAMPLE_RATE))

        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path)

    except Exception as exc:
        log.exception("Woosh inference failed")
        jobs.update(job_id, status="failed", error=str(exc))


async def _run_audioldm_sfx(job_id: str, params: dict) -> None:
    if AUDIOLDM_ENGINE == "native":
        await _run_native_audioldm_sfx(job_id, params)
    else:
        await _run_diffusers_audioldm_sfx(job_id, params)


async def _run_native_audioldm_sfx(job_id: str, params: dict) -> None:
    jobs.update(job_id, status="running", progress=0.02)

    err = await _ensure_audioldm_model(params)
    if err:
        log.warning(f"Job {job_id} failed: {err}")
        jobs.update(job_id, status="failed", error=err)
        return

    jobs.update(job_id, progress=0.08)
    try:
        prompt = _native_audioldm_cli_text(_prepare_audioldm_prompt(params["prompt"]))
        duration = _native_audioldm_duration(float(params.get("duration_seconds", 30.0)))
        steps = int(params.get("steps", 200))
        seed = int(params.get("seed", 0))
        guidance_scale = float(params.get("guidance_scale", 2.5))
        waveforms = int(params.get("num_waveforms_per_prompt", 3))
        if waveforms > 1 and not _native_audioldm_has_cuda():
            log.warning(
                "Native AudioLDM candidate ranking requires CUDA; forcing -n 1 on this platform."
            )
            waveforms = 1
        out_path = Path(params["output_path"])
        cli = _native_audioldm_cli()
        model_name = _native_audioldm_model_name(params)

        with tempfile.TemporaryDirectory(prefix="pharaoh-audioldm-") as tmp:
            cmd = [
                str(cli),
                "-t", prompt,
                "-s", tmp,
                "--model_name", model_name,
                "--ddim_steps", str(steps),
                "-gs", str(guidance_scale),
                "-dur", str(duration),
                "-n", str(max(1, waveforms)),
                "--seed", str(seed),
            ]
            log.info("Running native AudioLDM: %s", " ".join(cmd))
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            output_tail: list[str] = []
            stdout_task = asyncio.create_task(_pump_subprocess_stream(proc.stdout, "stdout", output_tail))
            stderr_task = asyncio.create_task(_pump_subprocess_stream(proc.stderr, "stderr", output_tail))
            wait_task = asyncio.create_task(proc.wait())

            progress = 0.10
            while not wait_task.done():
                await asyncio.sleep(1.0)
                progress = min(progress + 0.01, 0.92)
                jobs.update(job_id, progress=progress)
                log.info("AudioLDM job %s still running (progress %.0f%%)", job_id, progress * 100)

            returncode = await wait_task
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            jobs.update(job_id, progress=0.94)

            if returncode != 0:
                msg = "\n".join(output_tail)[-4000:]
                raise RuntimeError(f"native AudioLDM failed with exit {returncode}: {msg}")

            candidates = sorted(Path(tmp).rglob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not candidates:
                msg = "\n".join(output_tail)[-4000:]
                raise RuntimeError(f"native AudioLDM completed without a WAV output. Output: {msg}")

            out_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(candidates[0], out_path)
            log.info("Native AudioLDM wrote %s from %s", out_path, candidates[0])

        jobs.update(job_id, status="complete", progress=1.0, output_path=str(out_path))

    except Exception as exc:
        log.exception("Native AudioLDM inference failed")
        jobs.update(job_id, status="failed", error=str(exc))


async def _run_diffusers_audioldm_sfx(job_id: str, params: dict) -> None:
    jobs.update(job_id, status="running", progress=0.02)
    err = await _ensure_audioldm_model(params)
    if err:
        log.warning(f"Job {job_id} failed: {err}")
        jobs.update(job_id, status="failed", error=err)
        return

    jobs.update(job_id, progress=0.08)
    try:
        import numpy as np
        import scipy.io.wavfile
        import torch

        prompt = _prepare_audioldm_prompt(params["prompt"])
        duration = float(params.get("duration_seconds", 30.0))
        steps = int(params.get("steps", 200))
        seed = int(params.get("seed", 0))
        guidance_scale = float(params.get("guidance_scale", 2.5))
        negative_prompt = str(params.get("negative_prompt", ""))
        waveforms = int(params.get("num_waveforms_per_prompt", 3))
        out_path = params["output_path"]

        generator_device = "cuda" if _audioldm_device == "cuda" else "cpu"
        generator = torch.Generator(generator_device).manual_seed(seed)
        loop = asyncio.get_event_loop()

        def _infer():
            with torch.inference_mode():
                result = _audioldm_pipe(
                    prompt,
                    audio_length_in_s=duration,
                    num_inference_steps=steps,
                    guidance_scale=guidance_scale,
                    negative_prompt=negative_prompt or None,
                    num_waveforms_per_prompt=max(1, waveforms),
                    generator=generator,
                )
                return _select_audioldm_candidate(result.audios)

        audio = await loop.run_in_executor(None, _infer)
        jobs.update(job_id, progress=0.9)

        audio = np.asarray(audio, dtype=np.float32)
        peak = max(float(np.max(np.abs(audio))), 1.0)
        audio = audio / peak
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        scipy.io.wavfile.write(out_path, AUDIO_LDM_SAMPLE_RATE, pcm)
        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path)

    except Exception as exc:
        log.exception("AudioLDM inference failed")
        jobs.update(job_id, status="failed", error=str(exc))


def _submit(params: dict) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "sfx", params.get("_endpoint", "t2a"), params)
    asyncio.create_task(_run_sfx(job_id, params))
    return {"job_id": job_id}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    ws = _woosh_status()
    als = _audioldm_status()
    return {
        "status": "ok",
        "model_loaded": _model_loaded or _audioldm_pipe is not None or (AUDIOLDM_ENGINE == "native" and als["ok"]),
        "model_variant": MODEL_VARIANT,
        "vram_mb": 2048 if _model_loaded else 0,
        "stub": False,
        "woosh_dir": str(WOOSH_DIR),
        "woosh_ready": ws["ok"],
        "woosh_error": ws["reason"],
        "audioldm_ready": als["ok"],
        "audioldm_error": als["reason"],
        "audioldm_model": _audioldm_loaded_model_id or (AUDIOLDM_NATIVE_MODEL if AUDIOLDM_ENGINE == "native" else AUDIO_LDM_MODEL),
        "audioldm_local_dir": str(AUDIO_LDM_LOCAL_DIR),
        "audioldm_engine": AUDIOLDM_ENGINE,
        "audioldm_cuda": _native_audioldm_has_cuda() if AUDIOLDM_ENGINE == "native" and als["ok"] else None,
        "audioldm_loaded": _audioldm_pipe is not None or (AUDIOLDM_ENGINE == "native" and als["ok"]),
    }


@app.post("/generate/t2a")
async def generate_t2a(p: T2AParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "t2a"})


@app.post("/generate/v2a")
async def generate_v2a(p: V2AParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "v2a"})


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.post("/load")
async def load(params: Optional[LoadParams] = None) -> dict:
    global _model_loaded
    variant = params.variant if params else None
    if variant and variant.lower().startswith("audioldm"):
        err = await _ensure_audioldm_model({"model_variant": variant})
        if err:
            return {"status": "error", "error": err}
        if AUDIOLDM_ENGINE == "native":
            return {"status": "loaded", "backend": "audioldm", "engine": "native", "model": _native_audioldm_model_name({"model_variant": variant})}
        return {"status": "loaded", "backend": "audioldm", "model": _audioldm_loaded_model_id}

    ws = _woosh_status()
    if not ws["ok"]:
        return {"status": "error", "error": ws["reason"]}

    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _load_sfx_model)
    except Exception as exc:
        log.exception("Failed to load Woosh model")
        return {"status": "error", "error": str(exc)}

    _model_loaded = True
    return {"status": "loaded", "woosh_dir": str(WOOSH_DIR)}


@app.post("/unload")
async def unload() -> dict:
    global _model_loaded, _ldm, _audioldm_pipe, _audioldm_loaded_model_id
    _model_loaded = False
    _ldm = None
    _audioldm_pipe = None
    _audioldm_loaded_model_id = None
    return {"status": "unloaded"}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
