"""
The shared FastMCP instance for the Pharaoh MCP server.

Tool/resource modules import `mcp` from here and register against it with
@mcp.tool() / @mcp.resource(). Lives in its own module so registration never
creates an import cycle with run.py.
"""
from mcp.server.fastmcp import FastMCP

from config import log

mcp = FastMCP("pharaoh")


# ── SSE health endpoint (for Rust server health check) ────────────────────────
# When running in SSE mode, FastMCP exposes the MCP protocol over HTTP.
# We also need a plain /health endpoint so the Rust backend can poll it.
# FastMCP's SSE app is a Starlette app — mount a health route on it.

def _add_health_route(app_instance: FastMCP) -> None:
    """Attach a /health GET route to the underlying Starlette app."""
    try:
        from starlette.routing import Route
        from starlette.responses import JSONResponse

        async def health(request):  # noqa: ANN001
            return JSONResponse({
                "status": "ok",
                "model_loaded": True,
                "model_variant": "pharaoh-mcp",
                "vram_mb": 0,
                "stub": False,
            })

        sse_app = app_instance.get_asgi_app()  # Starlette instance
        sse_app.routes.insert(0, Route("/health", health))
    except Exception as exc:
        log.warning("Could not attach /health route: %s", exc)
