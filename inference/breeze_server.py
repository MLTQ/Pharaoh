"""
Pharaoh TTS Server (Breeze TTS 2) — port 18001

Drop-in replacement for tts_server.py (Qwen3-TTS) with the same endpoints, so
every caller keeps working, plus Breeze's strengths:

  /generate/voice_design   description → a new voice           (Breeze Voice Design)
  /generate/voice_clone    reference + transcript → that voice  (Voice Clone)
                           …with `instruct` → directed delivery (Voice Direction)
  /generate/direction      alias of voice_clone with instruct required
  /generate/custom_voice   Qwen's named presets ("Vivian"…): each is designed once
                           from its description, saved under presets/, then cloned
                           (+ directed by `instruct`) so a name keeps one voice

Paralinguistics: Pharaoh's `[laugh]`-style tags become Breeze vocal events
`(laugh)`. Direction is natural language ("Furious, voice rising"); its pull
is `cfg_scale` (docs recommend 4), or `cfg_ref` / `cfg_ins` to weigh sounding
like the reference against following the direction separately.

Guards (both from the model shootout):
  * reference transcript — Breeze conditions on the reference's exact words and
    garbles when they're wrong; the reference is transcribed (Whisper) and a
    mismatched or missing transcript is replaced.
  * takes — each take is transcribed; one that doesn't say the line is
    regenerated on a new seed (up to PHARAOH_BREEZE_TRIES).

Environment:
  PHARAOH_BREEZE_REPO       breeze-tts checkout          (~/pharaoh-models/breeze/breeze-tts)
  PHARAOH_BREEZE_MODEL_DIR  Breeze-TTS-2 weights         (~/pharaoh-models/breeze/breeze-tts-2)
  PHARAOH_BREEZE_ASR        Whisper model id, or "off"   (openai/whisper-small.en)
  PHARAOH_BREEZE_TRIES      takes per request            (3)
"""
import asyncio
import datetime
import json
import logging
import os
import re
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from _common import JobStore, is_server_owned, new_job_id, register_upload_route, remap_path, server_output_path, spawn_job

log = logging.getLogger(__name__)

PORT = int(os.environ.get("PHARAOH_TTS_PORT", 18001))
BREEZE_HOME = Path(os.environ.get("PHARAOH_BREEZE_HOME", "~/pharaoh-models/breeze")).expanduser()
REPO = Path(os.environ.get("PHARAOH_BREEZE_REPO", str(BREEZE_HOME / "breeze-tts"))).expanduser()
MODEL_DIR = Path(os.environ.get("PHARAOH_BREEZE_MODEL_DIR", str(BREEZE_HOME / "breeze-tts-2"))).expanduser()
PRESET_DIR = Path(os.environ.get("PHARAOH_BREEZE_PRESETS", str(BREEZE_HOME / "presets"))).expanduser()
ASR_MODEL = os.environ.get("PHARAOH_BREEZE_ASR", "openai/whisper-small.en")
TRIES = max(1, int(os.environ.get("PHARAOH_BREEZE_TRIES", "3")))
MAX_WER = float(os.environ.get("PHARAOH_BREEZE_MAX_WER", "0.25"))
GENERATION_TIMEOUT_S = int(os.environ.get("PHARAOH_TTS_TIMEOUT_S", "300"))
MODEL_VARIANT = "Breeze TTS 2"

