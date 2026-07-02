"""
MCP tools: generation job polling.

job_status is a single poll; wait_for_job blocks until the job resolves.
Both route through remote._get and resolve pending remote downloads so
output_path always points at a local file once a job completes. Importing
this module registers the tools against the shared FastMCP instance from
server.py.
"""
import json
import time

from config import SERVER_URLS
from remote import _get, _resolve_job_output
from server import mcp


@mcp.tool()
def job_status(server: str, job_id: str) -> str:
    """
    Poll a generation job for status and progress.
    server: "tts" | "sfx" | "music" | "post" | "chatterbox"
    Returns: {status: "pending|running|complete|failed", progress: 0.0-1.0, output_path, error}
    """
    if server not in SERVER_URLS:
        return json.dumps({"error": f"unknown server: {server}. Use: {list(SERVER_URLS)}"})
    result = _get(server, f"/jobs/{job_id}")
    result = _resolve_job_output(server, job_id, result)
    return json.dumps(result)


@mcp.tool()
def wait_for_job(server: str, job_id: str, timeout_seconds: int = 300) -> str:
    """
    Block until a generation job completes or fails (polls every 2 seconds).
    Returns the final job record with output_path on success.
    Use this instead of manually polling job_status in a loop.
    server: "tts" | "sfx" | "music" | "post" | "chatterbox"
    """
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        result = _get(server, f"/jobs/{job_id}")
        status = result.get("status", "")
        if status == "complete":
            result = _resolve_job_output(server, job_id, result)
            return json.dumps({"ok": True, **result})
        if status == "failed":
            return json.dumps({"ok": False, **result})
        time.sleep(2)
    return json.dumps({"ok": False, "error": (
        f"job {job_id} on the {server} server did not finish within {timeout_seconds}s — "
        f"it may still be running; poll job_status(\"{server}\", \"{job_id}\") "
        f"or call wait_for_job again with a longer timeout"
    ), "last": result})
