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
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
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
parser.add_argument("--rvc-url", default="http://127.0.0.1:18006")
parser.add_argument("--transport", default="stdio", choices=["stdio", "sse"])
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=18000)
parser.add_argument("--single-model-mode", action="store_true", default=False,
                    help="Unload other heavy servers before loading a new model (saves VRAM)")
args, _ = parser.parse_known_args()

PROJECTS_DIR = Path(os.path.expandvars(args.projects_dir)).expanduser()
SERVER_URLS = {
    "tts": args.tts_url,
    "sfx": args.sfx_url,
    "music": args.music_url,
    "post": args.post_url,
    "chatterbox": args.chatterbox_url,
    "rvc": args.rvc_url,
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

_HEAVY_SERVERS = {"tts", "music", "chatterbox", "rvc"}


def _auto_unload_others(active: str) -> None:
    """If single_model_mode is enabled, unload all heavy servers except `active`.

    Enabled by either the --single-model-mode CLI flag or the Tauri app's
    persisted single_model_mode setting (read from config.json if present).
    """
    enabled = args.single_model_mode or _cfg().get("single_model_mode", False)
    if not enabled:
        return
    for server in _HEAVY_SERVERS:
        if server == active:
            continue
        try:
            _post(server, "/unload", {})
        except Exception:
            pass  # server may not be running


# ── Inference proxy helpers ───────────────────────────────────────────────────

def _is_remote(server: str) -> bool:
    """True when the inference server is NOT running on this machine.

    We detect this by checking the configured URL's hostname.  If it's
    anything other than 127.0.0.1 / localhost / ::1 we treat it as remote
    and apply the upload/download path-remapping logic so Mac paths never
    reach a Linux server.
    """
    url = SERVER_URLS.get(server, "")
    host = url.split("://")[-1].split(":")[0].split("/")[0]
    return host not in ("127.0.0.1", "localhost", "::1", "")


# job_id → (server, intended_local_output_path)
# Populated by _post when the server is remote and the body contains output_path.
# Consumed (and removed) by _resolve_job_output once the job completes.
_pending_downloads: dict[str, tuple[str, str]] = {}


def _download_job_output(server: str, job_id: str, local_path: str) -> str:
    """Download a completed remote job's output file to *local_path*.

    Calls GET /files/{job_id} which streams the file and then deletes it from
    the server, keeping server-output/ clean automatically.
    """
    url = SERVER_URLS[server] + f"/files/{job_id}"
    dest = Path(local_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    resp = httpx.get(url, timeout=120.0)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    log.info("Downloaded job %s → %s", job_id, local_path)
    return local_path


def _resolve_job_output(server: str, job_id: str, result: dict) -> dict:
    """If *job_id* has a pending remote download and the job is complete,
    download the file to the originally-intended local path and update
    result['output_path'] to that local path."""
    if result.get("status") != "complete":
        return result
    if job_id not in _pending_downloads:
        return result
    dl_server, local_path = _pending_downloads.pop(job_id)
    try:
        _download_job_output(dl_server, job_id, local_path)
        return {**result, "output_path": local_path}
    except Exception as exc:
        log.error("Download failed for job %s: %s", job_id, exc)
        return {**result, "download_error": str(exc)}


def _upload_input_file(server: str, local_path: str) -> str:
    """Upload a local file to the inference server's /upload endpoint.

    Used when input files (ref_audio, source_audio, etc.) are on the local
    machine but the server is remote.  Returns the server-side path.
    """
    if not local_path:
        return local_path
    p = Path(local_path)
    if not p.is_file():
        raise FileNotFoundError(f"Input file not found: {local_path}")
    url = SERVER_URLS[server] + "/upload"
    resp = httpx.post(
        url,
        content=p.read_bytes(),
        params={"filename": p.name},
        headers={"content-type": "application/octet-stream"},
        timeout=120.0,
    )
    resp.raise_for_status()
    server_path = resp.json()["server_path"]
    log.info("Uploaded %s → %s:%s", local_path, server, server_path)
    return server_path


def _post(server: str, path: str, body: dict,
          upload_fields: tuple[str, ...] = ()) -> dict:
    """POST to an inference server.

    Remote-mode path handling (applied automatically when _is_remote(server)):
    - output_path is cleared so the server generates a path in server-output/;
      the intended local path is registered in _pending_downloads so
      _resolve_job_output can download the file once the job completes.
    - Any fields named in *upload_fields* that contain local file paths are
      uploaded to /upload first and replaced with the returned server path.
    """
    url = SERVER_URLS[server] + path
    intended_output = body.get("output_path", "")

    if _is_remote(server):
        body = dict(body)  # don't mutate caller's dict
        if intended_output:
            body["output_path"] = ""
        for field in upload_fields:
            if body.get(field):
                body[field] = _upload_input_file(server, body[field])

    try:
        resp = httpx.post(url, json=body, timeout=10.0)
        resp.raise_for_status()
        result = resp.json()
    except httpx.ConnectError:
        raise RuntimeError(f"{server} server not reachable at {SERVER_URLS[server]}. Start it first.")

    if _is_remote(server) and intended_output and "job_id" in result:
        _pending_downloads[result["job_id"]] = (server, intended_output)

    return result


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
def create_project(
    title: str,
    logline: str = "",
    tone: str = "",
    synopsis: str = "",
    global_audio_notes: str = "",
    target_duration_minutes: int = 30,
) -> str:
    """
    Create a new Pharaoh project and return its project_id.
    Sets up the directory structure (scenes/, output/), project.json, and an
    empty storyboard.json. Call this before create_scene or add_character.

    Returns: {"ok": true, "project_id": "...", "title": "..."}
    """
    project_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    project = {
        "id": project_id,
        "title": title,
        "logline": logline,
        "synopsis": synopsis,
        "tone": tone,
        "global_audio_notes": global_audio_notes,
        "target_duration_minutes": target_duration_minutes,
        "created_at": now,
        "updated_at": now,
        "characters": [],
        "llm_config": {
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "api_key_env": "ANTHROPIC_API_KEY",
        },
    }

    proj_dir = _project_dir(project_id)
    (proj_dir / "scenes").mkdir(parents=True, exist_ok=True)
    (proj_dir / "output").mkdir(parents=True, exist_ok=True)
    (proj_dir / "project.json").write_text(json.dumps(project, indent=2))
    (proj_dir / "storyboard.json").write_text(json.dumps({"scenes": []}, indent=2))

    log.info("created project %s: %s", project_id, title)
    return json.dumps({"ok": True, "project_id": project_id, "title": title})


@mcp.tool()
def add_character(
    project_id: str,
    name: str,
    description: str = "",
    voice_model: str = "Chatterbox",
    speaker: str = "",
    base_voice_description: str = "",
) -> str:
    """
    Add a character to an existing project.

    voice_model options:
      "Chatterbox"  — palette-guided zero-shot clone (recommended)
      "VoiceDesign" — Qwen3-TTS text-described voice
      "Clone"       — ref-audio clone
      "FineTuned"   — trained model

    base_voice_description: Qwen3-TTS VoiceDesign prompt that anchors this
    character's vocal identity. Required for Chatterbox/VoiceDesign workflows.

    Returns: {"ok": true, "character_id": "...", "name": "..."}
    """
    proj_path = _project_dir(project_id) / "project.json"
    if not proj_path.exists():
        return json.dumps({"error": f"project not found: {project_id}"})

    project = json.loads(proj_path.read_text())
    char_id = str(uuid.uuid4())
    project["characters"].append({
        "id": char_id,
        "name": name,
        "description": description,
        "voice_assignment": {
            "model": voice_model,
            "speaker": speaker or None,
            "instruct_default": None,
            "ref_audio_path": None,
            "ref_transcript": None,
            "base_voice_description": base_voice_description,
            "emotional_palette": [],
            "rvc_model_path": None,
            "rvc_index_path": None,
            "rvc_pitch_shift": 0,
            "rvc_index_rate": 0.5,
            "rvc_protect": 0.33,
            "rvc_enabled": False,
        },
    })
    project["updated_at"] = datetime.now(timezone.utc).isoformat()
    proj_path.write_text(json.dumps(project, indent=2))

    log.info("added character %s (%s) to project %s", name, char_id, project_id)
    return json.dumps({"ok": True, "character_id": char_id, "name": name})


@mcp.tool()
def create_scene(
    project_id: str,
    title: str,
    index: int,
    description: str = "",
    location: str = "",
) -> str:
    """
    Add a scene to a project's storyboard and create its directory structure.

    Slug is auto-derived from index + title:
      index=1, title="Descent" → slug="01_descent"

    Creates:
      scenes/<slug>/assets/
      scenes/<slug>/render/
      scenes/<slug>/script.csv  (empty, with header row)

    Returns: {"ok": true, "scene_slug": "...", "scene_id": "..."}
    """
    slug = f"{index:02d}_{re.sub(r'[^a-z0-9_]', '', title.lower().replace(' ', '_'))}"

    scene = {
        "id": str(uuid.uuid4()),
        "index": index,
        "slug": slug,
        "title": title,
        "description": description,
        "location": location,
        "characters": [],
        "notes": "",
        "connects_from": None,
        "connects_to": None,
        "status": "draft",
    }

    scene_dir = _scene_dir(project_id, slug)
    (scene_dir / "assets").mkdir(parents=True, exist_ok=True)
    (scene_dir / "render").mkdir(parents=True, exist_ok=True)
    (scene_dir / "script.csv").write_text(
        "scene,track,type,character,prompt,file,start_ms,duration_ms,"
        "loop,pan,gain_db,instruct,fade_in_ms,fade_out_ms,reverb_send,notes\n",
        encoding="utf-8",
    )

    storyboard_path = _project_dir(project_id) / "storyboard.json"
    storyboard = _storyboard_json(project_id)
    storyboard["scenes"].append(scene)
    storyboard["scenes"].sort(key=lambda s: s["index"])
    storyboard_path.write_text(json.dumps(storyboard, indent=2))

    proj_path = _project_dir(project_id) / "project.json"
    if proj_path.exists():
        project = json.loads(proj_path.read_text())
        project["updated_at"] = datetime.now(timezone.utc).isoformat()
        proj_path.write_text(json.dumps(project, indent=2))

    log.info("created scene %s in project %s", slug, project_id)
    return json.dumps({"ok": True, "scene_slug": slug, "scene_id": scene["id"]})


@mcp.tool()
def write_script(
    project_id: str,
    scene_slug: str,
    rows: list,
) -> str:
    """
    Write or replace the full script for a scene in a single call.

    Each row is a dict. Required fields: type, prompt.
    Optional fields (default to ""): scene, track, character, file,
      start_ms, duration_ms, loop, pan, gain_db, instruct,
      fade_in_ms, fade_out_ms, reverb_send, notes.

    type values: DIALOGUE, SFX, BED, MUSIC, DIRECTION
    DIRECTION rows carry no audio — use them for composition notes.

    Overwrites any existing script.csv. Use update_script_row for
    targeted single-row edits after initial population.

    Returns: {"ok": true, "rows_written": N}
    """
    FIELDS = [
        "scene", "track", "type", "character", "prompt", "file",
        "start_ms", "duration_ms", "loop", "pan", "gain_db", "instruct",
        "fade_in_ms", "fade_out_ms", "reverb_send", "notes",
    ]
    normalized = []
    for r in rows:
        row = {f: r.get(f, "") for f in FIELDS}
        if not row["scene"]:
            row["scene"] = scene_slug
        normalized.append(row)

    _write_script_rows(project_id, scene_slug, normalized)
    log.info("wrote %d script rows for %s/%s", len(normalized), project_id, scene_slug)
    return json.dumps({"ok": True, "rows_written": len(normalized)})


# ── Project / Scene / Character metadata ──────────────────────────────────────

@mcp.tool()
def list_projects() -> str:
    """
    List all projects in the projects directory.
    Returns id, title, logline, tone, character_count, and updated_at for each,
    sorted newest-first. Use this at the start of a session to discover projects.
    """
    if not PROJECTS_DIR.exists():
        return json.dumps([])
    results = []
    for entry in PROJECTS_DIR.iterdir():
        proj_file = entry / "project.json"
        if not proj_file.exists():
            continue
        try:
            p = json.loads(proj_file.read_text())
            results.append({
                "id": p.get("id"),
                "title": p.get("title"),
                "logline": p.get("logline", ""),
                "tone": p.get("tone", ""),
                "character_count": len(p.get("characters", [])),
                "updated_at": p.get("updated_at"),
            })
        except Exception:
            continue
    results.sort(key=lambda p: p.get("updated_at") or "", reverse=True)
    return json.dumps(results, indent=2)


@mcp.tool()
def get_project(project_id: str) -> str:
    """
    Return the full project metadata: title, logline, synopsis, tone,
    global_audio_notes, target_duration_minutes, characters, and llm_config.
    """
    return json.dumps(_project_json(project_id), indent=2)


@mcp.tool()
def update_project(
    project_id: str,
    title: str = "",
    logline: str = "",
    synopsis: str = "",
    tone: str = "",
    global_audio_notes: str = "",
    target_duration_minutes: int = 0,
) -> str:
    """
    Update top-level project metadata. Only supply fields you want to change —
    empty string or 0 means "no change". Touches updated_at automatically.
    """
    proj_path = _project_dir(project_id) / "project.json"
    project = _project_json(project_id)
    if title:
        project["title"] = title
    if logline:
        project["logline"] = logline
    if synopsis:
        project["synopsis"] = synopsis
    if tone:
        project["tone"] = tone
    if global_audio_notes:
        project["global_audio_notes"] = global_audio_notes
    if target_duration_minutes > 0:
        project["target_duration_minutes"] = target_duration_minutes
    project["updated_at"] = datetime.now(timezone.utc).isoformat()
    proj_path.write_text(json.dumps(project, indent=2))
    return json.dumps({"ok": True, "project_id": project_id})


@mcp.tool()
def list_scenes(project_id: str) -> str:
    """
    Return all scenes in a project's storyboard sorted by index.
    Each entry includes slug, title, description, location, status, and characters.
    """
    storyboard = _storyboard_json(project_id)
    return json.dumps(storyboard.get("scenes", []), indent=2)


@mcp.tool()
def get_scene(project_id: str, scene_slug: str) -> str:
    """
    Return full metadata for a single scene identified by its slug.
    """
    for scene in _storyboard_json(project_id).get("scenes", []):
        if scene.get("slug") == scene_slug:
            return json.dumps(scene, indent=2)
    return json.dumps({"error": f"scene not found: {scene_slug}"})


@mcp.tool()
def update_scene(
    project_id: str,
    scene_slug: str,
    title: str = "",
    description: str = "",
    location: str = "",
    notes: str = "",
    status: str = "",
) -> str:
    """
    Update scene metadata in storyboard.json.
    Only supply fields you want to change — empty string means "no change".
    status values: draft, generating, assets_ready, composed, rendered.
    """
    storyboard_path = _project_dir(project_id) / "storyboard.json"
    storyboard = _storyboard_json(project_id)
    for scene in storyboard.get("scenes", []):
        if scene.get("slug") == scene_slug:
            if title:
                scene["title"] = title
            if description:
                scene["description"] = description
            if location:
                scene["location"] = location
            if notes:
                scene["notes"] = notes
            if status:
                scene["status"] = status
            storyboard_path.write_text(json.dumps(storyboard, indent=2))
            proj_path = _project_dir(project_id) / "project.json"
            if proj_path.exists():
                project = json.loads(proj_path.read_text())
                project["updated_at"] = datetime.now(timezone.utc).isoformat()
                proj_path.write_text(json.dumps(project, indent=2))
            return json.dumps({"ok": True, "scene_slug": scene_slug})
    return json.dumps({"error": f"scene not found: {scene_slug}"})


@mcp.tool()
def list_characters(project_id: str) -> str:
    """
    Return all characters in a project with their id, name, description,
    and voice_assignment (model, speaker, base_voice_description, rvc_enabled, etc.).
    """
    return json.dumps(_project_json(project_id).get("characters", []), indent=2)


@mcp.tool()
def update_character(
    project_id: str,
    character_id: str,
    name: str = "",
    description: str = "",
    voice_model: str = "",
    speaker: str = "",
    base_voice_description: str = "",
    instruct_default: str = "",
) -> str:
    """
    Update a character's metadata or voice_assignment fields.
    Only supply fields you want to change — empty string means "no change".

    voice_model: "Chatterbox" | "VoiceDesign" | "Clone" | "FineTuned"
    base_voice_description: Qwen3-TTS VoiceDesign prompt for this character.
    instruct_default: Default generation instruction appended to TTS prompts.
    """
    proj_path = _project_dir(project_id) / "project.json"
    project = _project_json(project_id)
    for char in project.get("characters", []):
        if char["id"] == character_id:
            if name:
                char["name"] = name
            if description:
                char["description"] = description
            va = char.setdefault("voice_assignment", {})
            if voice_model:
                va["model"] = voice_model
            if speaker:
                va["speaker"] = speaker
            if base_voice_description:
                va["base_voice_description"] = base_voice_description
            if instruct_default:
                va["instruct_default"] = instruct_default
            project["updated_at"] = datetime.now(timezone.utc).isoformat()
            proj_path.write_text(json.dumps(project, indent=2))
            return json.dumps({"ok": True, "character_id": character_id})
    return json.dumps({"error": f"character not found: {character_id}"})


@mcp.tool()
def delete_character(project_id: str, character_id: str) -> str:
    """
    Remove a character from a project.
    Does NOT delete generated audio or palette files — those remain on disk.
    """
    proj_path = _project_dir(project_id) / "project.json"
    project = _project_json(project_id)
    before = len(project.get("characters", []))
    project["characters"] = [c for c in project.get("characters", []) if c["id"] != character_id]
    if len(project["characters"]) == before:
        return json.dumps({"error": f"character not found: {character_id}"})
    project["updated_at"] = datetime.now(timezone.utc).isoformat()
    proj_path.write_text(json.dumps(project, indent=2))
    return json.dumps({"ok": True, "removed": 1})


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
                        }, upload_fields=("ref_audio_path",))
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
    }, upload_fields=("ref_audio_path",))
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
    result = _resolve_job_output(server, job_id, result)
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
            result = _resolve_job_output(server, job_id, result)
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


