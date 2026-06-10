"""
MCP tools: project / scene / character / script CRUD.

Pure filesystem operations on project.json, storyboard.json, and script.csv —
no inference servers involved. Importing this module registers the tools
against the shared FastMCP instance from server.py.
"""
import json
import re
import uuid
from datetime import datetime, timezone

from config import PROJECTS_DIR, log
from projectfs import (
    _known_characters,
    _known_scene_slugs,
    _project_dir,
    _project_json,
    _scene_dir,
    _scene_pipeline_status,
    _script_rows,
    _spatial_space_slugs,
    _storyboard_json,
    _write_script_rows,
)
from server import mcp


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
    if not rows:
        return json.dumps({"error": (
            f"scene '{scene_slug}' in project {project_id} has no script rows "
            f"(script.csv missing or empty) — populate it with write_script first"
        )})
    if row_index < 0 or row_index >= len(rows):
        return json.dumps({"error": (
            f"row_index {row_index} out of range (0–{len(rows)-1}) "
            f"for scene '{scene_slug}' in project {project_id}"
        )})
    forbidden = {"scene", "type"}
    bad = [k for k in updates if k in forbidden]
    if bad:
        return json.dumps({"error": f"cannot update structural fields: {bad}"})
    rows[row_index].update(updates)
    _write_script_rows(project_id, scene_slug, rows)
    return json.dumps({"ok": True, "updated_row": rows[row_index]})


@mcp.tool()
def spatialize_row(
    project_id: str,
    scene_slug: str,
    row_index: int,
    azimuth: float | None = None,
    elevation: float | None = None,
    path: list | None = None,
    space: str | None = None,
    wet: float | None = None,
    clear: bool = False,
) -> str:
    """
    Place a single script row in 3D binaural space and/or apply a room reverb.

    Pharaoh's scene renderer reads five columns. The first three control
    binaural placement (HRTF via ffmpeg sofalizer):
      - spatial_azimuth   (0–360°, 0 = front, 90 = right, 180 = back, 270 = left)
      - spatial_elevation (-90..+90°, 0 = ear level)
      - spatial_path      (waypoint JSON for moving sources)
    The next two control room acoustics (afir convolution against a curated
    room IR), independent of placement — a clip can have a cathedral
    without binaural position, and vice versa:
      - spatial_space     (slug from assets/spaces/spaces.json — e.g.
                           "cathedral", "cave", "opera-house", "small-room")
      - reverb_send       (per-clip wet amount in [0, 1]; empty = use the
                           preset's default_wet)

    Arguments:
      azimuth   — optional fixed azimuth in degrees [0, 360). Wraps.
      elevation — optional fixed elevation in degrees [-90, +90]. Clamped.
      path      — optional list of waypoints for a moving source, e.g.
                  [{"t_frac":0,"az":270,"el":0},{"t_frac":1,"az":90,"el":0}]
                  for a left→right sweep across the full clip duration.
                  Each waypoint needs t_frac (0–1), az (degrees), el (degrees).
      space     — optional slug from spaces.json. Pass "" or "anechoic" for
                  dry/no room. Unknown slugs error with the valid list.
      wet       — optional wet/dry mix override in [0, 1]. Defaults to the
                  preset's default_wet when omitted.
      clear     — if True, wipes all five spatial columns and the row
                  reverts to legacy L/R amplitude panning. Cannot be combined
                  with other args.

    Returns: {"ok": true, "updated_row": {...}}
    """
    rows = _script_rows(project_id, scene_slug)
    if not rows:
        return json.dumps({"error": (
            f"scene '{scene_slug}' in project {project_id} has no script rows "
            f"(script.csv missing or empty) — populate it with write_script first"
        )})
    if row_index < 0 or row_index >= len(rows):
        return json.dumps({"error": (
            f"row_index {row_index} out of range (0–{len(rows)-1}) "
            f"for scene '{scene_slug}' in project {project_id}"
        )})

    updates: dict = {}
    if clear:
        if (azimuth is not None or elevation is not None or path is not None
                or space is not None or wet is not None):
            return json.dumps({"error": "clear=True cannot be combined with other spatial args"})
        updates["spatial_azimuth"] = ""
        updates["spatial_elevation"] = ""
        updates["spatial_path"] = ""
        updates["spatial_space"] = ""
        updates["reverb_send"] = ""
    else:
        if azimuth is not None:
            updates["spatial_azimuth"] = f"{azimuth % 360:.2f}"
        if elevation is not None:
            el = max(-90.0, min(90.0, float(elevation)))
            updates["spatial_elevation"] = f"{el:.2f}"
        if space is not None:
            # Validate against the manifest by scanning assets/spaces/spaces.json
            # so a typo doesn't silently disable reverb. Treat "anechoic"/""
            # as the dry baseline (no validation needed).
            slug = space.strip()
            if slug and slug not in ("anechoic", "dry"):
                valid = _spatial_space_slugs()
                if valid is not None and slug not in valid:
                    return json.dumps({"error": f"unknown space '{slug}'; valid: {sorted(valid)}"})
            updates["spatial_space"] = slug if slug != "anechoic" else ""
        if wet is not None:
            w = float(wet)
            if not (0.0 <= w <= 1.0):
                return json.dumps({"error": f"wet must be in [0, 1], got {wet}"})
            updates["reverb_send"] = f"{w:.3f}"
        if path is not None:
            # Validate waypoint shape: list of dicts each with numeric t_frac/az/el.
            if not isinstance(path, list):
                return json.dumps({"error": "path must be a list of waypoints"})
            cleaned = []
            for i, w in enumerate(path):
                if not isinstance(w, dict):
                    return json.dumps({"error": f"path[{i}] must be an object"})
                try:
                    t = float(w["t_frac"])
                    az = float(w["az"])
                    el = float(w["el"])
                except (KeyError, TypeError, ValueError) as e:
                    return json.dumps({"error": f"path[{i}] needs numeric t_frac/az/el ({e})"})
                cleaned.append({
                    "t_frac": max(0.0, min(1.0, t)),
                    "az": az % 360,
                    "el": max(-90.0, min(90.0, el)),
                })
            cleaned.sort(key=lambda w: w["t_frac"])
            updates["spatial_path"] = json.dumps(cleaned)

    if not updates:
        return json.dumps({"error": "no spatial args given; pass azimuth, elevation, path, or clear=True"})

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
        return json.dumps({"error": (
            f"project not found: {project_id} (no project.json at {proj_path}). "
            f"Use list_projects to see valid project ids."
        )})

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
    storyboard = _storyboard_json(project_id)
    for scene in storyboard.get("scenes", []):
        if scene.get("slug") == scene_slug:
            return json.dumps(scene, indent=2)
    return json.dumps({"error": (
        f"scene not found: {scene_slug} in project {project_id}. "
        f"Available scenes: {_known_scene_slugs(storyboard) or 'none — create one with create_scene'}"
    )})


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
    return json.dumps({"error": (
        f"scene not found: {scene_slug} in project {project_id}. "
        f"Available scenes: {_known_scene_slugs(storyboard) or 'none — create one with create_scene'}"
    )})


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
    return json.dumps({"error": (
        f"character not found: {character_id} in project {project_id}. "
        f"Known characters: {_known_characters(project)}"
    )})


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
        return json.dumps({"error": (
            f"character not found: {character_id} in project {project_id}. "
            f"Known characters: {_known_characters(project)}"
        )})
    project["updated_at"] = datetime.now(timezone.utc).isoformat()
    proj_path.write_text(json.dumps(project, indent=2))
    return json.dumps({"ok": True, "removed": 1})
