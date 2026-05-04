# inference.rs

## Purpose
Tauri inference commands and generation lifecycle handling. This file submits jobs to the Python servers, tracks progress, and finalizes outputs with sidecars plus optional script binding.

## Components

### `check_server_health`, `update_server_config`, `load_model`, `unload_model`
- **Does**: Manage server connectivity and model lifecycle.
- **Interacts with**: `modelStore.ts`, settings UI.

### `submit_tts_*`, `submit_sfx_t2a`, `submit_music_text2music`
- **Does**: Submit generation requests and start background polling.
- **Interacts with**: generation panels in `src/components/`, request models in `models.rs`.

### `poll_until_done`
- **Does**: Polls `/jobs/{id}` until completion, emitting progress/completion/failure events to the frontend.
- **Interacts with**: `jobStore.ts`, `finalize_generation_output`.

### `finalize_generation_output`
- **Does**: Writes sidecars, computes actual duration, and auto-binds outputs into `script.csv` when safe.
- **Interacts with**: `app_support.rs`, `cli.rs`.
- **Rationale**: Centralizes the post-generation behavior so GUI and CLI agree on what “job complete” means.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `jobStore.ts` | `job-complete` includes output path and binding metadata | Event payload changes |
| `cli.rs` | Finalization works without Tauri events | Adding AppHandle-only behavior |
| `AssetBrowser.tsx` | Auto-bound first takes do not require a click before the script sees them | Removing binding behavior |

## Notes
- `bind_generated_asset` only claims a row when that row is still unassigned. Alternate take selection stays explicit.
