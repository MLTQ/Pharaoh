"""
Pharaoh MCP Server — port 18000
AI agent control plane for the Pharaoh audio drama production pipeline.

Exposes MCP tools and resources so Claude (or any MCP client) can drive the
full Pharaoh pipeline without the GUI: read project state, submit generation
jobs, review assets, and trigger composition.

Transport modes:
  stdio  — for Claude Desktop / direct agent integration (default)
  sse    — for network clients; listens on --host/--port

Usage:
  python run.py --projects-dir ~/pharaoh-projects
  python run.py --transport sse --port 18000 --projects-dir ~/pharaoh-projects
"""
import argparse
import csv
import json
import logging
import os
import subprocess
import sys
import time
from io import StringIO
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pharaoh-mcp")

# ── CLI args ──────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Pharaoh MCP control-plane server")
parser.add_argument("--projects-dir", default=os.path.expanduser("~/pharaoh-projects"))
parser.add_argument("--tts-url", default="http://127.0.0.1:18001")
parser.add_argument("--sfx-url", default="http://127.0.0.1:18002")
parser.add_argument("--music-url", default="http://127.0.0.1:18003")
parser.add_argument("--post-url", default="http://127.0.0.1:18004")
parser.add_argument("--chatterbox-url", default="http://127.0.0.1:18005")
parser.add_argument("--transport", default="stdio", choices=["stdio", "sse"])
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=18000)
args, _ = parser.parse_known_args()

PROJECTS_DIR = Path(args.projects_dir).expanduser()
SERVER_URLS = {
    "tts": args.tts_url,
    "sfx": args.sfx_url,
    "music": args.music_url,
    "post": args.post_url,
    "chatterbox": args.chatterbox_url,
}

mcp = FastMCP("pharaoh")

# ── Filesystem helpers ────────────────────────────────────────────────────────

def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def _project_json(project_id: str) -> dict:
    path = _project_dir(project_id) / "project.json"
    if not path.exists():
        raise FileNotFoundError(f"project not found: {project_id}")
    return json.loads(path.read_text())


def _storyboard_json(project_id: str) -> dict:
    path = _project_dir(project_id) / "storyboard.json"
    if not path.exists():
        return {"scenes": []}
    return json.loads(path.read_text())


def _scene_dir(project_id: str, scene_slug: str) -> Path:
    return _project_dir(project_id) / "scenes" / scene_slug


def _script_rows(project_id: str, scene_slug: str) -> list[dict]:
    path = _scene_dir(project_id, scene_slug) / "script.csv"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    reader = csv.DictReader(StringIO(text))
    return [row for row in reader]


def _write_script_rows(project_id: str, scene_slug: str, rows: list[dict]) -> None:
    path = _scene_dir(project_id, scene_slug) / "script.csv"
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)


def _meta_path(audio_path: str) -> Path:
    p = Path(audio_path)
    return p.parent / (p.name + ".meta.json")


def _read_meta(audio_path: str) -> dict | None:
    mp = _meta_path(audio_path)
    if not mp.exists():
        return None
    return json.loads(mp.read_text())


def _write_meta(audio_path: str, meta: dict) -> None:
    mp = _meta_path(audio_path)
    tmp = mp.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, indent=2))
    tmp.rename(mp)


def _list_assets(project_id: str, scene_slug: str) -> list[dict]:
    assets_dir = _scene_dir(project_id, scene_slug) / "assets"
    if not assets_dir.exists():
        return []
    results = []
    for meta_file in sorted(assets_dir.rglob("*.wav.meta.json")):
        audio_file = meta_file.parent / meta_file.name.removesuffix(".meta.json")
        if not audio_file.exists():
            continue
        meta = json.loads(meta_file.read_text())
        results.append({
            "audio_path": str(audio_file),
            "model": meta.get("model", ""),
            "prompt": meta.get("prompt", ""),
            "qa_status": meta.get("qa_status", "unreviewed"),
            "qa_notes": meta.get("qa_notes", ""),
            "duration_ms": meta.get("duration_actual_ms"),
            "generated_at": meta.get("generated_at", ""),
            "take_index": meta.get("take_index", 0),
        })
    return results


# ── Pipeline status helpers ───────────────────────────────────────────────────

