# servers/mcp/server.py

The shared FastMCP instance (`mcp = FastMCP("pharaoh")`).

## Purpose

Tool/resource modules do `from server import mcp` and decorate their functions
with `@mcp.tool()` / `@mcp.resource(...)`. Keeping the instance in its own
module (instead of run.py) means registration can never create an import cycle
with the entry point.

## Contracts

- `mcp` — the one and only FastMCP instance; importing a tools module
  registers its tools as a side effect.
- `_add_health_route(mcp)` — attaches a plain GET `/health` route to the SSE
  Starlette app so the Rust backend can poll liveness. Response shape matches
  the inference servers: `{status, model_loaded, model_variant, vram_mb, stub}`.
  Failure to attach is a warning, never fatal.

## Known issue

`get_asgi_app()` was removed in newer mcp SDK versions; on those the /health
route silently degrades to a warning (see the pinned `mcp>=1.0` in
requirements.txt — SSE mode itself also has version drift, tracked separately).