app = FastAPI(title="Pharaoh TTS Server (Breeze)", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
register_upload_route(app)
jobs = JobStore()

# Qwen3-TTS's named speakers, kept so existing characters and the TTS panel
# work. Breeze has no presets: each is designed once from this description.
SPEAKERS = [
    {"id": "Vivian", "description": "A bright, slightly edgy young woman with a crisp, confident voice."},
    {"id": "Lili", "description": "A warm, gentle young woman with a soft, kind voice."},
    {"id": "Magnus", "description": "A seasoned man with a low, mellow, resonant voice."},
    {"id": "Jinchen", "description": "A youthful man with a clear, natural, friendly voice."},
    {"id": "Chengdu", "description": "A lively man with a slightly husky, energetic voice."},
    {"id": "Dynamic", "description": "A man with a strong, rhythmic, commanding delivery."},
    {"id": "Ryan", "description": "A sunny American man with a clear midrange voice."},
    {"id": "Japanese", "description": "A playful young woman with a light, nimble voice."},
    {"id": "Korean", "description": "A warm woman with a rich, emotional voice."},
]
LANGUAGES = ["en", "zh"]  # Breeze TTS 2 speaks English and Mandarin
PRESET_LINE = "The tide came in slowly that evening, and the harbour lights flickered on one by one."

# Pharaoh tags → Breeze vocal events. Documented: laugh, cough, clears throat,
# sigh; the rest are passed as events too and checked by the take guard.
VOCAL_EVENTS = {
    "laugh": "laugh", "laughs": "laugh", "laughing": "laugh", "chuckle": "laugh", "chuckles": "laugh",
    "giggle": "laugh", "sigh": "sigh", "sighs": "sigh", "cough": "cough", "coughs": "cough",
    "clears throat": "clears throat", "clear throat": "clears throat", "throat clear": "clears throat",
}

# ── Model state ──────────────────────────────────────────────────────────────

_rt = None  # dict(tok, model, atok, runtime)
_asr = None
_gen_lock = asyncio.Lock()  # one generation at a time on one GPU
_load_lock = asyncio.Lock()


def _load_breeze() -> dict:
    if not (MODEL_DIR / "config.json").is_file():
        raise FileNotFoundError(f"Breeze TTS 2 weights not found in {MODEL_DIR}. Run: ./inference/setup.sh breeze")
    if not (REPO / "breeze_infer").is_dir():
        raise FileNotFoundError(f"breeze-tts code not found in {REPO}. Run: ./inference/setup.sh breeze")
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from breeze_infer.runtime import load_runtime, resolve_device, update_generation_config_for_breeze
    from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig

    tok, model, atok = load_runtime(MODEL_DIR, device=resolve_device(), attn_implementation="eager")
    update_generation_config_for_breeze(model)
    runtime = FastBreezeStreamingRuntime(
        model, atok, FastStreamingConfig(max_new_tokens=1500, max_seq_len=2048, repetition_penalty=1.1), tokenizer=tok)
    log.info("Breeze TTS 2 loaded from %s", MODEL_DIR)
    return {"tok": tok, "model": model, "atok": atok, "runtime": runtime}


def _load_asr():
    if ASR_MODEL.lower() in ("", "off", "none", "0"):
        return None
    import torch
    from transformers import pipeline
    dev = 0 if torch.cuda.is_available() else -1
    log.info("Loading take checker %s", ASR_MODEL)
    return pipeline("automatic-speech-recognition", model=ASR_MODEL, device=dev)


async def _ensure_model() -> str | None:
    global _rt, _asr
    if _rt is not None:
        return None
    async with _load_lock:
        if _rt is not None:
            return None
        loop = asyncio.get_running_loop()
        try:
            _rt = await loop.run_in_executor(None, _load_breeze)
        except Exception as exc:
            log.exception("Breeze load failed")
            return f"Breeze TTS 2 failed to load: {exc}"
        try:
            _asr = await loop.run_in_executor(None, _load_asr)
        except Exception:
            log.warning("take checker unavailable; generating without it", exc_info=True)
            _asr = None
    return None


# ── Text helpers ─────────────────────────────────────────────────────────────

def to_vocal_events(text: str) -> str:
    """`[laugh]` / `(laughs)` → Breeze's `(laugh)`; other bracketed cues become events too."""
    def sub(m):
        key = m.group(1).strip().lower()
        return f"({VOCAL_EVENTS.get(key, key)})"
    return re.sub(r"\[([^\]]{1,40})\]", sub, text)


def spoken_words(text: str) -> str:
    """The words a listener should hear: no (events) or [tags]."""
    return re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", text)


def wer(ref: str, hyp: str) -> float:
    norm = lambda s: re.sub(r"[^a-z0-9' ]", " ", s.lower()).split()
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    return d[len(h)] / len(r)


def transcribe(path_or_audio, sr: int | None = None) -> str | None:
    if _asr is None:
        return None
    if isinstance(path_or_audio, str):
        out = _asr(path_or_audio)
    else:
        out = _asr({"raw": path_or_audio, "sampling_rate": sr})
    return (out.get("text") or "").strip()


# ── Generation ───────────────────────────────────────────────────────────────

def _synthesize(text: str, instruction: str | None, ref_audio: str | None, ref_text: str | None,
                seed: int, cfg_scale: float, cfg_ref: float | None, cfg_ins: float | None):
    import numpy as np
    from breeze_infer.runtime import set_all_seeds
    from breeze_infer.templates import get_template, prepare_inputs, select_template_name

    tok, model, atok, rt = _rt["tok"], _rt["model"], _rt["atok"], _rt["runtime"]
    req = {"id": f"r{seed}", "text": text, "speaker": "S0"}
    if instruction:
        req["instruction"] = instruction
    if ref_audio:
        req["ref_audio_path"], req["ref_text"] = ref_audio, ref_text
    template = get_template(select_template_name(req))
    dual = cfg_ref is not None and cfg_ins is not None and bool(instruction) and bool(ref_audio)
    set_all_seeds(seed)
    inputs = prepare_inputs(tok, atok, model, [req], template,
                            guidance_scale=cfg_scale,
                            guidance_scale_ref=cfg_ref if dual else None,
                            guidance_scale_ins=cfg_ins if dual else None)
    chunks = [c.audio for c in rt.iter_audio_chunks(inputs, request_id=req["id"], seed=seed)]
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype="float32"), rt.sample_rate


