# setup.rs

## Purpose
Setup helpers for dependency installation flows launched from the Settings page. This file keeps long-running setup work in Rust so the GUI can show progress instead of only copyable shell commands.

## Components

### `SetupProgress`
- **Does**: Shared event payload for setup progress, byte progress, completion, and errors.
- **Interacts with**: `SettingsView.tsx` event listeners for `woosh_setup` and `inference_setup`.

### `setup_woosh`
- **Does**: Clones the Woosh repository and downloads/extracts the required AE, TextConditionerA, and DFlow checkpoints.
- **Interacts with**: SonyResearch/Woosh GitHub releases, `SettingsView.tsx`.
- **Rationale**: Woosh has large checkpoint zips that benefit from explicit GUI progress.

### `setup_inference_servers`
- **Does**: Runs `inference/setup.sh` for core TTS/Music dependencies and optional AudioLDM/AudioSR profiles.
- **Interacts with**: `inference/setup.sh`, `SettingsView.tsx`, user-selected Woosh directory through `PHARAOH_WOOSH_DIR`.
- **Rationale**: TTS, Music, AudioLDM, and AudioSR setup already lives in the shell script; the GUI command wraps that script rather than duplicating package-install logic in Rust.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `lib.rs` | Commands are Tauri-invokable and return `Result<()>` | Renaming commands or payload fields |
| `SettingsView.tsx` | `woosh_setup` and `inference_setup` emit `SetupProgress`-shaped events | Changing event names or payload shape |
| `inference/setup.sh` | Optional profiles are controlled by `PHARAOH_INSTALL_AUDIOLDM` and `PHARAOH_INSTALL_AUDIOSR` | Changing env flag names |

## Notes
- `setup_inference_servers` compiles support for dev/repo installs by locating `../inference/setup.sh` from `CARGO_MANIFEST_DIR`.
