"""
Shared pytest setup for the Python side (inference servers + MCP server).

Both trees are flat module collections meant to be run with their own directory
on `sys.path` (`inference/tts_server.py` does `from _common import ...`, and
`servers/mcp/run.py` prepends its own directory before importing siblings), so
the tests put those directories on the path rather than importing by package.
"""
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INFERENCE_DIR = REPO_ROOT / "inference"
MCP_DIR = REPO_ROOT / "servers" / "mcp"

for _p in (INFERENCE_DIR, MCP_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


@pytest.fixture
def projects_dir(tmp_path, monkeypatch):
    """A temporary PROJECTS_DIR with `projectfs` pointed at it."""
    import projectfs

    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(projectfs, "PROJECTS_DIR", root)
    return root
