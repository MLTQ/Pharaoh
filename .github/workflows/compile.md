# compile.yml

## Purpose
Builds Pharaoh on macOS and Linux, uploads CI artifacts, and publishes GitHub releases. Master branch builds update the rolling nightly release, while `v*` tags and tagged manual dispatches produce stable releases.

## Components

### `tauri` job
- **Does**: Installs platform dependencies, installs and verifies the stable Rust toolchain, builds the frontend, checks the Rust backend, compiles the Tauri app, and packages release artifacts.
- **Interacts with**: `rustup`, `npm run build`, `cargo check`, `npm run tauri build`, and `actions/upload-artifact`.
- **Rationale**: The workflow installs Rust explicitly so macOS and Linux both resolve `cargo` through the verified rustup toolchain path.

### `Smoke-test Linux AppImage CLI`
- **Does**: Executes the built AppImage with `setup hardware` before publishing it.
- **Interacts with**: The AppImage artifact and Pharaoh's headless CLI entrypoint.
- **Rationale**: Verifies that the Linux artifact can start in CLI mode without requiring GTK window initialization.

### `release` job
- **Does**: Downloads build artifacts, resolves stable versus nightly release metadata, moves the rolling nightly tag when needed, and publishes binaries plus checksums.
- **Interacts with**: `softprops/action-gh-release`, Git tags, and artifacts from the `tauri` job.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Users | Linux releases include an executable AppImage and checksum | Removing AppImage packaging |
| Users | macOS releases include a tarball with the compiled binary and checksum | Removing macOS packaging |
| Maintainers | `master` publishes a rolling prerelease named `nightly` | Changing release metadata rules |
| Maintainers | `v*` tags publish stable releases marked latest | Changing tag handling |

## Notes
- The Linux smoke test uses `APPIMAGE_EXTRACT_AND_RUN=1` so CI can execute the AppImage even when FUSE mounting is unavailable.
