"""
Pharaoh MCP Server — port 18000
AI agent control plane for the Pharaoh audio drama production pipeline.

Exposes MCP tools and resources so Claude (or any MCP client) can drive the
full Pharaoh pipeline without the GUI: read project state, submit generation
jobs, review assets, and trigger composition.

This file is a thin entry point — the implementation lives in the sibling
modules, each of which registers its tools/resources on import:

  config.py          CLI args + shared globals (PROJECTS_DIR, SERVER_URLS)
  server.py          the shared FastMCP instance + SSE /health route
  projectfs.py       on-disk project state helpers (no MCP surface)
  remote.py          HTTP glue to the inference servers (no MCP surface)
  resources.py       pharaoh:// MCP resources
  tools_project.py   project / scene / character / script CRUD
  tools_generate.py  TTS / Chatterbox / SFX / music generation
  tools_voice.py     emotional palette + RVC voice pipeline
  tools_jobs.py      generation job polling
  tools_qa.py        asset QA + take management
  tools_audio.py     ffmpeg post-processing + AudioSR upscale
  tools_servers.py   inference-server model management
  tools_compose.py   scene composition + final render

Transport modes:
  stdio  — for Claude Desktop / direct agent integration (default)
  sse    — for network clients; listens on --host/--port

Usage:
  python run.py --projects-dir ~/pharaoh-projects
  python run.py --transport sse --port 18000 --projects-dir ~/pharaoh-projects
"""
import sys
from pathlib import Path

# Make the sibling modules importable no matter where run.py is invoked from
# (Claude Desktop configs call it by absolute path with an arbitrary cwd).
_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from config import PROJECTS_DIR, args, log  # noqa: E402
from server import _add_health_route, mcp  # noqa: E402

# Importing these modules registers every tool/resource on the shared `mcp`
# instance. Order is unimportant; keep the list in sync with the docstring.
import resources       # noqa: E402,F401
import tools_project   # noqa: E402,F401
import tools_generate  # noqa: E402,F401
import tools_voice     # noqa: E402,F401
import tools_jobs      # noqa: E402,F401
import tools_qa        # noqa: E402,F401
import tools_audio     # noqa: E402,F401
import tools_servers   # noqa: E402,F401
import tools_compose   # noqa: E402,F401


def main() -> None:
    log.info("Pharaoh MCP server starting (transport=%s, projects=%s)", args.transport, PROJECTS_DIR)
    if args.transport == "sse":
        _add_health_route(mcp)
        # FastMCP.run() takes only (transport, mount_path) — passing host/port
        # raised TypeError and the SSE mode never started. Host and port live
        # on the instance settings, which the transport reads when it builds
        # its uvicorn config.
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run(transport="sse")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