# ── Asset metadata & take management ─────────────────────────────────────────

@mcp.tool()
def read_asset_meta(audio_path: str) -> str:
    """
    Read the .meta.json sidecar for a generated audio file.
    Returns model, prompt, seed, qa_status, duration_actual_ms, take_index,
    parent, generated_at, and other generation parameters.
    Returns {"error": "..."} if no sidecar exists.
    """
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": f"no sidecar for: {audio_path}"})
    return json.dumps(meta, indent=2)


@mcp.tool()
def list_asset_takes(audio_path: str) -> str:
    """
    Enumerate all take files for a given base audio path.
    Scans the parent directory for files matching the stem (e.g. all takes of
    "mira_line_01.wav" that share the same stem prefix).
    Returns takes sorted by take_index with paths, qa_status, and metadata.
    """
    p = Path(audio_path)
    stem = p.stem
    takes = []
    for meta_file in sorted(p.parent.glob(f"{stem}*.wav.meta.json")):
        wav = meta_file.parent / meta_file.name.removesuffix(".meta.json")
        if not wav.exists():
            continue
        try:
            meta = json.loads(meta_file.read_text())
        except Exception:
            continue
        takes.append({
            "audio_path": str(wav),
            "take_index": meta.get("take_index", 0),
            "model": meta.get("model", ""),
            "qa_status": meta.get("qa_status", "unreviewed"),
            "duration_ms": meta.get("duration_actual_ms"),
            "generated_at": meta.get("generated_at", ""),
            "seed": meta.get("seed"),
        })
    takes.sort(key=lambda t: t["take_index"])
    return json.dumps(takes, indent=2)


