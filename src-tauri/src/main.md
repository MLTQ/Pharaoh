# main.rs

## Purpose
Binary entrypoint that chooses between GUI and CLI mode. It stays intentionally small so the real behavior lives in `lib.rs`.

## Components

### `main`
- **Does**: Launches the Tauri GUI when invoked with no arguments, otherwise dispatches to the headless CLI and exits non-zero on failure.
- **Interacts with**: `run` and `run_cli` in `lib.rs`.

### `ensure_linux_gui_environment`
- **Does**: Checks Linux GUI launches for a usable X11 or Wayland display before Tauri initializes GTK.
- **Interacts with**: Linux desktop environment variables `DISPLAY` and `WAYLAND_DISPLAY`.
- **Rationale**: Tauri/TAO can abort inside GTK before app code gets a chance to explain that the AppImage was launched outside a graphical session.

### `has_non_empty_env`
- **Does**: Treats an environment variable as available only when it is set and non-empty.
- **Interacts with**: `ensure_linux_gui_environment`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Users | `pharaoh` opens the app by default | Changing default mode |
| Agents/scripts | `pharaoh ...` runs CLI commands without opening a window | Ignoring CLI args |
| Linux AppImage users | No-argument launch fails clearly when no graphical display is available | Removing the preflight |

## Notes
- This split is what makes the existing native binary usable in fully headless automation.
- AppImage CLI mode is still available without a display because the GUI preflight only runs when no command arguments are present.
