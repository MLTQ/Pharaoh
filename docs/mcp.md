# Pharaoh MCP server

`servers/mcp/` is a Python MCP server (FastMCP) that gives MCP clients —
Claude Desktop, Claude Code, other agents — tools and read-only resources over
Pharaoh projects. It works on the same project folders as the app and the
[CLI](cli.md), and sends generation to the same inference servers. It does not
load models itself and does not need the app running.

It is a separate implementation from the app (Python, not the Rust core), so
it lags behind on newer features; the comparison at the end says where.

## Connecting a client

**Claude Code** (this repo's setup): stdio, configured in `~/.claude.json`:

```json
"pharaoh": {
  "type": "stdio",
  "command": "python",
  "args": [
    "/Users/max/Code/Pharaoh/servers/mcp/run.py",
    "--projects-dir", "/Users/max/pharaoh-projects",
    "--tts-url", "http://192.168.0.202:18001",
    "--sfx-url", "http://192.168.0.202:18002",
    "--music-url", "http://192.168.0.202:18003",
    "--post-url", "http://192.168.0.202:18004",
    "--chatterbox-url", "http://192.168.0.202:18005",
    "--rvc-url", "http://192.168.0.202:18006"
  ]
}
```

Tools then appear as `mcp__pharaoh__<tool>`.

**Claude Desktop**: install the bundle described by `servers/mcp/manifest.json`
(it asks for the projects folder and the inference host and fills in the
ports), or add the same `command`/`args` to `claude_desktop_config.json`.

**As a service**: `python servers/mcp/run.py --transport sse --port 18000
--projects-dir ~/pharaoh-projects` — the app's Settings shows its health on
:18000.

Requires Python ≥ 3.10 with `servers/mcp/requirements.txt` (or `uv run
--project servers/mcp …`), and a local `ffmpeg` for composition.

## Resources (read-only)

| URI | Contents |
|---|---|
| `pharaoh://projects` | All projects. |
| `pharaoh://projects/{project_id}` | One project with its cast. |
| `pharaoh://projects/{project_id}/storyboard` | Scenes. |
| `pharaoh://projects/{project_id}/scenes/{scene_slug}/script` | A scene's rows. |
| `pharaoh://projects/{project_id}/scenes/{scene_slug}/assets` | A scene's generated audio. |
| `pharaoh://projects/{project_id}/pipeline` | Per-character voice pipeline status. |

## Tools (49)

| Area | Tools |
|---|---|
| Projects & scripts | `list_projects`, `get_project`, `create_project`, `update_project`, `project_status`, `list_scenes`, `get_scene`, `create_scene`, `update_scene`, `read_script`, `write_script`, `update_script_row`, `spatialize_row`, `list_characters`, `add_character`, `update_character`, `delete_character` |
| Generation | `generate_tts` (row → TTS; resolves the row's palette emotion; Breeze serves the TTS port, so cloned lines go through Breeze), `generate_chatterbox`, `generate_sfx` (server default engine: MOSS where installed), `generate_music` |
| Voices | `list_character_palette`, `generate_palette_take`, `list_palette_takes`, `approve_palette_take`, `corpus_status`, `build_corpus`, `train_rvc_model`, `rvc_convert`, `list_rvc_models` |
| Jobs | `job_status`, `wait_for_job` |
| QA & takes | `list_assets`, `read_asset_meta`, `list_asset_takes`, `qa_approve`, `qa_reject`, `regenerate_asset` |
| Post | `import_audio`, `process_clip`, `normalize_audio`, `resample_audio`, `upscale_audio` |
| Servers | `server_health`, `get_server_config`, `load_model`, `unload_model` |
| Composition | `compose_scene`, `render_final` |

Each tool module has a companion doc in `servers/mcp/` (`tools_project.md`,
`tools_generate.md`, …) with argument details; `run.md` is the module map.

## CLI or MCP?

Use the **CLI** for anything end to end or anything added since October 2026;
use **MCP** where a client only speaks MCP, or for the palette-take tools the
CLI lacks.

| Capability | CLI | MCP |
|---|---|---|
| Projects, scenes, scripts, characters | ✓ | ✓ |
| Fountain write/import, acts | ✓ | — (`write_script` takes rows) |
| Generate a row / whole scene | ✓ (Breeze direction, take check, voice lock, MOSS) | per row; no voice lock |
| Scene layout on the timeline | ✓ `script layout` | — |
| Scene render | ✓ Rust renderer (bed loops, ducking, mono upmix) | `compose_scene`: own Python mixer, without those (Pharaoh-y4bk) |
| m4b export | ✓ | — |
| Dissect: import, name speakers, emotions, palettes, corpora, rebuild | ✓ | — |
| Library | ✓ | — |
| Cast merge / matching / packs | ✓ | — |
| Palette takes: generate / approve | — | ✓ |
| Voice-lock (RVC) train / convert | — (app Model tab) | ✓ only when the RVC server shares this disk (Pharaoh-dvc1) |
| Read-only resources | — | ✓ |
| Remote inference servers | ✓ uploads/downloads | ✓ uploads/downloads (except RVC) |