def _verify_reference(ref_audio: str, ref_text: str) -> tuple[str, bool]:
    """The reference's real words: a missing or mismatched transcript is replaced."""
    heard = transcribe(ref_audio)
    if heard and (not ref_text.strip() or wer(ref_text, heard) > 0.3):
        log.info("reference transcript replaced (was %r)", ref_text[:60])
        return heard, True
    return ref_text, False


def _write_sidecar(path: str, meta: dict) -> None:
    sidecar = {**meta, "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "parent": meta.get("parent"), "take_index": 1, "qa_status": "unreviewed", "qa_notes": ""}
    try:
        Path(path + ".meta.json").write_text(json.dumps(sidecar, indent=2))
    except Exception as exc:
        log.warning("sidecar for %s: %s", path, exc)


async def _preset_reference(speaker: str) -> tuple[str, str]:
    """A named preset's reference clip, designed once from its description."""
    import soundfile as sf
    PRESET_DIR.mkdir(parents=True, exist_ok=True)
    wav = PRESET_DIR / f"{re.sub(r'[^A-Za-z0-9_-]', '_', speaker)}.wav"
    if not wav.is_file():
        desc = next((s["description"] for s in SPEAKERS if s["id"].lower() == speaker.lower()),
                    f"A clear, natural voice named {speaker}.")
        loop = asyncio.get_running_loop()
        audio, sr = await loop.run_in_executor(None, lambda: _synthesize(
            PRESET_LINE, desc + " Calm, neutral, conversational delivery.", None, None, 7, 4.0, None, None))
        sf.write(str(wav), audio, sr)
    return str(wav), PRESET_LINE


async def _run(job_id: str, p: dict) -> None:
    import soundfile as sf
    jobs.update(job_id, status="running", progress=0.02, message="Loading Breeze TTS 2")
    err = await _ensure_model()
    if err:
        jobs.update(job_id, status="failed", error=err)
        return
    endpoint = p["_endpoint"]
    out_path = remap_path(p.get("output_path")) or server_output_path(job_id)
    text = to_vocal_events(p["text"])
    instruction = (p.get("instruct") or p.get("voice_description") or "").strip() or None
    ref_audio = remap_path(p.get("ref_audio_path")) or p.get("ref_audio_path") or None
    ref_text = p.get("ref_transcript") or ""
    seed = int(p.get("seed") or 0) or 42
    cfg = float(p.get("cfg_scale") or (4.0 if instruction else 1.0))
    loop = asyncio.get_running_loop()
    meta = {"model": f"breeze-tts-2-{endpoint}", "model_variant": MODEL_VARIANT, "prompt": p["text"],
            "instruct": instruction, "speaker": p.get("speaker"), "language": p.get("language", "en"),
            "cfg_scale": cfg}
    try:
        async with _gen_lock:
            if endpoint == "custom_voice":
                ref_audio, ref_text = await _preset_reference(p.get("speaker") or "Vivian")
            if endpoint == "voice_design":
                ref_audio = None
            elif ref_audio:
                if not Path(ref_audio).is_file():
                    raise FileNotFoundError(f"reference audio not found: {ref_audio}")
                jobs.update(job_id, progress=0.1, message="Checking the reference")
                ref_text, corrected = await loop.run_in_executor(None, lambda: _verify_reference(ref_audio, ref_text))
                if not ref_text.strip():
                    raise ValueError("the reference clip needs a transcript (and no checker is available to make one)")
                meta["ref_transcript"] = ref_text
                meta["ref_transcript_corrected"] = corrected
                meta["parent"] = p.get("ref_audio_path")
            want = spoken_words(p["text"])
            best = None
            for k in range(TRIES):
                s = seed + k * 1009
                jobs.update(job_id, progress=0.15 + 0.7 * k / TRIES,
                            message="Generating" if k == 0 else f"Retaking (take {k + 1} of {TRIES})")
                fut = loop.run_in_executor(None, lambda s=s: _synthesize(
                    text, instruction, ref_audio, ref_text, s, cfg, p.get("cfg_ref"), p.get("cfg_ins")))
                audio, sr = await asyncio.wait_for(fut, timeout=GENERATION_TIMEOUT_S)
                heard = await loop.run_in_executor(None, lambda: transcribe(audio, sr))
                score = wer(want, heard) if heard is not None else 0.0
                if best is None or score < best[2]:
                    best = (audio, sr, score, s, heard)
                if heard is None or score <= MAX_WER:
                    break
            audio, sr, score, s, heard = best
        jobs.update(job_id, progress=0.92, message="Saving")
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        await loop.run_in_executor(None, lambda: sf.write(out_path, audio, sr))
        _write_sidecar(out_path, {**meta, "seed": s, "sample_rate": sr,
                                  "duration_actual_ms": int(len(audio) / sr * 1000),
                                  "heard": heard, "wer": None if heard is None else round(score, 3)})
        jobs.update(job_id, status="complete", progress=1.0, output_path=out_path,
                    message="Done" if heard is None or score <= MAX_WER else f"Done (best of {TRIES}; still {score:.0%} off the script)")
    except Exception as exc:
        log.exception("Breeze generation failed")
        jobs.update(job_id, status="failed", error=f"{type(exc).__name__}: {exc}")


def _submit(params: dict) -> dict:
    job_id = new_job_id()
    jobs.create(job_id, "tts", params["_endpoint"], params)
    spawn_job(_run(job_id, params))
    return {"job_id": job_id}


# ── Request models ───────────────────────────────────────────────────────────

class _Common(BaseModel):
    text: str
    language: str = "en"
    seed: int = 0
    temperature: float = 0.7  # accepted for compatibility; Breeze samples with its own settings
    top_p: float = 0.9
    max_new_tokens: int = 2048
    output_path: str = ""
    cfg_scale: float | None = None
    cfg_ref: float | None = None
    cfg_ins: float | None = None


class CustomVoiceParams(_Common):
    speaker: str = "Vivian"
    instruct: str = ""


class VoiceDesignParams(_Common):
    voice_description: str


class VoiceCloneParams(_Common):
    ref_audio_path: str
    ref_transcript: str = ""
    instruct: str = ""
    icl_mode: bool = False  # Qwen-only; ignored


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "model_loaded": _rt is not None, "model_variant": MODEL_VARIANT,
            "engine": "breeze", "loaded_types": ["breeze"] if _rt else [],
            "take_checker": ASR_MODEL if _asr is not None else (None if _rt is None else "off"),
            "vram_mb": 8000 if _rt else 0, "stub": False,
            "weights_found": (MODEL_DIR / "config.json").is_file(), "code_found": (REPO / "breeze_infer").is_dir(),
            "capabilities": ["voice_design", "voice_clone", "direction", "custom_voice", "vocal_events"]}


