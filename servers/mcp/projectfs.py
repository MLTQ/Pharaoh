"""
Filesystem helpers for Pharaoh project state.

Everything here reads/writes the on-disk project layout under PROJECTS_DIR:
project.json, storyboard.json, script.csv, .meta.json sidecars, and the
character bundle directories. No network calls.
"""
import csv
import json
from io import StringIO
from pathlib import Path

from config import PROJECTS_DIR


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def _project_json(project_id: str) -> dict:
    path = _project_dir(project_id) / "project.json"
    if not path.exists():
        raise FileNotFoundError(
            f"project not found: {project_id} (no project.json at {path}). "
            f"Use list_projects to see valid project ids."
        )
    return json.loads(path.read_text())


def _storyboard_json(project_id: str) -> dict:
    path = _project_dir(project_id) / "storyboard.json"
    if not path.exists():
        return {"scenes": []}
    return json.loads(path.read_text())


def _scene_dir(project_id: str, scene_slug: str) -> Path:
    return _project_dir(project_id) / "scenes" / scene_slug


def _character_dir(project_id: str, character_id: str) -> Path:
    return _project_dir(project_id) / "characters" / character_id


def _resolve_voice_path(project_id: str, character_id: str, path: str | None) -> str | None:
    """Resolve a path stored inside a character's voice_assignment to an absolute path.

    Pharaoh-1qp switched in-bundle path storage to relative; this helper handles
    both formats transparently:
      - absolute path → returned as-is (external Clip Studio refs etc.)
      - relative path → joined onto the character's bundle dir
      - empty / None → None
    """
    if not path:
        return None
    p = Path(path)
    if p.is_absolute():
        return str(p)
    return str(_character_dir(project_id, character_id) / p)


def _relativize_voice_path(project_id: str, character_id: str, path: str | None) -> str | None:
    """Inverse of :func:`_resolve_voice_path`. Used when MCP writes back to project.json.

    Paths inside the character's bundle become relative; paths outside (or already
    relative) stay as-is.
    """
    if not path:
        return None
    p = Path(path)
    if not p.is_absolute():
        return path
    bundle = _character_dir(project_id, character_id).resolve()
    try:
        rel = p.resolve().relative_to(bundle)
        return str(rel)
    except ValueError:
        return path


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


def _spatial_space_slugs() -> set[str] | None:
    """Read spaces.json from the repo's assets/spaces/ and return the set of
    known slugs. Returns None when the manifest can't be found so the caller
    can fall through (don't reject the value just because the MCP server is
    running outside the repo). Used by `spatialize_row` to validate the
    `space` argument."""
    # This module lives at servers/mcp/projectfs.py — repo root is two parents up.
    candidates = [
        Path(__file__).resolve().parent.parent.parent / "assets" / "spaces" / "spaces.json",
        Path.cwd() / "assets" / "spaces" / "spaces.json",
    ]
    for manifest in candidates:
        if manifest.is_file():
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                return {sp["slug"] for sp in data.get("spaces", []) if "slug" in sp}
            except (json.JSONDecodeError, KeyError, TypeError):
                return None
    return None


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


def _known_characters(project: dict) -> str:
    """Human-readable 'Name (id), …' list for character-not-found error messages."""
    chars = project.get("characters", [])
    if not chars:
        return "none — add one with add_character"
    return ", ".join(f"{c.get('name', '?')} ({c.get('id', '?')})" for c in chars)


def _known_scene_slugs(storyboard: dict) -> list[str]:
    """Scene slugs in a storyboard, for scene-not-found error messages."""
    return [s.get("slug", "?") for s in storyboard.get("scenes", [])]


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
