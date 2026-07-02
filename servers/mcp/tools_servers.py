"""
MCP tools: inference server model management.

Load/unload models, poll health, and report the configured server URLs.
These are thin proxies over remote._post/_get — the enriched connect/timeout
errors from remote.py surface directly in the tool results. Importing this
module registers the tools against the shared FastMCP instance from
server.py.
"""
import json

from config import PROJECTS_DIR, SERVER_URLS
from remote import _get, _post
from server import mcp


@mcp.tool()
def unload_model(server: str) -> str:
    """
    Unload the currently loaded model from an inference server to free RAM/VRAM.

    IMPORTANT: Call this before loading a different heavy model to avoid OOM.
    The inference servers do NOT share memory — each holds its model independently.
    Typical footprints (RAM, no GPU):
      tts         — ~8–12 GB (voice_design or custom_voice)
      sfx         — ~4–6 GB (AudioLDM)
      music       — ~14–20 GB (ACE-Step 3.5B)
      post        — ~2–4 GB (AudioSR)
      chatterbox  — ~4–6 GB (Chatterbox Turbo 0.5B)

    Recommended workflow for CPU-only sessions:
      1. Build palette: generate_palette_take for each emotion → approve → unload_model("tts")
      2. Generate all dialogue with Chatterbox → unload_model("chatterbox")
      3. Generate all SFX
      4. Generate music → unload_model("music")
      5. Generate post-processing as needed

    server: "tts" | "sfx" | "music" | "post" | "chatterbox"
    """
    if server not in SERVER_URLS:
        return json.dumps({"error": f"unknown server: {server}. Valid: {list(SERVER_URLS.keys())}"})
    try:
        result = _post(server, "/unload", {})
        return json.dumps({"ok": True, "server": server, **result})
    except Exception as e:
        return json.dumps({"ok": False, "server": server, "error": str(e)})


@mcp.tool()
def server_health(server: str = "") -> str:
    """
    Check health of inference servers.
    server: "tts" | "sfx" | "music" | "post" | "chatterbox" | "" (check all)
    Returns model_loaded, model_variant, and vram_mb for each.

    RAM WARNING: On CPU-only systems, loading multiple heavy models simultaneously
    will exhaust RAM. Use unload_model() between generation phases.
    See unload_model() docstring for recommended sequencing.
    """
    targets = [server] if server else list(SERVER_URLS.keys())
    results = {}
    for s in targets:
        if s not in SERVER_URLS:
            results[s] = {"error": f"unknown server: {s}. Valid: {list(SERVER_URLS.keys())}"}
            continue
        try:
            results[s] = _get(s, "/health")
        except Exception as e:
            results[s] = {"status": "unreachable", "error": str(e)}
    return json.dumps(results, indent=2)


@mcp.tool()
def load_model(server: str) -> str:
    """
    Preload an inference model into VRAM on the given server.
    Call this before starting a generation batch to avoid cold-start latency on
    the first job. Complement with unload_model when switching servers.

    server: "tts" | "sfx" | "music" | "chatterbox" | "rvc" | "post"
    """
    try:
        resp = _post(server, "/load", {})
        return json.dumps(resp)
    except Exception as e:
        return json.dumps({"error": f"failed to load model on the {server} server: {e}"})


@mcp.tool()
def get_server_config() -> str:
    """
    Return the currently configured inference server URLs.
    Useful for verifying which endpoints the MCP server is pointed at,
    especially when running remote or split inference.
    """
    return json.dumps({
        "tts": SERVER_URLS["tts"],
        "sfx": SERVER_URLS["sfx"],
        "music": SERVER_URLS["music"],
        "post": SERVER_URLS["post"],
        "chatterbox": SERVER_URLS["chatterbox"],
        "rvc": SERVER_URLS["rvc"],
        "projects_dir": str(PROJECTS_DIR),
    }, indent=2)
