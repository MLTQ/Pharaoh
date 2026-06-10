"""
HTTP glue between the MCP server and the Pharaoh inference servers.

Owns _post/_get (with contextual error wrapping), remote-server detection,
the upload/download path-remapping logic that keeps local paths off remote
machines, the pending-downloads cache, and single-model-mode auto-unloading.
"""
from pathlib import Path

import httpx

from config import SERVER_URLS, args, log, _cfg

START_HINT = "Start the inference servers first (./inference/start_servers.sh) or check the configured URL with get_server_config()."


# ── Single model mode ─────────────────────────────────────────────────────────

_HEAVY_SERVERS = {"tts", "music", "chatterbox", "rvc"}


def _auto_unload_others(active: str) -> None:
    """If single_model_mode is enabled, unload all heavy servers except `active`.

    Enabled by either the --single-model-mode CLI flag or the Tauri app's
    persisted single_model_mode setting (read from config.json if present).
    """
    enabled = args.single_model_mode or _cfg().get("single_model_mode", False)
    if not enabled:
        return
    for server in _HEAVY_SERVERS:
        if server == active:
            continue
        try:
            _post(server, "/unload", {})
        except Exception:
            pass  # server may not be running


# ── Inference proxy helpers ───────────────────────────────────────────────────

def _is_remote(server: str) -> bool:
    """True when the inference server is NOT running on this machine.

    We detect this by checking the configured URL's hostname.  If it's
    anything other than 127.0.0.1 / localhost / ::1 we treat it as remote
    and apply the upload/download path-remapping logic so Mac paths never
    reach a Linux server.
    """
    url = SERVER_URLS.get(server, "")
    host = url.split("://")[-1].split(":")[0].split("/")[0]
    return host not in ("127.0.0.1", "localhost", "::1", "")


def _check_server_name(server: str) -> None:
    """Raise a clear error for an unknown server key (instead of a bare KeyError)."""
    if server not in SERVER_URLS:
        raise RuntimeError(
            f"unknown server '{server}'. Valid servers: {sorted(SERVER_URLS)}"
        )


# job_id → (server, intended_local_output_path)
# Populated by _post when the server is remote and the body contains output_path.
# Consumed (and removed) by _resolve_job_output once the job completes.
_pending_downloads: dict[str, tuple[str, str]] = {}


def _download_job_output(server: str, job_id: str, local_path: str) -> str:
    """Download a completed remote job's output file to *local_path*.

    Calls GET /files/{job_id} which streams the file and then deletes it from
    the server, keeping server-output/ clean automatically.
    """
    url = SERVER_URLS[server] + f"/files/{job_id}"
    dest = Path(local_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    resp = httpx.get(url, timeout=120.0)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    log.info("Downloaded job %s → %s", job_id, local_path)
    return local_path


def _resolve_job_output(server: str, job_id: str, result: dict) -> dict:
    """If *job_id* has a pending remote download and the job is complete,
    download the file to the originally-intended local path and update
    result['output_path'] to that local path."""
    if result.get("status") != "complete":
        return result
    if job_id not in _pending_downloads:
        return result
    dl_server, local_path = _pending_downloads.pop(job_id)
    try:
        _download_job_output(dl_server, job_id, local_path)
        return {**result, "output_path": local_path}
    except Exception as exc:
        log.error("Download failed for job %s: %s", job_id, exc)
        return {**result, "download_error": (
            f"job {job_id} completed on the {dl_server} server but downloading its "
            f"output to {local_path} failed: {exc}"
        )}


def _upload_input_file(server: str, local_path: str) -> str:
    """Upload a local file to the inference server's /upload endpoint.

    Used when input files (ref_audio, source_audio, etc.) are on the local
    machine but the server is remote.  Returns the server-side path.
    """
    if not local_path:
        return local_path
    p = Path(local_path)
    if not p.is_file():
        raise FileNotFoundError(
            f"Input file not found: {local_path} "
            f"(needed to upload to the remote {server} server at {SERVER_URLS[server]})"
        )
    url = SERVER_URLS[server] + "/upload"
    resp = httpx.post(
        url,
        content=p.read_bytes(),
        params={"filename": p.name},
        headers={"content-type": "application/octet-stream"},
        timeout=120.0,
    )
    resp.raise_for_status()
    server_path = resp.json()["server_path"]
    log.info("Uploaded %s → %s:%s", local_path, server, server_path)
    return server_path


def _post(server: str, path: str, body: dict,
          upload_fields: tuple[str, ...] = ()) -> dict:
    """POST to an inference server.

    Remote-mode path handling (applied automatically when _is_remote(server)):
    - output_path is cleared so the server generates a path in server-output/;
      the intended local path is registered in _pending_downloads so
      _resolve_job_output can download the file once the job completes.
    - Any fields named in *upload_fields* that contain local file paths are
      uploaded to /upload first and replaced with the returned server path.
    """
    _check_server_name(server)
    url = SERVER_URLS[server] + path
    intended_output = body.get("output_path", "")

    if _is_remote(server):
        body = dict(body)  # don't mutate caller's dict
        if intended_output:
            body["output_path"] = ""
        for field in upload_fields:
            if body.get(field):
                body[field] = _upload_input_file(server, body[field])

    try:
        resp = httpx.post(url, json=body, timeout=10.0)
        resp.raise_for_status()
        result = resp.json()
    except httpx.ConnectError:
        raise RuntimeError(
            f"{server} server not reachable at {SERVER_URLS[server]} (POST {path}). {START_HINT}"
        )
    except httpx.TimeoutException:
        raise RuntimeError(
            f"{server} server at {SERVER_URLS[server]} timed out on POST {path} — "
            f"it may still be loading a model; check server_health(\"{server}\") and retry."
        )
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"{server} server at {SERVER_URLS[server]} rejected POST {path} "
            f"with HTTP {exc.response.status_code}: {exc.response.text[:500]}"
        )

    if _is_remote(server) and intended_output and "job_id" in result:
        _pending_downloads[result["job_id"]] = (server, intended_output)

    return result


def _get(server: str, path: str) -> dict:
    _check_server_name(server)
    url = SERVER_URLS[server] + path
    try:
        resp = httpx.get(url, timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        raise RuntimeError(
            f"{server} server not reachable at {SERVER_URLS[server]} (GET {path}). {START_HINT}"
        )
    except httpx.TimeoutException:
        raise RuntimeError(
            f"{server} server at {SERVER_URLS[server]} timed out on GET {path} — "
            f"it may be busy loading a model; retry shortly."
        )
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"{server} server at {SERVER_URLS[server]} returned HTTP "
            f"{exc.response.status_code} for GET {path}: {exc.response.text[:500]}"
        )
