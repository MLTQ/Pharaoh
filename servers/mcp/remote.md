# servers/mcp/remote.py

HTTP glue between the MCP server and the Pharaoh inference servers
(ports 18001–18006 by default; URLs from config.SERVER_URLS).

## Purpose

Owns `_post`/`_get` (with contextual error wrapping), remote-server detection,
the upload/download path-remapping that keeps local paths off remote machines,
the pending-downloads cache, and single-model-mode auto-unloading.

## Contracts

- `_post(server, path, body, upload_fields=())` / `_get(server, path)` —
  raise `RuntimeError` with an actionable message on unknown server key,
  connection refused (points at `./inference/start_servers.sh` and
  `get_server_config()`), timeout, or non-2xx (includes status + body excerpt).
- `_is_remote(server)` — hostname of the configured URL is not loopback.
- Remote mode: `_post` clears `output_path` (server writes to server-output/),
  records job_id → intended local path in `_pending_downloads`, and uploads
  any `upload_fields` file paths via `/upload` first.
- `_resolve_job_output(server, job_id, result)` — on job completion, downloads
  `/files/{job_id}` to the intended local path and rewrites
  `result["output_path"]`; on failure adds `download_error` instead of raising
  (Pharaoh-e6yc).
- `_auto_unload_others(active)` — when single-model mode is on (CLI flag or
  app config), best-effort `/unload` on the other heavy servers
  (tts/music/chatterbox/rvc). Never raises.

## Rationale

Tools stay path-agnostic: they always pass local paths and always receive
local paths back, whether inference runs on this machine or a remote GPU box.
