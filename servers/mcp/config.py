"""
Shared configuration for the Pharaoh MCP server.

Parses CLI args at import time (parse_known_args, so unknown flags are
tolerated) and exposes the resolved globals every other module reads:
PROJECTS_DIR, SERVER_URLS, args, and the shared logger.
"""
import argparse
import json
import logging
import os
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pharaoh-mcp")

# ── CLI args ──────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Pharaoh MCP control-plane server")
parser.add_argument("--projects-dir", default=os.path.expanduser("~/pharaoh-projects"))
parser.add_argument("--tts-url", default="http://127.0.0.1:18001")
parser.add_argument("--sfx-url", default="http://127.0.0.1:18002")
parser.add_argument("--music-url", default="http://127.0.0.1:18003")
parser.add_argument("--post-url", default="http://127.0.0.1:18004")
parser.add_argument("--chatterbox-url", default="http://127.0.0.1:18005")
parser.add_argument("--rvc-url", default="http://127.0.0.1:18006")
parser.add_argument("--transport", default="stdio", choices=["stdio", "sse"])
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=18000)
parser.add_argument("--single-model-mode", action="store_true", default=False,
                    help="Unload other heavy servers before loading a new model (saves VRAM)")
args, _ = parser.parse_known_args()

PROJECTS_DIR = Path(os.path.expandvars(args.projects_dir)).expanduser()
SERVER_URLS = {
    "tts": args.tts_url,
    "sfx": args.sfx_url,
    "music": args.music_url,
    "post": args.post_url,
    "chatterbox": args.chatterbox_url,
    "rvc": args.rvc_url,
}


# ── App config helper ─────────────────────────────────────────────────────────

def _cfg() -> dict:
    """Read the persisted Pharaoh AppConfig from disk. Returns {} if not found."""
    import platform
    system = platform.system()
    if system == "Darwin":
        cfg_path = Path.home() / "Library" / "Application Support" / "ai.aureum.pharaoh" / "config.json"
    elif system == "Windows":
        cfg_path = Path(os.environ.get("APPDATA", Path.home())) / "ai.aureum.pharaoh" / "config.json"
    else:
        cfg_path = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "ai.aureum.pharaoh" / "config.json"
    if not cfg_path.exists():
        return {}
    try:
        return json.loads(cfg_path.read_text())
    except Exception:
        return {}
