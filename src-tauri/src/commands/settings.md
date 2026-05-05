# settings.rs

## Purpose
Tauri settings commands for reading/writing persistent app config and checking all configured inference server health endpoints.

## Components

### `get_app_config`, `save_app_config`
- **Does**: Return and persist `AppConfig`, synchronizing runtime server URLs into `AppState`.
- **Interacts with**: `SettingsView.tsx`, `models.rs`.

### `get_server_health_all`
- **Does**: Polls TTS, SFX, music, and Post server `/health` endpoints and returns nullable health objects.
- **Interacts with**: `modelStore.ts`, `SettingsView.tsx`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `SettingsView.tsx` | `AppConfig` includes all editable server URLs | Removing URL fields |
| `modelStore.ts` | Health map includes `tts`, `sfx`, `music`, and `post` | Omitting a configured server |
| `app_support.rs` | Config directories exist after save | Skipping directory creation |

## Notes
- `update_server_config` in `inference.rs` updates live URLs; `save_app_config` is the persistent path.