@app.get("/speakers")
async def speakers() -> list:
    return SPEAKERS


@app.get("/languages")
async def languages() -> list:
    return LANGUAGES


@app.post("/generate/custom_voice")
async def generate_custom_voice(p: CustomVoiceParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "custom_voice"})


@app.post("/generate/voice_design")
async def generate_voice_design(p: VoiceDesignParams) -> dict:
    if not p.voice_description.strip():
        raise HTTPException(status_code=400, detail="voice_description is required")
    return _submit({**p.model_dump(), "_endpoint": "voice_design"})


@app.post("/generate/voice_clone")
async def generate_voice_clone(p: VoiceCloneParams) -> dict:
    return _submit({**p.model_dump(), "_endpoint": "voice_clone" if not p.instruct.strip() else "direction"})


@app.post("/generate/direction")
async def generate_direction(p: VoiceCloneParams) -> dict:
    if not p.instruct.strip():
        raise HTTPException(status_code=400, detail="direction needs an instruct ('Furious, voice rising…')")
    return _submit({**p.model_dump(), "_endpoint": "direction"})


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    if jobs.get(job_id) is None:
        raise HTTPException(status_code=404, detail="job not found")
    return jobs.response(job_id)


@app.get("/files/{job_id}")
async def download_file(job_id: str) -> FileResponse:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    out = job.get("output_path")
    if not out or not Path(out).is_file():
        raise HTTPException(status_code=404, detail="output file not available")

    def _cleanup():
        if is_server_owned(out):
            for f in (out, out + ".meta.json"):
                Path(f).unlink(missing_ok=True)

    return FileResponse(out, media_type="audio/wav", filename=Path(out).name, background=BackgroundTask(_cleanup))


@app.post("/load")
async def load() -> dict:
    err = await _ensure_model()
    return {"status": "error", "error": err} if err else {"status": "loaded", "loaded_types": ["breeze"]}


@app.post("/unload")
async def unload() -> dict:
    global _rt, _asr
    async with _gen_lock:
        _rt, _asr = None, None
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    return {"status": "unloaded", "loaded_types": []}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