def _scene_pipeline_status(project_id: str, scene: dict) -> dict:
    slug = scene["slug"]
    rows = _script_rows(project_id, slug)
    audio_rows = [r for r in rows if r.get("type", "").upper() != "DIRECTION"]
    resolved = [r for r in audio_rows if r.get("file", "").strip()]
    assets = _list_assets(project_id, slug)
    approved = [a for a in assets if a["qa_status"] == "approved"]
    unreviewed = [a for a in assets if a["qa_status"] == "unreviewed"]
    render_path = _scene_dir(project_id, slug) / "render" / f"scene_{slug}.wav"
    return {
        "slug": slug,
        "title": scene.get("title", slug),
        "status": scene.get("status", "draft"),
        "script_rows_total": len(audio_rows),
        "script_rows_resolved": len(resolved),
        "assets_total": len(assets),
        "assets_approved": len(approved),
        "assets_unreviewed": len(unreviewed),
        "rendered": render_path.exists(),
    }


# ── App config helper ─────────────────────────────────────────────────────────

def _cfg() -> dict:
    """Read the persisted Pharaoh AppConfig from disk. Returns {} if not found."""
    import platform
    system = platform.system()
    if system == "Darwin":
        cfg_path = Path.home() / "Library" / "Application Support" / "ai.aureum.pharaoh" / "config.json"
    elif system == "Windows":
        cfg_path = Path(os.environ.get("APPDATA", Path.home())) / "ai.aureum.pharaoh" / "config.json"
    else:
        cfg_path = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "ai.aureum.pharaoh" / "config.json"
    if not cfg_path.exists():
        return {}
    try:
        return json.loads(cfg_path.read_text())
    except Exception:
        return {}


# ── Single model mode ─────────────────────────────────────────────────────────

_HEAVY_SERVERS = {"tts", "music", "chatterbox"}


def _auto_unload_others(active: str) -> None:
    """If single_model_mode is enabled, unload all heavy servers except `active`."""
    cfg = _cfg()
    if not cfg.get("single_model_mode", False):
        return
    for server in _HEAVY_SERVERS:
        if server == active:
            continue
        try:
            _post(server, "/unload", {})
        except Exception:
            pass  # server may not be running


# ── Inference proxy helpers ───────────────────────────────────────────────────

