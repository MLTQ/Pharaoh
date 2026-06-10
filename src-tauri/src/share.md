# share.rs

## Purpose
Gruve mesh integration: serves the built frontend + an HTTP mirror of the Tauri
command surface on one localhost port, and announces Pharaoh to the local Gruve
agent so friends can open it from their lobby. Exists because remote viewers
get the frontend over HTTP but have no Tauri IPC (`invoke()` stays home).

## Components

### `spawn`
- **Does**: Reads `share_enabled`/`share_port` from AppConfig; starts the axum
  server (bound 127.0.0.1 only) and the announce heartbeat.
- **Interacts with**: called once from `lib.rs` setup, after `AppState` is managed.

### `announce_loop`
- **Does**: POSTs `/gruve/announce` to the agent at 127.0.0.1:8088 every 20s
  (ttl 60), declaring `upstreams: { api: share_port }`. Silent on failure —
  no agent running is the normal standalone case.
- **Rationale**: contract §2 — the long-lived backend owns the announce, never
  a browser tab. Started only after the listener is bound (agent refuses
  announces for dead ports).

### `static_assets`
- **Does**: Serves the built UI: Tauri embedded assets first (packaged builds),
  then `dist/` on disk (dev), with SPA fallback to index.html.
- **Rationale**: dev webview uses the vite dev server which can't live under a
  sub-path; sharing in dev requires a `npm run build` first.

### `file_stream`
- **Does**: `GET /file?path=…` — streams audio with Range support (WebKit
  refuses to seek non-ranged media). Canonicalizes and refuses any path
  outside `projects_dir`.
- **Interacts with**: `fileSrc()` in `src/lib/transport.ts` builds these URLs.

### `dispatch` / `invoke_http`
- **Does**: `POST /invoke/{cmd}` with the same camelCase JSON args the frontend
  passes `invoke()`. Read commands always allowed; mutations gated on the
  `share_collab` config flag via `COLLAB_CMDS`. Unlisted commands → 403.
- **Interacts with**: calls straight into `commands::*` functions with a real
  `AppHandle`; `src/lib/transport.ts` is the client.
- **Rationale**: explicit allowlist (not a blanket bridge) — settings writes,
  host-fs imports/exports, recording, and library deletion stay host-only.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `lib.rs` | `share::spawn(app_handle)` after `app.manage(AppState…)` | signature |
| `src/lib/transport.ts` | `/invoke/{cmd}` mirrors invoke() args/results; `/file?path=` streams | route shapes, arg casing |
| Gruve agent | port announced is actually listening; UI served at `/` | moving UI off share_port |
| `models.rs` | `AppConfig.share_enabled/share_port/share_collab` exist | renames |

## Notes
- Mesh viewers never see job-progress Tauri events; generation they trigger
  completes server-side but progress UI is host-only for now.
- `get_app_config` is readable by viewers (friends-trust): contains host paths
  and server URLs, no secrets (API keys live in env vars).
