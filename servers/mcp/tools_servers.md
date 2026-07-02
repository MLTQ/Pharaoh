# servers/mcp/tools_servers.py

MCP tools: inference server model management.

## Purpose

VRAM/RAM housekeeping and endpoint introspection. Thin proxies over
`remote._post`/`_get` — the enriched connect/timeout errors from remote.py
(start_servers.sh hint, configured URL) surface directly in results.

## Tools

| Tool | Notes |
|------|-------|
| `load_model` | POST /load — preload to avoid cold-start latency |
| `unload_model` | POST /unload — free memory; docstring carries the per-server RAM footprints and the recommended CPU-only sequencing |
| `server_health` | GET /health on one or all servers; unreachable servers reported per-key, never raised |
| `get_server_config` | the resolved SERVER_URLS + projects_dir — use to debug remote/split setups |

## Invariants

- These tools never raise: failures come back as `{"ok": false, ...}` or
  per-server error entries so agents can keep orchestrating.
