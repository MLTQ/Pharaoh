# servers/mcp/run.py

MCP control-plane server for the Pharaoh audio drama pipeline.

## Purpose

Exposes the Pharaoh pipeline to any MCP-capable client (Claude Desktop, Claude
Code agents, custom tooling) without requiring the Tauri GUI. Claude can read
project state, submit generation jobs, review assets, and trigger composition
entirely through MCP tools and resources.

## Transport modes

| Mode  | When to use                                              |
|-------|----------------------------------------------------------|
| stdio | Claude Desktop config, direct agent integration (default)|
| sse   | Spawned as a local service alongside inference servers   |

## Tools

| Tool               | Description                                              |
|--------------------|----------------------------------------------------------|
| `project_status`   | Per-scene per-stage completion matrix                    |
| `read_script`      | Script rows as structured JSON                           |
| `update_script_row`| Patch a single row in script.csv                         |
| `generate_tts`     | Submit TTS job → job_id                                  |
| `generate_sfx`     | Submit SFX job → job_id                                  |
| `generate_music`   | Submit music job, supports batch_size for gacha workflow  |
| `job_status`       | Poll a job for status/progress                           |
| `wait_for_job`     | Block until job completes (2s poll, configurable timeout) |
| `list_assets`      | Assets for a scene, filterable by QA status              |
| `qa_approve`       | Write qa_status=approved to .meta.json sidecar           |
| `qa_reject`        | Write qa_status=rejected with notes                      |
| `regenerate_asset` | Re-submit using original sidecar params, new take index  |
| `server_health`    | Check inference server status and VRAM                   |
| `compose_scene`    | Render a scene via the pharaoh CLI                       |
| `render_final`     | Assemble all scenes into final.wav                       |

## Resources

| URI                                                    | Contents                         |
|--------------------------------------------------------|----------------------------------|
| `pharaoh://projects`                                   | List of all projects             |
| `pharaoh://projects/{id}`                              | project.json                     |
| `pharaoh://projects/{id}/storyboard`                   | storyboard.json                  |
| `pharaoh://projects/{id}/scenes/{slug}/script`         | script.csv as JSON array         |
| `pharaoh://projects/{id}/scenes/{slug}/assets`         | assets with QA status + metadata |
| `pharaoh://projects/{id}/pipeline`                     | Per-scene stage completion matrix|

## Design invariants

- **Read-only filesystem access for project state** — reads project.json,
  storyboard.json, script.csv, and .meta.json sidecars directly. Writes only
  to script.csv (via `update_script_row`) and .meta.json (via qa_approve/reject).
- **Proxies generation to inference servers** — does not load models itself.
  Generation requests are forwarded to ports 18001–18004 via httpx.
- **Composition delegates to pharaoh CLI** — `compose_scene` and `render_final`
  invoke the compiled `pharaoh` Rust binary. The binary must be built first.
- **No Tauri dependency** — runs standalone; can be used without the GUI.

## Claude Desktop configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pharaoh": {
      "command": "python",
      "args": [
        "/path/to/Pharaoh/servers/mcp/run.py",
        "--projects-dir", "/path/to/pharaoh-projects"
      ]
    }
  }
}
```
