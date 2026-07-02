# servers/mcp/projectfs.py

Filesystem helpers for on-disk Pharaoh project state. No network calls.

## Purpose

Everything that reads/writes the project layout under `PROJECTS_DIR`:
project.json, storyboard.json, script.csv, `.meta.json` sidecars, and the
character bundle directories. Tool modules build on these instead of touching
paths directly.

## Key helpers

| Helper | Contract |
|--------|----------|
| `_project_dir/_scene_dir/_character_dir` | canonical path construction |
| `_project_json` | raises FileNotFoundError (with valid-id hint) when missing |
| `_storyboard_json` | returns `{"scenes": []}` when missing (never raises) |
| `_script_rows/_write_script_rows` | script.csv as list[dict]; write is a no-op on empty rows |
| `_meta_path/_read_meta/_write_meta` | `.meta.json` sidecar convention; write is atomic (tmp+rename) |
| `_list_assets` | scene assets discovered by `*.wav.meta.json` scan |
| `_scene_pipeline_status` | per-scene progress record used by project_status/pipeline resource |
| `_resolve_voice_path/_relativize_voice_path` | Pharaoh-1qp relative-path handling for character bundles |
| `_spatial_space_slugs` | valid reverb space slugs from assets/spaces/spaces.json, or None outside the repo |
| `_known_characters/_known_scene_slugs` | human-readable lists for error messages |

## Rationale

Sidecars are the source of truth for QA state; script.csv is the source of
truth for composition. Keeping all path/sidecar conventions in one module
means a layout change touches exactly one file.
