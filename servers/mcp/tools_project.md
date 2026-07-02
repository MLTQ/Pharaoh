# servers/mcp/tools_project.py

MCP tools: project / scene / character / script CRUD.

## Purpose

Pure filesystem operations on project.json, storyboard.json, and script.csv —
no inference servers involved.

## Tools

| Tool | Notes |
|------|-------|
| `create_project` / `list_projects` / `get_project` / `update_project` / `project_status` | project.json lifecycle; project_status is the per-scene stage matrix |
| `create_scene` / `list_scenes` / `get_scene` / `update_scene` | storyboard.json; slug derived as `{index:02d}_{title}` |
| `add_character` / `list_characters` / `update_character` / `delete_character` | characters array in project.json; delete never removes audio on disk |
| `read_script` / `write_script` / `update_script_row` | script.csv; write_script replaces the whole file, update_script_row patches one row and refuses structural fields (scene/type) |
| `spatialize_row` | writes the five spatial columns (spatial_azimuth/elevation/path, spatial_space, reverb_send); validates space slugs against assets/spaces/spaces.json and waypoint shape; `clear=True` reverts to L/R panning |

## Invariants

- "Empty string / 0 means no change" convention on all update_* tools.
- Mutations touch `project.updated_at`.
- Error strings name the project/scene/character involved and list valid
  alternatives (known characters, available scene slugs).
