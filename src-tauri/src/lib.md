# lib.rs

## Purpose
Library entrypoints for Pharaoh’s native application modes. This file boots the Tauri app for GUI usage and now also exposes the headless CLI runtime bootstrap.

## Components

### `run`
- **Does**: Builds and runs the Tauri application, loading app config and registering commands.
- **Interacts with**: `AppState` in `models.rs`, command modules in `commands/`.

### `run_cli`
- **Does**: Starts a Tokio runtime and executes the headless CLI.
- **Interacts with**: `cli.rs`.
- **Rationale**: Keeps the binary’s GUI and CLI modes sharing the same crate and backend modules.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `main.rs` | `run()` launches GUI when no args are provided | Signature changes |
| `main.rs` | `run_cli(args)` returns printable errors | Return type changes |
| `app_support.rs` | Config boot path is shared and consistent | Diverging startup logic |

## Notes
- GUI startup now reuses the same config-loading helper used by the CLI so path semantics stay aligned.
