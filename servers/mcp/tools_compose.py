"""
MCP tools: scene composition and final render (pure Python + ffmpeg).

_compose_scene_ffmpeg builds a single amix filter graph from script.csv
(gain / pan / fades / adelay timeline placement / looping) and renders
render/scene_<slug>.wav; render_final chains the scene renders together
with acrossfades into output/final.wav. Importing this module registers
the tools against the shared FastMCP instance from server.py.
"""
import json
import shutil
import subprocess
from pathlib import Path

from config import log
from projectfs import _project_dir, _scene_dir, _script_rows, _storyboard_json
from server import mcp


def _compose_scene_ffmpeg(project_id: str, scene_slug: str) -> dict:
    """Mix all resolved audio rows in a scene into a single stereo 48 kHz WAV.

    Implements the full compositing pipeline in pure Python + ffmpeg:
      - per-track gain, stereo pan, fade-in / fade-out
      - timeline placement via adelay
      - looping (background music / ambience)
      - all tracks mixed down with amix (no normalisation)

    Returns a plain dict ready for json.dumps().
    """
    rows = _script_rows(project_id, scene_slug)
    scene_d = _scene_dir(project_id, scene_slug)

    AUDIO_TYPES = {"DIALOGUE", "SFX", "MUSIC", "AMBIENCE", "EFFECT", "EFFECT_SFX"}
    audio_rows = [
        r for r in rows
        if r.get("type", "").upper() in AUDIO_TYPES and r.get("file")
    ]

    # Check all files exist before starting ffmpeg
    missing = [r["file"] for r in audio_rows if not Path(r["file"]).is_file()]
    if missing:
        return {
            "error": (
                f"scene '{scene_slug}' in project {project_id} references "
                f"{len(missing)} audio file(s) that do not exist on disk — "
                f"run the generate_* tools (and QA) first, or fix the 'file' "
                f"column with update_script_row"
            ),
            "missing": missing,
        }

    if not audio_rows:
        return {"error": (
            f"no resolved audio rows to compose in scene '{scene_slug}' of project "
            f"{project_id} — every row's 'file' column is empty; generate assets and "
            f"assign them with update_script_row first"
        )}

    render_dir = scene_d / "render"
    render_dir.mkdir(parents=True, exist_ok=True)
    output_path = render_dir / f"scene_{scene_slug}.wav"

    # ── Compute total timeline duration ───────────────────────────────────────
    max_end_ms = 0
    for r in audio_rows:
        start = int(r.get("start_ms") or 0)
        dur   = int(r.get("duration_ms") or 0)
        if dur > 0:
            max_end_ms = max(max_end_ms, start + dur)
    if max_end_ms == 0:
        max_end_ms = 30_000  # fallback: 30 s if no durations set
    # Add 500 ms tail so fades don't get clipped
    total_s = (max_end_ms + 500) / 1000.0

    # ── Build ffmpeg command ───────────────────────────────────────────────────
    cmd = ["ffmpeg", "-y"]

    for r in audio_rows:
        if str(r.get("loop", "")).lower() in ("true", "1", "yes"):
            cmd += ["-stream_loop", "-1"]
        cmd += ["-i", r["file"]]

    filter_chains: list[str] = []
    mix_labels:    list[str] = []

    for i, r in enumerate(audio_rows):
        start_ms   = int(r.get("start_ms")    or 0)
        dur_ms     = int(r.get("duration_ms") or 0)
        gain_db    = float(r.get("gain_db")   or 0)
        pan        = float(r.get("pan")       or 0)   # -1 (L) .. 0 (C) .. 1 (R)
        fi_ms      = int(r.get("fade_in_ms")  or 0)
        fo_ms      = int(r.get("fade_out_ms") or 0)

        parts: list[str] = [
            "aresample=48000",
            "aformat=channel_layouts=stereo",
        ]

        # Trim to declared duration (also stops looped inputs)
        if dur_ms > 0:
            parts.append(f"atrim=duration={dur_ms / 1000:.3f}")

        # Gain
        if abs(gain_db) > 0.001:
            parts.append(f"volume={gain_db:.2f}dB")

        # Stereo pan: -1 → hard left, 0 → centre, +1 → hard right
        if abs(pan) > 0.01:
            l = min(1.0, max(0.0, 1.0 - pan))
            r_gain = min(1.0, max(0.0, 1.0 + pan))
            parts.append(f"pan=stereo|c0={l:.3f}*c0|c1={r_gain:.3f}*c1")

        # Fades
        if fi_ms > 0:
            parts.append(f"afade=t=in:st=0:d={fi_ms / 1000:.3f}")
        if fo_ms > 0 and dur_ms > fo_ms:
            st = (dur_ms - fo_ms) / 1000.0
            parts.append(f"afade=t=out:st={st:.3f}:d={fo_ms / 1000:.3f}")

        # Timeline placement
        if start_ms > 0:
            parts.append(f"adelay={start_ms}|{start_ms}")

        # Pad every track to the full mix length so amix sees equal-length streams
        parts.append(f"apad=whole_dur={total_s:.3f}")

        label = f"[a{i}]"
        filter_chains.append(f"[{i}:a]{','.join(parts)}{label}")
        mix_labels.append(label)

    # Combine all labelled streams
    n = len(mix_labels)
    filter_chains.append(
        f"{''.join(mix_labels)}amix=inputs={n}:normalize=0[out]"
    )
    complex_filter = ";".join(filter_chains)

    cmd += [
        "-filter_complex", complex_filter,
        "-map", "[out]",
        "-ar", "48000",
        "-ac", "2",
        str(output_path),
    ]

    log.info("compose_scene ffmpeg: %s", " ".join(cmd))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except FileNotFoundError:
        return {"error": "ffmpeg not found — install ffmpeg and ensure it is in PATH"}
    except subprocess.TimeoutExpired:
        return {"error": f"ffmpeg timed out (600s) composing scene '{scene_slug}' of project {project_id}"}

    if result.returncode != 0:
        return {"error": result.stderr[-3000:] or "ffmpeg failed", "cmd": " ".join(cmd)}

    return {"ok": True, "output_path": str(output_path), "tracks": n, "duration_s": total_s}