def _post(server: str, path: str, body: dict) -> dict:
    url = SERVER_URLS[server] + path
    try:
        resp = httpx.post(url, json=body, timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        raise RuntimeError(f"{server} server not reachable at {SERVER_URLS[server]}. Start it first.")


def _get(server: str, path: str) -> dict:
    url = SERVER_URLS[server] + path
    try:
        resp = httpx.get(url, timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        raise RuntimeError(f"{server} server not reachable at {SERVER_URLS[server]}. Start it first.")


# ── MCP Resources ─────────────────────────────────────────────────────────────

@mcp.resource("pharaoh://projects")
def list_projects_resource() -> str:
    """All Pharaoh projects with id, title, and current status."""
    if not PROJECTS_DIR.exists():
        return json.dumps([])
    projects = []
    for d in sorted(PROJECTS_DIR.iterdir()):
        pj = d / "project.json"
        if not pj.exists():
            continue
        data = json.loads(pj.read_text())
        projects.append({
            "id": data.get("id", d.name),
            "title": data.get("title", d.name),
            "logline": data.get("logline", ""),
            "created_at": data.get("created_at", ""),
        })
    return json.dumps(projects, indent=2)


@mcp.resource("pharaoh://projects/{project_id}")
def get_project_resource(project_id: str) -> str:
    """Full project.json for a project."""
    return json.dumps(_project_json(project_id), indent=2)


@mcp.resource("pharaoh://projects/{project_id}/storyboard")
def get_storyboard_resource(project_id: str) -> str:
    """storyboard.json — all scenes with metadata."""
    return json.dumps(_storyboard_json(project_id), indent=2)


@mcp.resource("pharaoh://projects/{project_id}/scenes/{scene_slug}/script")
def get_script_resource(project_id: str, scene_slug: str) -> str:
    """script.csv as a JSON array of rows. Unresolved rows have empty file/start_ms."""
    return json.dumps(_script_rows(project_id, scene_slug), indent=2)


@mcp.resource("pharaoh://projects/{project_id}/scenes/{scene_slug}/assets")
def get_assets_resource(project_id: str, scene_slug: str) -> str:
    """All generated audio assets for a scene with QA status and metadata."""
    return json.dumps(_list_assets(project_id, scene_slug), indent=2)


@mcp.resource("pharaoh://projects/{project_id}/pipeline")
def get_pipeline_resource(project_id: str) -> str:
    """Per-scene per-stage completion matrix. Use this for situational awareness."""
    storyboard = _storyboard_json(project_id)
    stages = []
    for scene in storyboard.get("scenes", []):
        stages.append(_scene_pipeline_status(project_id, scene))
    summary = {
        "project_id": project_id,
        "total_scenes": len(stages),
        "scenes_rendered": sum(1 for s in stages if s["rendered"]),
        "scenes": stages,
    }
    return json.dumps(summary, indent=2)


# ── MCP Tools ─────────────────────────────────────────────────────────────────

@mcp.tool()
def project_status(project_id: str) -> str:
    """
    Return a full pipeline status matrix for a project.
    Shows per-scene progress across script, assets, QA, and render stages.
    Use this at the start of any agent session to understand where the project stands.
    """
    storyboard = _storyboard_json(project_id)
    stages = [_scene_pipeline_status(project_id, s) for s in storyboard.get("scenes", [])]
    project = _project_json(project_id)
    return json.dumps({
        "title": project.get("title"),
        "total_scenes": len(stages),
        "scenes_rendered": sum(1 for s in stages if s["rendered"]),
        "scenes": stages,
    }, indent=2)


@mcp.tool()
def read_script(project_id: str, scene_slug: str) -> str:
    """
    Return all script rows for a scene as structured JSON.
    Rows with empty 'file' field are unresolved (no asset yet).
    DIRECTION rows carry no audio — they are composition notes for the agent.
    """
    rows = _script_rows(project_id, scene_slug)
    return json.dumps(rows, indent=2)


@mcp.tool()
def update_script_row(
    project_id: str,
    scene_slug: str,
    row_index: int,
    updates: dict,
) -> str:
    """
    Update fields on a single script row (zero-indexed).
    Only supply the fields you want to change — others are preserved.
    Example updates: {"file": "mira_line_01.wav", "start_ms": "0", "duration_ms": "2400"}
    Cannot update 'scene' or 'type' — those are structural.
    """
    rows = _script_rows(project_id, scene_slug)
    if row_index < 0 or row_index >= len(rows):
        return json.dumps({"error": f"row_index {row_index} out of range (0–{len(rows)-1})"})
    forbidden = {"scene", "type"}
    bad = [k for k in updates if k in forbidden]
    if bad:
        return json.dumps({"error": f"cannot update structural fields: {bad}"})
    rows[row_index].update(updates)
    _write_script_rows(project_id, scene_slug, rows)
    return json.dumps({"ok": True, "updated_row": rows[row_index]})


@mcp.tool()
def generate_tts(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    speaker: str = "Vivian",
    instruct: str = "",
    voice_description: str = "",
    seed: int = 0,
    temperature: float = 0.7,
    top_p: float = 0.9,
    max_new_tokens: int = 2048,
) -> str:
    """
    Submit a TTS/dialogue generation job for a DIALOGUE script row.
    Returns a job_id immediately. Poll job_status to wait for completion.
    The prompt is read from the row's 'prompt' field; instruct overrides the row's 'instruct' field if provided.
    output_path should be the absolute path where the .wav should be saved.

    Voice modes (in priority order):
      1. Chatterbox (automatic): if the character's voice_assignment.model == "Chatterbox" and the
         row has a non-empty 'emotion' field, automatically resolves the palette reference and routes
         to the Chatterbox server. No extra parameters needed.
      2. voice_description: pass a rich natural-language description of the desired voice.
         Routes to Qwen3-TTS /generate/voice_design.
      3. speaker + instruct: preset speaker with optional style instruction.
         Supported speakers: aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian.
    """
    rows = _script_rows(project_id, scene_slug)
    if row_index < 0 or row_index >= len(rows):
        return json.dumps({"error": f"row_index {row_index} out of range"})
    row = rows[row_index]
    if row.get("type", "").upper() != "DIALOGUE":
        return json.dumps({"error": "generate_tts only applies to DIALOGUE rows"})

    # ── Single model mode: unload other heavy servers before generation ──────────
    _auto_unload_others("tts")

    # ── Chatterbox routing (auto, based on character voice_assignment) ──────────
    char_id = row.get("character", "")
    if char_id:
        try:
            project = _project_json(project_id)
            character = next(
                (c for c in project.get("characters", [])
                 if c["id"] == char_id or c.get("name", "").upper() == char_id.upper()),
                None,
            )
            if character:
                va = character.get("voice_assignment", {})
                if va.get("model") == "Chatterbox":
                    emotion_key = row.get("emotion", "").strip() or "neutral"
                    palette = va.get("emotional_palette", [])
                    entry = next(
                        (e for e in palette if e["emotion"] == emotion_key),
                        palette[0] if palette else None,
                    )
                    if entry and entry.get("ref_audio_path"):
                        result = _post("chatterbox", "/generate/clone", {
                            "text": row["prompt"],
                            "ref_audio_path": entry["ref_audio_path"],
                            "ref_transcript": entry.get("ref_transcript") or "",
                            "seed": seed,
                            "output_path": output_path,
                        })
                        return json.dumps(result)
        except Exception as exc:
            log.warning(f"Chatterbox auto-routing failed, falling back to Qwen3: {exc}")

    if voice_description:
        # Voice Design mode: synthesise voice from natural-language description
        result = _post("tts", "/generate/voice_design", {
            "text": row["prompt"],
            "voice_description": voice_description,
            "seed": seed,
            "temperature": temperature,
            "top_p": top_p,
            "max_new_tokens": max_new_tokens,
            "output_path": output_path,
        })
    else:
        # Base model mode: preset speaker + optional style instruction
        effective_instruct = instruct or row.get("instruct", "")
        result = _post("tts", "/generate/custom_voice", {
            "text": row["prompt"],
            "speaker": speaker,
            "instruct": effective_instruct or None,
            "seed": seed,
            "temperature": temperature,
            "top_p": top_p,
            "max_new_tokens": max_new_tokens,
            "output_path": output_path,
        })
    return json.dumps(result)


@mcp.tool()
def generate_sfx(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    duration_seconds: float = 3.0,
    steps: int = 4,
    seed: int = 0,
) -> str:
    """
    Submit an SFX generation job for an SFX or BED script row.
    Uses Woosh-DFlow (fast, 4-step). Returns job_id immediately.
    The prompt is read from the row's 'prompt' field.
    output_path should be the absolute path where the .wav should be saved.
    """
    rows = _script_rows(project_id, scene_slug)
    if row_index < 0 or row_index >= len(rows):
        return json.dumps({"error": f"row_index {row_index} out of range"})
    row = rows[row_index]
    row_type = row.get("type", "").upper()
    if row_type not in ("SFX", "BED"):
        return json.dumps({"error": "generate_sfx only applies to SFX or BED rows"})
    result = _post("sfx", "/generate/t2a", {
        "prompt": row["prompt"],
        "duration_seconds": duration_seconds,
        "model_variant": "Woosh-DFlow",
        "steps": steps,
        "seed": seed,
        "output_path": output_path,
    })
    return json.dumps(result)


@mcp.tool()
def generate_music(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    duration_seconds: float = 30.0,
    seed: int = 0,
    batch_size: int = 1,
    diffusion_steps: int = 60,
    lm_model_size: str = "1.7B",
) -> str:
    """
    Submit a music generation job for a MUSIC script row.
    batch_size > 1 generates multiple takes with different seeds for comparison (gacha workflow).
    Returns job_id (or list of job_ids if batch_size > 1). Poll job_status for each.
    The caption/prompt is read from the row's 'prompt' field.
    """
    rows = _script_rows(project_id, scene_slug)
    if row_index < 0 or row_index >= len(rows):
        return json.dumps({"error": f"row_index {row_index} out of range"})
    row = rows[row_index]
    if row.get("type", "").upper() != "MUSIC":
        return json.dumps({"error": "generate_music only applies to MUSIC rows"})

    _auto_unload_others("music")

    if batch_size <= 1:
        result = _post("music", "/generate/text2music", {
            "caption": row["prompt"],
            "lyrics": "",
            "duration_seconds": duration_seconds,
            "seed": seed,
            "diffusion_steps": diffusion_steps,
            "lm_model_size": lm_model_size,
            "batch_size": 1,
            "output_path": output_path,
        })
        return json.dumps(result)
    else:
        # Fan out N seeds, derive output paths from base output_path
        base = Path(output_path)
        stem = base.stem
        jobs = []
        for i in range(batch_size):
            take_path = str(base.parent / f"{stem}_take{i+1}{base.suffix}")
            result = _post("music", "/generate/text2music", {
                "caption": row["prompt"],
                "lyrics": "",
                "duration_seconds": duration_seconds,
                "seed": seed + i,
                "diffusion_steps": diffusion_steps,
                "lm_model_size": lm_model_size,
                "batch_size": 1,
                "output_path": take_path,
            })
            jobs.append({"take": i + 1, "seed": seed + i, "output_path": take_path, **result})
        return json.dumps({"batch": True, "jobs": jobs})


@mcp.tool()
def generate_chatterbox(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    ref_audio_path: str = "",
    emotion: str = "",
    exaggeration: float = 0.5,
    cfg_weight: float = 0.5,
    seed: int = 0,
) -> str:
    """
    Submit a Chatterbox Turbo 0-shot voice clone job for a DIALOGUE script row.

    Chatterbox Turbo clones the vocal identity from ref_audio_path and renders
    the row's prompt text. Inline paralinguistic tags in the prompt text are
    honoured (e.g. '[sigh] I knew it.' or 'That's funny. [chuckle]').

    ref_audio_path: if empty, auto-resolves from the character's emotional palette
                    using the row's 'emotion' field (falls back to first palette entry).
    emotion:        override the emotion key (ignores row's 'emotion' field).
    exaggeration:   0–1, how strongly to colour the vocal performance.
    cfg_weight:     classifier-free guidance strength.
    """
    rows = _script_rows(project_id, scene_slug)
    if row_index < 0 or row_index >= len(rows):
        return json.dumps({"error": f"row_index {row_index} out of range"})
    row = rows[row_index]
    if row.get("type", "").upper() != "DIALOGUE":
        return json.dumps({"error": "generate_chatterbox only applies to DIALOGUE rows"})

    _auto_unload_others("chatterbox")

    resolved_ref = ref_audio_path
    if not resolved_ref:
        char_id = row.get("character", "")
        emotion_key = emotion or row.get("emotion", "").strip() or "neutral"
        try:
            project = _project_json(project_id)
            character = next(
                (c for c in project.get("characters", [])
                 if c["id"] == char_id or c.get("name", "").upper() == char_id.upper()),
                None,
            )
            if character:
                palette = character.get("voice_assignment", {}).get("emotional_palette", [])
                entry = next(
                    (e for e in palette if e["emotion"] == emotion_key),
                    palette[0] if palette else None,
                )
                if entry and entry.get("ref_audio_path"):
                    resolved_ref = entry["ref_audio_path"]
        except Exception as exc:
            return json.dumps({"error": f"palette resolution failed: {exc}"})

    if not resolved_ref:
        return json.dumps({"error": (
            "ref_audio_path not supplied and no approved palette entry found. "
            "Generate and approve a palette take first."
        )})

    result = _post("chatterbox", "/generate/clone", {
        "text": row["prompt"],
        "ref_audio_path": resolved_ref,
        "exaggeration": exaggeration,
        "cfg_weight": cfg_weight,
        "seed": seed,
        "output_path": output_path,
    })
    return json.dumps(result)


@mcp.tool()
def generate_palette_take(
    project_id: str,
    character_id: str,
    emotion: str,
    direction: str,
    test_line: str,
    seed: int = 0,
    label: str = "",
) -> str:
    """
    Generate a Qwen3 VoiceDesign reference take for a character's palette emotion slot.

    Combines the character's base_voice_description (vocal identity) with the emotion's
    direction (short performance instruction) to produce a coherent instruct string, then
    calls Qwen3-TTS /generate/voice_design. Saves to characters/{character_id}/palette/
    and upserts the palette entry in project.json (qa_status='unreviewed').

    After reviewing the take, call approve_palette_take to lock it as the reference.
    Multiple takes can be generated with different seeds before approving.

    emotion:   slug key (e.g. "neutral", "sardonic", "tense")
    direction: short emotional direction to layer on the character's base voice, e.g.
               "Flat, controlled fear. Each word measured." — NOT a full voice description.
               The character's base_voice_description is prepended automatically.
    test_line: the text to synthesise for audition
    label:     human-readable display name (defaults to capitalised emotion key)
    """
    proj_dir = _project_dir(project_id)
    proj_path = proj_dir / "project.json"
    project = json.loads(proj_path.read_text())

    character = next((c for c in project.get("characters", []) if c["id"] == character_id), None)
    if character is None:
        return json.dumps({"error": f"character {character_id!r} not found in project"})

    va = character.setdefault("voice_assignment", {})
    base_desc = va.get("base_voice_description", "").strip()

    # Combine base identity + emotional direction into a single VoiceDesign instruct
    if base_desc and direction.strip():
        full_instruct = f"{base_desc} {direction.strip()}"
    elif base_desc:
        full_instruct = base_desc
    else:
        full_instruct = direction.strip()

    if not full_instruct:
        return json.dumps({"error": "No voice description available. Set the character's base voice description in the Voice Design tab first."})

    palette_dir = proj_dir / "characters" / character_id / "palette"
    palette_dir.mkdir(parents=True, exist_ok=True)

    out_path = str(palette_dir / f"{emotion}_{seed}.wav")
    _auto_unload_others("tts")
    result = _post("tts", "/generate/voice_design", {
        "text": test_line,
        "voice_description": full_instruct,
        "seed": seed,
        "output_path": out_path,
    })

    # Upsert palette entry in project.json
    palette = va.setdefault("emotional_palette", [])
    entry = next((e for e in palette if e["emotion"] == emotion), None)
    if entry is None:
        entry = {
            "emotion": emotion,
            "label": label or emotion.capitalize(),
            "direction": direction,
            "ref_audio_path": None,
            "ref_transcript": None,
            "qa_status": "unreviewed",
        }
        palette.append(entry)
    else:
        entry["direction"] = direction
        if label:
            entry["label"] = label

    proj_path.write_text(json.dumps(project, indent=2, default=str))
    return json.dumps({"ok": True, "output_path": out_path, "full_instruct": full_instruct, **result})


@mcp.tool()
def approve_palette_take(
    project_id: str,
    character_id: str,
    emotion: str,
    audio_path: str,
) -> str:
    """
    Lock a palette take as the approved reference for this emotion slot.

    Updates project.json: sets emotional_palette[emotion].ref_audio_path = audio_path
    and qa_status = 'approved'. Also sets voice_assignment.model = 'Chatterbox' if not
    already set.

    After approval, generate_tts / generate_chatterbox will automatically use this
    reference when generating lines with this emotion.
    """
    if not Path(audio_path).is_file():
        return json.dumps({"error": f"audio_path not found: {audio_path}"})

    proj_path = _project_dir(project_id) / "project.json"
    project = json.loads(proj_path.read_text())
    for char in project.get("characters", []):
        if char["id"] == character_id:
            va = char.setdefault("voice_assignment", {})
            palette = va.setdefault("emotional_palette", [])
            entry = next((e for e in palette if e["emotion"] == emotion), None)
            if entry is None:
                return json.dumps({"error": f"emotion {emotion!r} not found in palette. Run generate_palette_take first."})
            entry["ref_audio_path"] = audio_path
            entry["qa_status"] = "approved"
            # Promote model to Chatterbox
            va["model"] = "Chatterbox"
            break
    else:
        return json.dumps({"error": f"character {character_id!r} not found"})

    proj_path.write_text(json.dumps(project, indent=2, default=str))
    return json.dumps({"ok": True, "character_id": character_id, "emotion": emotion, "ref": audio_path})


@mcp.tool()
def list_character_palette(project_id: str, character_id: str) -> str:
    """
    Return all palette entries for a character with their qa_status and ref_audio_path.
    Use this to check which emotion slots are ready (approved) vs. still need takes.
    """
    project = _project_json(project_id)
    character = next(
        (c for c in project.get("characters", []) if c["id"] == character_id),
        None,
    )
    if character is None:
        return json.dumps({"error": f"character {character_id!r} not found"})
    va = character.get("voice_assignment", {})
    return json.dumps({
        "character_id": character_id,
        "name": character.get("name"),
        "model": va.get("model"),
        "emotional_palette": va.get("emotional_palette", []),
    }, indent=2)


@mcp.tool()
def job_status(server: str, job_id: str) -> str:
    """
    Poll a generation job for status and progress.
    server: "tts" | "sfx" | "music" | "post" | "chatterbox"
    Returns: {status: "pending|running|complete|failed", progress: 0.0-1.0, output_path, error}
    """
    if server not in SERVER_URLS:
        return json.dumps({"error": f"unknown server: {server}. Use: {list(SERVER_URLS)}"})
    result = _get(server, f"/jobs/{job_id}")
    return json.dumps(result)


@mcp.tool()
def wait_for_job(server: str, job_id: str, timeout_seconds: int = 300) -> str:
    """
    Block until a generation job completes or fails (polls every 2 seconds).
    Returns the final job record with output_path on success.
    Use this instead of manually polling job_status in a loop.
    server: "tts" | "sfx" | "music" | "post" | "chatterbox"
    """
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        result = _get(server, f"/jobs/{job_id}")
        status = result.get("status", "")
        if status == "complete":
            return json.dumps({"ok": True, **result})
        if status == "failed":
            return json.dumps({"ok": False, **result})
        time.sleep(2)
    return json.dumps({"ok": False, "error": f"timed out after {timeout_seconds}s", "last": result})


@mcp.tool()
def list_assets(project_id: str, scene_slug: str, qa_status: str = "") -> str:
    """
    List all generated audio assets for a scene.
    qa_status filter: "unreviewed" | "approved" | "rejected" | "" (all)
    Returns path, model, prompt, QA status, duration, and take index for each asset.
    """
    assets = _list_assets(project_id, scene_slug)
    if qa_status:
        assets = [a for a in assets if a["qa_status"] == qa_status]
    return json.dumps(assets, indent=2)


@mcp.tool()
def qa_approve(audio_path: str, notes: str = "") -> str:
    """
    Approve a generated asset, marking it ready for composition.
    Writes qa_status='approved' to the asset's .meta.json sidecar.
    """
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": f"no sidecar found for {audio_path}"})
    meta["qa_status"] = "approved"
    meta["qa_notes"] = notes
    _write_meta(audio_path, meta)
    return json.dumps({"ok": True, "audio_path": audio_path, "qa_status": "approved"})


@mcp.tool()
def qa_reject(audio_path: str, notes: str) -> str:
    """
    Reject a generated asset with notes explaining what was wrong.
    Writes qa_status='rejected' to the asset's .meta.json sidecar.
    notes should describe the problem clearly (e.g. "too bright, character sounds wrong").
    """
    if not notes:
        return json.dumps({"error": "notes are required when rejecting an asset"})
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": f"no sidecar found for {audio_path}"})
    meta["qa_status"] = "rejected"
    meta["qa_notes"] = notes
    _write_meta(audio_path, meta)
    return json.dumps({"ok": True, "audio_path": audio_path, "qa_status": "rejected", "notes": notes})


@mcp.tool()
def regenerate_asset(audio_path: str, output_path: str = "") -> str:
    """
    Re-submit a generation job using the exact parameters from an asset's sidecar.
    Reads the .meta.json sidecar to reconstruct the original request.
    output_path defaults to a new take path derived from the original filename.
    """
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": f"no sidecar found for {audio_path}"})

    p = Path(audio_path)
    take_idx = meta.get("take_index", 1) + 1
    if not output_path:
        output_path = str(p.parent / f"{p.stem}_take{take_idx}{p.suffix}")

    model = meta.get("model", "")
    if "qwen" in model.lower() or "tts" in model.lower():
        return json.dumps(_post("tts", "/generate/custom_voice", {
            "text": meta.get("prompt", ""),
            "speaker": meta.get("speaker") or "Vivian",
            "instruct": meta.get("instruct") or None,
            "seed": meta.get("seed", 0),
            "temperature": meta.get("temperature", 0.7),
            "top_p": meta.get("top_p", 0.9),
            "max_new_tokens": meta.get("max_new_tokens", 2048),
            "output_path": output_path,
        }))
    elif "ace" in model.lower() or "music" in model.lower():
        return json.dumps(_post("music", "/generate/text2music", {
            "caption": meta.get("prompt", ""),
            "lyrics": "",
            "duration_seconds": (meta.get("duration_actual_ms") or 30000) / 1000,
            "seed": meta.get("seed", 0),
            "diffusion_steps": 60,
            "lm_model_size": "1.7B",
            "batch_size": 1,
            "output_path": output_path,
        }))
    else:
        return json.dumps(_post("sfx", "/generate/t2a", {
            "prompt": meta.get("prompt", ""),
            "duration_seconds": (meta.get("duration_actual_ms") or 3000) / 1000,
            "model_variant": "Woosh-DFlow",
            "steps": 4,
            "seed": meta.get("seed", 0),
            "output_path": output_path,
        }))


@mcp.tool()
def unload_model(server: str) -> str:
    """
    Unload the currently loaded model from an inference server to free RAM/VRAM.

    IMPORTANT: Call this before loading a different heavy model to avoid OOM.
    The inference servers do NOT share memory — each holds its model independently.
    Typical footprints (RAM, no GPU):
      tts         — ~8–12 GB (voice_design or custom_voice)
      sfx         — ~4–6 GB (AudioLDM)
      music       — ~14–20 GB (ACE-Step 3.5B)
      post        — ~2–4 GB (AudioSR)
      chatterbox  — ~4–6 GB (Chatterbox Turbo 0.5B)

    Recommended workflow for CPU-only sessions:
      1. Build palette: generate_palette_take for each emotion → approve → unload_model("tts")
      2. Generate all dialogue with Chatterbox → unload_model("chatterbox")
      3. Generate all SFX
      4. Generate music → unload_model("music")
      5. Generate post-processing as needed

    server: "tts" | "sfx" | "music" | "post" | "chatterbox"
    """
    if server not in SERVER_URLS:
        return json.dumps({"error": f"unknown server: {server}. Valid: {list(SERVER_URLS.keys())}"})
    try:
        result = _post(server, "/unload", {})
        return json.dumps({"ok": True, "server": server, **result})
    except Exception as e:
        return json.dumps({"ok": False, "server": server, "error": str(e)})


@mcp.tool()
def server_health(server: str = "") -> str:
    """
    Check health of inference servers.
    server: "tts" | "sfx" | "music" | "post" | "chatterbox" | "" (check all)
    Returns model_loaded, model_variant, and vram_mb for each.

    RAM WARNING: On CPU-only systems, loading multiple heavy models simultaneously
    will exhaust RAM. Use unload_model() between generation phases.
    See unload_model() docstring for recommended sequencing.
    """
    targets = [server] if server else list(SERVER_URLS.keys())
    results = {}
    for s in targets:
        if s not in SERVER_URLS:
            results[s] = {"error": f"unknown server: {s}"}
            continue
        try:
            results[s] = _get(s, "/health")
        except Exception as e:
            results[s] = {"status": "unreachable", "error": str(e)}
    return json.dumps(results, indent=2)


@mcp.tool()
def compose_scene(project_id: str, scene_slug: str) -> str:
    """
    Render a scene by calling the Pharaoh audio engine via ffmpeg.
    All approved assets must be present and QA-approved before composing.
    Returns the output render path on success.
    This invokes pharaoh's compose pipeline directly — make sure all assets are resolved first.
    """
    scene_d = _scene_dir(project_id, scene_slug)
    script_path = scene_d / "script.csv"
    if not script_path.exists():
        return json.dumps({"error": f"no script found for scene {scene_slug}"})
    render_dir = scene_d / "render"
    render_dir.mkdir(parents=True, exist_ok=True)

    # Locate the pharaoh CLI binary next to this script
    mcp_dir = Path(__file__).parent
    repo_root = mcp_dir.parent.parent
    cli_candidates = [
        repo_root / "target" / "release" / "pharaoh",
        repo_root / "target" / "debug" / "pharaoh",
        repo_root / "src-tauri" / "target" / "release" / "pharaoh",
        repo_root / "src-tauri" / "target" / "debug" / "pharaoh",
    ]
    cli = next((c for c in cli_candidates if c.exists()), None)
    if cli is None:
        return json.dumps({
            "error": "pharaoh CLI binary not found. Build with: cargo build --release",
            "searched": [str(c) for c in cli_candidates],
        })

    result = subprocess.run(
        [str(cli), "compose", "render", "scene", project_id, scene_slug],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        render_path = render_dir / f"scene_{scene_slug}.wav"
        return json.dumps({"ok": True, "output_path": str(render_path), "stdout": result.stdout})
    else:
        return json.dumps({"ok": False, "error": result.stderr, "stdout": result.stdout})


@mcp.tool()
def render_final(project_id: str, crossfade_ms: int = 500) -> str:
    """
    Assemble all rendered scenes into a final output WAV.
    All scenes must be rendered before calling this.
    Returns the path to the final output file.
    """
    repo_root = Path(__file__).parent.parent.parent
    cli_candidates = [
        repo_root / "target" / "release" / "pharaoh",
        repo_root / "target" / "debug" / "pharaoh",
        repo_root / "src-tauri" / "target" / "release" / "pharaoh",
        repo_root / "src-tauri" / "target" / "debug" / "pharaoh",
    ]
    cli = next((c for c in cli_candidates if c.exists()), None)
    if cli is None:
        return json.dumps({
            "error": "pharaoh CLI binary not found. Build with: cargo build --release",
        })

    result = subprocess.run(
        [str(cli), "compose", "final", project_id, "--crossfade", str(crossfade_ms)],
        capture_output=True,
        text=True,
    )
    output_path = _project_dir(project_id) / "output" / "final.wav"
    if result.returncode == 0:
        return json.dumps({"ok": True, "output_path": str(output_path), "stdout": result.stdout})
    else:
        return json.dumps({"ok": False, "error": result.stderr})


# ── SSE health endpoint (for Rust server health check) ────────────────────────
# When running in SSE mode, FastMCP exposes the MCP protocol over HTTP.
# We also need a plain /health endpoint so the Rust backend can poll it.
# FastMCP's SSE app is a Starlette app — mount a health route on it.

def _add_health_route(app_instance: FastMCP) -> None:
    """Attach a /health GET route to the underlying Starlette app."""
    try:
        from starlette.routing import Route
        from starlette.responses import JSONResponse

        async def health(request):  # noqa: ANN001
            return JSONResponse({
                "status": "ok",
                "model_loaded": True,
                "model_variant": "pharaoh-mcp",
                "vram_mb": 0,
                "stub": False,
            })

        sse_app = app_instance.get_asgi_app()  # Starlette instance
        sse_app.routes.insert(0, Route("/health", health))
    except Exception as exc:
        log.warning("Could not attach /health route: %s", exc)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("Pharaoh MCP server starting (transport=%s, projects=%s)", args.transport, PROJECTS_DIR)
    if args.transport == "sse":
        _add_health_route(mcp)
        mcp.run(transport="sse", host=args.host, port=args.port)
    else:
        mcp.run()