@mcp.tool()
def list_palette_takes(project_id: str, character_id: str, emotion: str) -> str:
    """
    List all palette take WAV files for a character/emotion combination.
    Palette takes live in characters/{character_id}/palette/ named like
    "{emotion}_{timestamp}.wav". Sorted oldest to newest.
    """
    palette_dir = _project_dir(project_id) / "characters" / character_id / "palette"
    if not palette_dir.exists():
        return json.dumps([])
    files = []
    for f in sorted(palette_dir.glob(f"{emotion}_*.wav")):
        meta = _read_meta(str(f))
        files.append({
            "path": str(f),
            "qa_status": meta.get("qa_status", "unreviewed") if meta else "unreviewed",
            "seed": meta.get("seed") if meta else None,
            "generated_at": meta.get("generated_at", "") if meta else "",
        })
    return json.dumps(files, indent=2)


@mcp.tool()
def list_rvc_models(project_id: str, character_id: str) -> str:
    """
    List trained RVC models available for a character.
    Scans characters/{character_id}/rvc/ for .pth files and checks for a
    matching .index (FAISS) file. Returns name, pth_path, index_path, size_bytes.
    """
    rvc_dir = _project_dir(project_id) / "characters" / character_id / "rvc"
    if not rvc_dir.exists():
        return json.dumps([])
    models = []
    for pth in sorted(rvc_dir.glob("*.pth")):
        index = pth.with_suffix(".index")
        models.append({
            "name": pth.stem,
            "pth_path": str(pth),
            "index_path": str(index) if index.exists() else None,
            "size_bytes": pth.stat().st_size,
        })
    return json.dumps(models, indent=2)


