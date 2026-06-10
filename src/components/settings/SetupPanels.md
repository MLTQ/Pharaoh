# SetupPanels.tsx

## Purpose
One-click automated setup runners: the Woosh clone+checkpoint downloader and the generic `inference/setup.sh` profile runner with live progress. Extracted from `SettingsView.tsx`.

## Components

### `WooshSetupPanel`
- **Does**: Invokes `setup_woosh` (typed `invoke<void>`) and renders a 7-step progress checklist driven by `woosh_setup` Tauri events; on completion shows the hardware-appropriate `uv sync` command.
- **Interacts with**: `setup.rs` (`setup_woosh` command + `woosh_setup` events), `SetupProgress`/`formatBytes`/`CopyableCommand` from `settingsShared.tsx`.
- **Rationale**: Invoke rejections are rendered inline in the step list (not toasted) so the failure appears in the same progress UI the user is watching.

### `ServerSetupPanel`
- **Does**: Runs a `setup.sh` profile (`core` | `audioldm` | `audiosr` | `all`) via `setup_inference_servers` and tails the last 8 `inference_setup` events as a compact live log.
- **Interacts with**: `inference_setup` Tauri events emitted by `setup.rs`; rendered by `ModelServerCards.tsx` for every model kind.
- **Rationale**: Keeps model-server dependency installs operable from Settings while retaining copyable commands for remote hosts.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `ModelServerCards.tsx` | `WooshSetupPanel({ wooshDir, hw })`, `ServerSetupPanel({ profile, wooshDir, buttonLabel, detail, accent })` | Prop changes |
| `setup.rs` | Tauri camelCase args (`destDir`, `wooshDir`) and `SetupProgress`-shaped events | Arg/event shape changes |

## Notes
- Event listeners self-unlisten on done/error and are also cleaned up on unmount via `unlistenRef`.
