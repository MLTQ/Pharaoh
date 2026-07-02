"""
MCP tools: local audio post-processing (ffmpeg) and AudioSR upscaling.

import/trim/fade/normalize/resample all shell out to a local ffmpeg binary
and write sidecar-linked child WAVs next to the input; upscale_audio is the
one exception — it proxies to the post inference server. Importing this
module registers the tools against the shared FastMCP instance from
server.py.
"""
import json
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from projectfs import _project_dir, _read_meta, _write_meta
from remote import _post
from server import mcp


def _run_ffmpeg(args: list[str]) -> tuple[bool, str]:
    """Run ffmpeg with the given args. Returns (success, error_message)."""
    try:
        result = subprocess.run(
            ["ffmpeg"] + args,
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            return False, result.stderr[-2000:] if result.stderr else "ffmpeg failed"
        return True, ""
    except FileNotFoundError:
        return False, "ffmpeg not found — install ffmpeg and ensure it is in PATH"
    except subprocess.TimeoutExpired:
        return False, "ffmpeg timed out after 300s"


def _wav_duration_ms(path: str) -> int | None:
    """Return duration in milliseconds by reading the WAV header, or None."""
    try:
        import wave
        with wave.open(path, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            if rate > 0:
                return int(frames * 1000 / rate)
    except Exception:
        pass
    return None


@mcp.tool()
def import_audio(
    project_id: str,
    source_path: str,
    label: str = "",
) -> str:
    """
    Import an arbitrary audio file into a project as a sidecar-indexed WAV.
    Converts to 48 kHz mono WAV via ffmpeg and writes it to
    scenes/__imports/assets/ with a full sidecar.
    Useful for bringing in reference recordings, foley, or licensed music.
    Returns the path of the imported WAV.
    """
    source = Path(source_path)
    if not source.exists():
        return json.dumps({"error": (
            f"source audio not found: {source_path} — "
            f"pass the absolute path of an existing audio file"
        )})

    stem = re.sub(r"[^a-z0-9_\-]", "_", (label or source.stem).lower()).strip("_") or "audio"
    imports_dir = _project_dir(project_id) / "scenes" / "__imports" / "assets"
    imports_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    output = str(imports_dir / f"{stem}.import.{ts}.wav")

    ok, err = _run_ffmpeg(["-y", "-i", source_path, "-ar", "48000", "-ac", "1", output])
    if not ok:
        return json.dumps({"error": f"ffmpeg failed importing {source_path}: {err}"})

    duration_ms = _wav_duration_ms(output)
    _write_meta(output, {
        "model": "tts-reference-import",
        "model_variant": "ffmpeg-import",
        "prompt": f"Imported reference recording: {label or source.stem}",
        "instruct": f"source={source_path}",
        "seed": 0,
        "duration_actual_ms": duration_ms,
        "sample_rate": 48000,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "parent": source_path,
        "take_index": 0,
        "qa_status": "unreviewed",
        "qa_notes": "",
    })
    return json.dumps({"ok": True, "output_path": output, "duration_ms": duration_ms})


@mcp.tool()
def process_clip(
    audio_path: str,
    start_ms: int = 0,
    end_ms: int = 0,
    gain_db: float = 0.0,
    fade_in_ms: int = 0,
    fade_out_ms: int = 0,
    normalize_lufs: float = 0.0,
    highpass_hz: int = 0,
    lowpass_hz: int = 0,
) -> str:
    """
    Non-destructively trim, fade, and filter a WAV via ffmpeg.
    Output is written to {stem}.clip.{timestamp}.wav next to the original.
    A child sidecar is written linking back to the parent.

    start_ms / end_ms: clip window (0 = no trim at that end)
    gain_db: volume adjustment in dB (0 = no change)
    fade_in_ms / fade_out_ms: linear fade lengths
    normalize_lufs: target LUFS for loudnorm (0 = skip; typical values: -16, -23)
    highpass_hz / lowpass_hz: EQ shelf cutoffs (0 = skip)
    """
    if not Path(audio_path).exists():
        return json.dumps({"error": (
            f"audio file not found: {audio_path} — "
            f"pass the absolute path of an existing WAV"
        )})

    stem = Path(audio_path).stem
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    output = str(Path(audio_path).parent / f"{stem}.clip.{ts}.wav")

    args = ["-y"]
    if start_ms > 0:
        args += ["-ss", f"{start_ms / 1000:.3f}"]
    clip_duration_ms = None
    if end_ms > 0 and end_ms > start_ms:
        dur = end_ms - start_ms
        clip_duration_ms = dur
        args += ["-t", f"{dur / 1000:.3f}"]
    args += ["-i", audio_path]

    filters = []
    if highpass_hz > 0:
        filters.append(f"highpass=f={highpass_hz}")
    if lowpass_hz > 0:
        filters.append(f"lowpass=f={lowpass_hz}")
    if abs(gain_db) > 0.001:
        filters.append(f"volume={gain_db:.2f}dB")
    if fade_in_ms > 0:
        filters.append(f"afade=t=in:st=0:d={fade_in_ms / 1000:.3f}")
    if fade_out_ms > 0 and clip_duration_ms and clip_duration_ms > fade_out_ms:
        st = (clip_duration_ms - fade_out_ms) / 1000
        filters.append(f"afade=t=out:st={st:.3f}:d={fade_out_ms / 1000:.3f}")
    if normalize_lufs != 0.0:
        filters.append(f"loudnorm=I={normalize_lufs:.1f}:TP=-1.5:LRA=11")
    if filters:
        args += ["-af", ",".join(filters)]

    args += ["-ar", "48000", "-ac", "2", output]

    ok, err = _run_ffmpeg(args)
    if not ok:
        return json.dumps({"error": f"ffmpeg failed processing {audio_path}: {err}"})

    duration_ms = _wav_duration_ms(output)
    parent_meta = _read_meta(audio_path) or {}
    _write_meta(output, {
        "model": "clip-studio",
        "model_variant": "ffmpeg",
        "prompt": parent_meta.get("prompt", "Manual clip edit"),
        "instruct": (
            f"trim={start_ms}..{end_ms or 'end'}ms; gain={gain_db:.2f}dB; "
            f"fade_in={fade_in_ms}ms; fade_out={fade_out_ms}ms; "
            f"highpass={highpass_hz}Hz; lowpass={lowpass_hz}Hz; "
            f"normalize={normalize_lufs}LUFS"
        ),
        "seed": parent_meta.get("seed", 0),
        "duration_actual_ms": duration_ms,
        "sample_rate": 48000,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "parent": audio_path,
        "take_index": parent_meta.get("take_index", 0) + 1,
        "qa_status": "unreviewed",
        "qa_notes": "",
    })
    return json.dumps({"ok": True, "output_path": output, "duration_ms": duration_ms})


@mcp.tool()
def normalize_audio(audio_path: str, target_lufs: float = -16.0) -> str:
    """
    Normalize a WAV to target integrated loudness (LUFS) using ffmpeg loudnorm.
    Output is written to {stem}.norm.wav next to the original.
    Typical targets: -16 LUFS (podcast/streaming), -23 LUFS (broadcast EBU R128).
    True peak is clamped to -1.5 dBTP.
    """
    if not Path(audio_path).exists():
        return json.dumps({"error": (
            f"audio file not found: {audio_path} — "
            f"pass the absolute path of an existing WAV"
        )})

    output = audio_path.removesuffix(".wav") + ".norm.wav"
    ok, err = _run_ffmpeg([
        "-y", "-i", audio_path,
        "-af", f"loudnorm=I={target_lufs:.1f}:TP=-1.5:LRA=11",
        "-ar", "48000", "-ac", "2", output,
    ])
    if not ok:
        return json.dumps({"error": f"ffmpeg failed normalizing {audio_path}: {err}"})

    duration_ms = _wav_duration_ms(output)
    parent_meta = _read_meta(audio_path) or {}
    _write_meta(output, {
        "model": "clip-studio",
        "model_variant": "ffmpeg-loudnorm",
        "prompt": parent_meta.get("prompt", ""),
        "instruct": f"loudnorm I={target_lufs} TP=-1.5 LRA=11",
        "seed": parent_meta.get("seed", 0),
        "duration_actual_ms": duration_ms,
        "sample_rate": 48000,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "parent": audio_path,
        "take_index": parent_meta.get("take_index", 0) + 1,
        "qa_status": "unreviewed",
        "qa_notes": "",
    })
    return json.dumps({"ok": True, "output_path": output, "duration_ms": duration_ms})


@mcp.tool()
def resample_audio(audio_path: str, output_path: str = "") -> str:
    """
    Resample a WAV to 48 kHz stereo via ffmpeg.
    If output_path is omitted, writes to {stem}.48k.wav next to the original.
    Use this to normalize sample rates before composition — the audio engine
    requires all inputs to be 48 kHz.
    """
    if not Path(audio_path).exists():
        return json.dumps({"error": (
            f"audio file not found: {audio_path} — "
            f"pass the absolute path of an existing WAV"
        )})

    if not output_path:
        output_path = audio_path.removesuffix(".wav") + ".48k.wav"

    ok, err = _run_ffmpeg(["-y", "-i", audio_path, "-ar", "48000", "-ac", "2", output_path])
    if not ok:
        return json.dumps({"error": f"ffmpeg failed resampling {audio_path}: {err}"})

    duration_ms = _wav_duration_ms(output_path)
    return json.dumps({"ok": True, "output_path": output_path, "duration_ms": duration_ms})


@mcp.tool()
def upscale_audio(
    audio_path: str,
    output_path: str = "",
    model_name: str = "basic",
    ddim_steps: int = 50,
    guidance_scale: float = 3.5,
    seed: int = 0,
) -> str:
    """
    Upscale a WAV to 48 kHz via AudioSR (post server).
    Returns a job_id immediately — poll with job_status("post", job_id).

    model_name: "basic" (faster) or "speech" (optimised for voice)
    ddim_steps: diffusion steps (higher = better quality, slower)
    guidance_scale: classifier-free guidance strength

    Output path defaults to {stem}.upscaled.{model}.{timestamp}.wav next to input.
    """
    p = Path(audio_path)
    if not p.exists():
        return json.dumps({"error": (
            f"audio file not found: {audio_path} — "
            f"pass the absolute path of an existing WAV"
        )})

    if not output_path:
        ts = int(time.time() * 1000)
        output_path = str(p.parent / f"{p.stem}.upscaled.{model_name}.{ts}.wav")

    job_id = f"audiosr-{uuid.uuid4()}"
    try:
        resp = _post("post", "/generate/upscale", {
            "job_id": job_id,
            "input_path": audio_path,
            "output_path": output_path,
            "model_name": model_name,
            "ddim_steps": ddim_steps,
            "guidance_scale": guidance_scale,
            "seed": seed,
        }, upload_fields=("input_path",))
        server_job_id = resp.get("job_id", job_id)
    except Exception as e:
        return json.dumps({"error": (
            f"failed to submit AudioSR upscale job for {audio_path}: {e}"
        )})

    return json.dumps({
        "ok": True,
        "job_id": server_job_id,
        "output_path": output_path,
        "poll": "job_status('post', job_id)",
    })