# ── Post-processing (ffmpeg-local + AudioSR) ──────────────────────────────────

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
        return False, "ffmpeg not found — install ffmpeg"
    except subprocess.TimeoutExpired:
        return False, "ffmpeg timed out"


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
        return json.dumps({"error": f"source not found: {source_path}"})

    stem = re.sub(r"[^a-z0-9_\-]", "_", (label or source.stem).lower()).strip("_") or "audio"
    imports_dir = _project_dir(project_id) / "scenes" / "__imports" / "assets"
    imports_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    output = str(imports_dir / f"{stem}.import.{ts}.wav")

    ok, err = _run_ffmpeg(["-y", "-i", source_path, "-ar", "48000", "-ac", "1", output])
    if not ok:
        return json.dumps({"error": err})

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
        return json.dumps({"error": f"file not found: {audio_path}"})

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
        return json.dumps({"error": err})

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
        return json.dumps({"error": f"file not found: {audio_path}"})

    output = audio_path.removesuffix(".wav") + ".norm.wav"
    ok, err = _run_ffmpeg([
        "-y", "-i", audio_path,
        "-af", f"loudnorm=I={target_lufs:.1f}:TP=-1.5:LRA=11",
        "-ar", "48000", "-ac", "2", output,
    ])
    if not ok:
        return json.dumps({"error": err})

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
        return json.dumps({"error": f"file not found: {audio_path}"})

    if not output_path:
        output_path = audio_path.removesuffix(".wav") + ".48k.wav"

    ok, err = _run_ffmpeg(["-y", "-i", audio_path, "-ar", "48000", "-ac", "2", output_path])
    if not ok:
        return json.dumps({"error": err})

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
        return json.dumps({"error": f"file not found: {audio_path}"})

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
        return json.dumps({"error": str(e)})

    return json.dumps({
        "ok": True,
        "job_id": server_job_id,
        "output_path": output_path,
        "poll": "job_status('post', job_id)",
    })


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
def load_model(server: str) -> str:
    """
    Preload an inference model into VRAM on the given server.
    Call this before starting a generation batch to avoid cold-start latency on
    the first job. Complement with unload_model when switching servers.

    server: "tts" | "sfx" | "music" | "chatterbox" | "rvc" | "post"
    """
    try:
        resp = _post(server, "/load", {})
        return json.dumps(resp)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def get_server_config() -> str:
    """
    Return the currently configured inference server URLs.
    Useful for verifying which endpoints the MCP server is pointed at,
    especially when running remote or split inference.
    """
    return json.dumps({
        "tts": SERVER_URLS["tts"],
        "sfx": SERVER_URLS["sfx"],
        "music": SERVER_URLS["music"],
        "post": SERVER_URLS["post"],
        "chatterbox": SERVER_URLS["chatterbox"],
        "rvc": SERVER_URLS["rvc"],
        "projects_dir": str(PROJECTS_DIR),
    }, indent=2)


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

    # Locate the pharaoh CLI binary.
    # Search order: PATH first (works when installed as MCPB or binary in PATH),
    # then repo-relative paths (works when running from a local dev checkout).
    exe_name = "pharaoh.exe" if sys.platform == "win32" else "pharaoh"
    which_result = shutil.which(exe_name)
    mcp_dir = Path(__file__).parent
    repo_root = mcp_dir.parent.parent
    cli_candidates = [
        repo_root / "target" / "release" / exe_name,
        repo_root / "target" / "debug" / exe_name,
        repo_root / "src-tauri" / "target" / "release" / exe_name,
        repo_root / "src-tauri" / "target" / "debug" / exe_name,
    ]
    cli_path = which_result or next((str(c) for c in cli_candidates if c.exists()), None)
    if cli_path is None:
        return json.dumps({
            "error": (
                "pharaoh CLI binary not found. "
                "Either add it to PATH or build with: cargo build --release"
            ),
            "searched": ["PATH"] + [str(c) for c in cli_candidates],
        })

    result = subprocess.run(
        [cli_path, "compose", "render", "scene", project_id, scene_slug],
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
    exe_name = "pharaoh.exe" if sys.platform == "win32" else "pharaoh"
    which_result = shutil.which(exe_name)
    repo_root = Path(__file__).parent.parent.parent
    cli_candidates = [
        repo_root / "target" / "release" / exe_name,
        repo_root / "target" / "debug" / exe_name,
        repo_root / "src-tauri" / "target" / "release" / exe_name,
        repo_root / "src-tauri" / "target" / "debug" / exe_name,
    ]
    cli_path = which_result or next((str(c) for c in cli_candidates if c.exists()), None)
    if cli_path is None:
        return json.dumps({
            "error": (
                "pharaoh CLI binary not found. "
                "Either add it to PATH or build with: cargo build --release"
            ),
            "searched": ["PATH"] + [str(c) for c in cli_candidates],
        })

    result = subprocess.run(
        [cli_path, "compose", "final", project_id, "--crossfade", str(crossfade_ms)],
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


# ── RVC voice pipeline tools ─────────────────────────────────────────────────

@mcp.tool()
def corpus_status(project_id: str, character_id: str) -> str:
    """
    Return corpus build status for a character's RVC training data.

    Shows the count of WAV files in characters/{character_id}/rvc_corpus/,
    their total duration, and whether the corpus meets the 5-minute minimum
    recommended for good RVC training results.

    Run this before build_corpus to see current state, and after to verify
    the corpus is ready for train_rvc_model.
    """
    proj = _project_json(project_id)
    char_dir = _project_dir(project_id) / "characters" / character_id
    corpus_dir = char_dir / "rvc_corpus"

    files = list(corpus_dir.glob("*.wav")) if corpus_dir.exists() else []
    total_ms = 0
    for wav in files:
        meta_path = wav.parent / (wav.name + ".meta.json")
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                total_ms += meta.get("duration_actual_ms") or meta.get("duration_ms") or 0
            except Exception:
                pass

    ready = total_ms >= 5 * 60 * 1000  # 5 minutes
    return json.dumps({
        "character_id": character_id,
        "corpus_dir": str(corpus_dir),
        "file_count": len(files),
        "total_duration_ms": total_ms,
        "total_duration_min": round(total_ms / 60000, 1),
        "ready_for_training": ready,
        "recommendation": (
            "Ready for training." if ready
            else f"Need {round((5*60000 - total_ms)/60000, 1)} more minutes of audio. Run build_corpus."
        ),
    }, indent=2)


@mcp.tool()
def build_corpus(
    project_id: str,
    character_id: str,
    target_count: int = 50,
) -> str:
    """
    Generate a Chatterbox corpus for RVC training (Stage 3 of voice pipeline).

    Generates `target_count` takes of the character's palette test line across
    all approved emotional states. Each take uses a different paralinguistic
    tag combination ([sigh], [chuckle], [laugh], [gasp], [clears throat], [hmm])
    so the resulting corpus covers the character's expressive range.

    Output: characters/{character_id}/rvc_corpus/{emotion}_{i}.wav
    Uses the character's approved palette reference WAVs as Chatterbox clone sources.

    PREREQUISITES: Stage 2 must be complete — at least 2 approved palette entries.
    This is a long-running operation. Returns a list of job_ids.
    Poll job_status(job_id) on each to track progress (~8 min total on GPU).

    Args:
        target_count: Total WAVs to generate across all emotions (default 50).
    """
    proj = _project_json(project_id)
    char = next(
        (c for c in proj.get("characters", []) if c["id"] == character_id),
        None,
    )
    if char is None:
        return json.dumps({"error": f"character {character_id} not found in project.json"})

    palette = char.get("voice_assignment", {}).get("emotional_palette", [])
    approved = [e for e in palette if e.get("qa_status") == "approved" and e.get("ref_audio_path")]
    if not approved:
        return json.dumps({"error": "No approved palette entries found. Complete Stage 2 first."})

    # Paralinguistic tag variants: the same line is generated clean and with each
    # tag in prefix + suffix position to maximise prosodic variety in the corpus.
    tag_variants = [
        "",                   # clean (no tag) — baseline voice
        "[sigh] ",            # prefix sigh
        "[chuckle] ",
        "[laugh] ",
        "[gasp] ",
        "[clears throat] ",
        "[hmm] ",
        " [sigh]",            # suffix sigh (different prosodic shape)
        " [chuckle]",
        " [laugh]",
    ]

    # Use a fixed corpus test line — NOT instruct_default (which is a voice description,
    # not a line of speech). Rotate through varied lines so the corpus has prosodic diversity.
    _CORPUS_TEST_LINES = [
        "And then she said — nothing at all.",
        "The signal was gone before I could trace it.",
        "I knew what it meant. I just didn't want to say it out loud.",
        "Something is wrong with the archive.",
        "You were never supposed to find this.",
        "Three days. That's all we had.",
        "It doesn't matter anymore. None of it does.",
        "She looked at me like I was already gone.",
        "I've seen that look before. It never ends well.",
        "The door was open. It shouldn't have been.",
    ]
    char_dir = _project_dir(project_id) / "characters" / character_id
    corpus_dir = char_dir / "rvc_corpus"
    corpus_dir.mkdir(parents=True, exist_ok=True)

    per_emotion = max(1, target_count // len(approved))
    job_ids = []
    global_take = 0  # used to rotate test lines across all takes

    for entry in approved:
        emotion = entry["emotion"]
        ref_path = entry["ref_audio_path"]
        tag_cycle = tag_variants * ((per_emotion // len(tag_variants)) + 1)

        for i in range(per_emotion):
            tag = tag_cycle[i % len(tag_variants)]
            # Rotate through varied test lines for prosodic diversity
            base_line = _CORPUS_TEST_LINES[global_take % len(_CORPUS_TEST_LINES)]
            text = f"{tag}{base_line}" if tag.startswith("[") else f"{base_line}{tag}" if tag else base_line
            global_take += 1
            out_path = str(corpus_dir / f"{emotion}_{i:03d}.wav")

            try:
                resp = _post("chatterbox", "/generate/clone", {
                    "text": text.strip(),
                    "ref_audio_path": ref_path,
                    "exaggeration": 0.45,
                    "cfg_weight": 0.5,
                    "temperature": 0.8,
                    "seed": i,
                    "output_path": out_path,
                }, upload_fields=("ref_audio_path",))
                job_ids.append(resp.get("job_id", "unknown"))
            except Exception as exc:
                return json.dumps({"error": str(exc), "partial_job_ids": job_ids})

    return json.dumps({
        "status": "queued",
        "total_takes": len(job_ids),
        "job_ids": job_ids,
        "corpus_dir": str(corpus_dir),
        "note": "Poll job_status(job_id) for each. Takes ~8 min total. Then run train_rvc_model.",
    }, indent=2)


@mcp.tool()
def train_rvc_model(project_id: str, character_id: str, epochs: int = 100) -> str:
    """
    Train an RVC voice model from the character's Chatterbox corpus (Stage 4).

    Scans characters/{character_id}/rvc_corpus/ for WAV files and submits a
    training job to the RVC server (port 18006). Training typically takes
    10–20 minutes on GPU.

    Output files:
      characters/{character_id}/rvc/{character_name}.pth    ← voice model
      characters/{character_id}/rvc/{character_name}.index  ← FAISS index

    PREREQUISITES: corpus_status() must show ready_for_training == true
    (at least 5 minutes / ~20+ WAV files in rvc_corpus/).

    Returns a job_id. Poll job_status(job_id) until status == "complete".
    """
    proj = _project_json(project_id)
    char = next(
        (c for c in proj.get("characters", []) if c["id"] == character_id),
        None,
    )
    if char is None:
        return json.dumps({"error": f"character {character_id} not found"})

    char_name = char.get("name", "voice").replace(" ", "_").lower()
    char_dir = _project_dir(project_id) / "characters" / character_id
    corpus_dir = char_dir / "rvc_corpus"
    rvc_dir = char_dir / "rvc"
    rvc_dir.mkdir(parents=True, exist_ok=True)

    corpus_wavs = sorted(corpus_dir.glob("*.wav")) if corpus_dir.exists() else []
    if not corpus_wavs:
        return json.dumps({"error": "rvc_corpus/ is empty. Run build_corpus first."})

    try:
        resp = _post("rvc", "/train", {
            "corpus_paths": [str(p) for p in corpus_wavs],
            "output_model_path": str(rvc_dir / f"{char_name}.pth"),
            "output_index_path": str(rvc_dir / f"{char_name}.index"),
            "character_name": char_name,
            "sample_rate": 48000,
            "epochs": epochs,
        })
        return json.dumps({
            "job_id": resp.get("job_id"),
            "status": "training_started",
            "corpus_files": len(corpus_wavs),
            "output_dir": str(rvc_dir),
            "note": "Training takes 10–20 min on GPU. Poll job_status(job_id).",
        }, indent=2)
    except Exception as exc:
        return json.dumps({"error": str(exc)})


@mcp.tool()
def rvc_convert(
    project_id: str,
    character_id: str,
    input_path: str,
    output_path: str,
    pitch_shift: int = 0,
    index_rate: float = 0.5,
) -> str:
    """
    Convert a single audio file using the character's trained RVC model.

    Use this to:
    - Test the pipeline on a sample line before committing to full production
    - Manually apply the RVC pass to a specific Chatterbox take
    - A/B compare Chatterbox-only vs Chatterbox+RVC output

    The character must have a trained RVC model (Stage 4 complete).
    generate_tts() applies this automatically when rvc_enabled is true.

    Args:
        input_path:   Absolute path to Chatterbox output WAV.
        output_path:  Where to write the RVC-converted WAV.
        pitch_shift:  Semitones (default 0). Use negative to lower pitch.
        index_rate:   0–1. Lower preserves [sigh][chuckle] tags; higher = more consistent.
    """
    proj = _project_json(project_id)
    char = next(
        (c for c in proj.get("characters", []) if c["id"] == character_id),
        None,
    )
    if char is None:
        return json.dumps({"error": f"character {character_id} not found"})

    va = char.get("voice_assignment", {})
    model_path = va.get("rvc_model_path")
    index_path = va.get("rvc_index_path", "")

    if not model_path or not Path(model_path).exists():
        char_name = char.get("name", "voice").replace(" ", "_").lower()
        char_dir = _project_dir(project_id) / "characters" / character_id
        # Try the conventional location
        fallback = char_dir / "rvc" / f"{char_name}.pth"
        if fallback.exists():
            model_path = str(fallback)
        else:
            return json.dumps({
                "error": "No trained RVC model found. Run train_rvc_model first.",
                "looked_for": [str(fallback)],
            })

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    try:
        resp = _post("rvc", "/convert", {
            "input_path": input_path,
            "output_path": output_path,
            "model_path": model_path,
            "index_path": index_path,
            "pitch_shift": pitch_shift,
            "f0_method": "rmvpe",
            "index_rate": index_rate,
            "filter_radius": 3,
            "rms_mix_rate": 0.25,
            "protect": va.get("rvc_protect", 0.33),
        }, upload_fields=("input_path",))
        return json.dumps(resp, indent=2)
    except Exception as exc:
        return json.dumps({"error": str(exc)})


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("Pharaoh MCP server starting (transport=%s, projects=%s)", args.transport, PROJECTS_DIR)
    if args.transport == "sse":
        _add_health_route(mcp)
        mcp.run(transport="sse", host=args.host, port=args.port)
    else:
        mcp.run()
