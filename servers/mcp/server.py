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
    """
    Register a plain GET /health route on the FastMCP app.

    This used to call `app_instance.get_asgi_app()`, which does not exist on the
    SDK (`sse_app()` is the accessor), and mutate the returned app's route list.
    Both halves were wrong: the AttributeError was swallowed by the except
    below, so /health was never mounted, and `sse_app()` builds a fresh
    Starlette instance per call anyway, so the mutation would have been
    discarded even if the name had been right. `custom_route` registers on the
    FastMCP instance itself, which every transport builds its app from.
    """
    try:
        from starlette.responses import JSONResponse

        @app_instance.custom_route("/health", methods=["GET"])
        async def health(request):  # noqa: ANN001, ARG001
            return JSONResponse({
                "status": "ok",
                "model_loaded": True,
                "model_variant": "pharaoh-mcp",
                "vram_mb": 0,
                "stub": False,
            })
    except Exception as exc:
        log.warning("Could not attach /health route: %s", exc)