@mcp.tool()
def compose_scene(project_id: str, scene_slug: str) -> str:
    """
    Mix all resolved audio rows for a scene into a single stereo 48 kHz WAV.

    Reads script.csv, applies per-track gain / pan / fades / timeline placement,
    and produces render/scene_<slug>.wav via ffmpeg.  No external binary required.

    All rows that have a non-empty `file` column are included.  Rows still
    missing a file path are reported as an error before any rendering starts.
    """
    scene_d = _scene_dir(project_id, scene_slug)
    if not (scene_d / "script.csv").exists():
        return json.dumps({"error": (
            f"no script found for scene '{scene_slug}' in project {project_id} "
            f"(expected {scene_d / 'script.csv'}) — check the slug with "
            f"list_scenes, or populate the script with write_script"
        )})
    return json.dumps(_compose_scene_ffmpeg(project_id, scene_slug))


@mcp.tool()
def render_final(project_id: str, crossfade_ms: int = 500) -> str:
    """
    Assemble all scene renders into a final output WAV with crossfades.

    Reads the storyboard for scene order, loads render/scene_<slug>.wav for
    each scene (compose_scene must be run first), and concatenates them with
    an acrossfade of crossfade_ms milliseconds between scenes.

    Output: {project_dir}/output/final.wav
    """
    storyboard = _storyboard_json(project_id)
    scenes = sorted(storyboard.get("scenes", []), key=lambda s: s.get("index", 0))
    if not scenes:
        return json.dumps({"error": (
            f"no scenes in storyboard for project {project_id} — "
            f"create scenes with create_scene first"
        )})

    # Collect scene render files in order
    renders: list[Path] = []
    missing: list[str]  = []
    for s in scenes:
        slug = s.get("slug", "")
        p = _scene_dir(project_id, slug) / "render" / f"scene_{slug}.wav"
        if p.is_file():
            renders.append(p)
        else:
            missing.append(str(p))

    if missing:
        return json.dumps({
            "error": (
                f"{len(missing)} scene(s) in project {project_id} have not been "
                f"composed yet — run compose_scene on each missing scene first"
            ),
            "missing_renders": missing,
        })

    output_dir = _project_dir(project_id) / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "final.wav"

    if len(renders) == 1:
        # Single scene — just copy it
        shutil.copy2(renders[0], output_path)
        return json.dumps({"ok": True, "output_path": str(output_path), "scenes": 1})

    # ── Build ffmpeg concat with acrossfade ───────────────────────────────────
    cmd = ["ffmpeg", "-y"]
    for r in renders:
        cmd += ["-i", str(r)]

    cf_s = crossfade_ms / 1000.0
    n = len(renders)

    # Chain: [0][1] acrossfade → [cf0], [cf0][2] acrossfade → [cf1], …
    filter_parts: list[str] = []
    prev_label = "[0:a]"
    for i in range(1, n):
        out_label = f"[cf{i}]" if i < n - 1 else "[out]"
        filter_parts.append(
            f"{prev_label}[{i}:a]acrossfade=d={cf_s:.3f}:c1=tri:c2=tri{out_label}"
        )
        prev_label = out_label

    cmd += [
        "-filter_complex", ";".join(filter_parts),
        "-map", "[out]",
        "-ar", "48000",
        "-ac", "2",
        str(output_path),
    ]

    log.info("render_final ffmpeg: %s", " ".join(cmd))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except FileNotFoundError:
        return json.dumps({"error": "ffmpeg not found — install ffmpeg and ensure it is in PATH"})
    except subprocess.TimeoutExpired:
        return json.dumps({"error": f"ffmpeg timed out (600s) rendering final mix for project {project_id}"})

    if result.returncode != 0:
        return json.dumps({"error": result.stderr[-3000:] or "ffmpeg failed"})

    return json.dumps({"ok": True, "output_path": str(output_path), "scenes": n})
