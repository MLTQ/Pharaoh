"""
pharaoh:// MCP resources — read-only views of project state.

Importing this module registers all resources against the shared FastMCP
instance from server.py.
"""
import json

from config import PROJECTS_DIR
from projectfs import (
    _list_assets,
    _project_json,
    _scene_pipeline_status,
    _script_rows,
    _storyboard_json,
)
from server import mcp


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
