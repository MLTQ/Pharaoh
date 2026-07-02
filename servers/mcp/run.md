# servers/mcp/run.py

Thin entry point for the Pharaoh MCP control-plane server (port 18000).

## Purpose

Exposes the Pharaoh pipeline to any MCP-capable client (Claude Desktop, Claude
Code agents, custom tooling) without requiring the Tauri GUI. Claude can read
project state, submit generation jobs, review assets, and trigger composition
entirely through MCP tools and resources.

run.py itself only does four things: put its own directory on sys.path (so it
works when invoked by absolute path from any cwd), import config/server,
import the tool/resource modules (which register themselves on the shared
FastMCP instance as an import side effect), and run the chosen transport.

## Module map

| Module | Doc | Contents |
|--------|-----|----------|
| config.py | config.md | CLI args, PROJECTS_DIR, SERVER_URLS, logger |
| server.py | server.md | the shared FastMCP instance + SSE /health route |
| projectfs.py | projectfs.md | on-disk project state helpers |
| remote.py | remote.md | HTTP glue to the inference servers (18001–18006) |
| resources.py | resources.md | 6 `pharaoh://` read-only resources |
| tools_project.py | tools_project.md | project/scene/character/script CRUD (17 tools) |
| tools_generate.py | tools_generate.md | TTS/Chatterbox/SFX/music generation (4 tools) |
| tools_voice.py | tools_voice.md | palette + RVC voice pipeline (9 tools) |
| tools_jobs.py | tools_jobs.md | job polling (2 tools) |
| tools_qa.py | tools_qa.md | asset QA + take management (6 tools) |
| tools_audio.py | tools_audio.md | ffmpeg post-processing + AudioSR upscale (5 tools) |
| tools_servers.py | tools_servers.md | model load/unload/health/config (4 tools) |
| tools_compose.py | tools_compose.md | scene composition + final render (2 tools) |

49 tools + 6 resources total. Tool names, signatures, and docstrings are a
stable contract — agents and Claude Desktop configs depend on them.

## Transport modes

| Mode  | When to use                                              |
|-------|----------------------------------------------------------|
| stdio | Claude Desktop config, direct agent integration (default)|
| sse   | Spawned as a local service alongside inference servers   |

```
python run.py --projects-dir ~/pharaoh-projects
python run.py --transport sse --port 18000 --projects-dir ~/pharaoh-projects
```

## Design invariants

- **Sidecars are QA truth** — asset state lives in `.meta.json` next to each
  WAV; project/storyboard/script state lives in the project directory.
- **Proxies generation to inference servers** — does not load models itself.
  Generation requests are forwarded to ports 18001–18006 via httpx, with
  automatic upload/download path remapping when a server is remote.
- **Composition is pure Python + ffmpeg** — `compose_scene` / `render_final`
  build ffmpeg filter graphs directly; only a local `ffmpeg` binary is needed.
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
