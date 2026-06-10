# SettingsView.tsx

## Purpose
Entry point for the Settings tab. Owns all settings state (server URLs, unified inference host, split-server mode, Woosh directory, single-model mode, Chatterbox health) and all config persistence, then composes the panel components in this directory. Export signature (`SettingsView: React.FC`) and import path are unchanged from before the split.

## Composition

| Section | Rendered by |
|---------|-------------|
| Header, Memory (single-model mode), servers header + split toggle, unified host field | inline in this file |
| Per-model server cards (tts/sfx/music/post) | `ModelServerCards.tsx` |
| Chatterbox Turbo + RVC cards | `ChatterboxRvcCards.tsx` |
| Shared types/constants/helpers | `settingsShared.tsx` |
| One-click setup runners | `SetupPanels.tsx` (via `ModelServerCards`) |
| SFX downloads/install guidance | `SfxPanels.tsx` (via `ModelServerCards`) |

## Components

### `SettingsView`
- **Does**: Loads `AppConfig` on mount, derives effective URLs (`effectiveUrl`) from unified host + `SERVER_PORTS` or per-server URLs, and persists every change on blur/toggle via `get_app_config`/`save_app_config`; live server config also flows to `modelStore.updateServerConfig`.
- **Interacts with**: `modelStore.ts`, Tauri `get_app_config`/`save_app_config`, `openDialog` (Woosh directory browse), `reportError` from `lib/errors.ts`.

### Error surfacing
- **Does**: Every user-initiated config save (host, per-server URLs, Chatterbox/RVC URLs, split toggle, single-model mode, Woosh directory set/save) and the mount-time config load report failures via `reportError(title, e)`, which logs and raises an error toast.
- **Rationale**: These were previously unhandled/silently-swallowed promise rejections; failures left the UI claiming a save succeeded.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| App routing | `SettingsView` named export, no props | Renaming/defaulting the export |
| `setup.rs` | Settings passes Tauri camelCase args (`wooshDir`) and listens for `SetupProgress`-shaped events (see `SetupPanels.md`) | Changing command arg names or event payload shape |
| `sfx_server.py` | Download/setup guidance per `SfxPanels.md` | Changing guidance without updating server resolution |
| `UpscaleView.tsx` | AudioSR installs via the Post-server setup profile and `post_url` points at the Post server | Showing a local-only CLI workflow |

## Notes
- Split from a 1335-line monolith (Pharaoh-us6m) into `settingsShared.tsx`, `SfxPanels.tsx`, `SetupPanels.tsx`, `ModelServerCards.tsx`, `ChatterboxRvcCards.tsx`.
- `checkChatterboxHealth` intentionally keeps its swallow-to-offline catch: an unreachable server *is* the "offline" result, not an error to toast.
