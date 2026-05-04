# main.rs

## Purpose
Binary entrypoint that chooses between GUI and CLI mode. It stays intentionally small so the real behavior lives in `lib.rs`.

## Components

### `main`
- **Does**: Launches the Tauri GUI when invoked with no arguments, otherwise dispatches to the headless CLI and exits non-zero on failure.
- **Interacts with**: `run` and `run_cli` in `lib.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Users | `pharaoh` opens the app by default | Changing default mode |
| Agents/scripts | `pharaoh ...` runs CLI commands without opening a window | Ignoring CLI args |

## Notes
- This split is what makes the existing native binary usable in fully headless automation.
