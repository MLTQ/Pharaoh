# audio_engine.rs

## Purpose
Rust-side ffmpeg rendering utilities for scene composition. This file mixes placed `script.csv` rows into a scene render and now exposes a shared render helper for both GUI and CLI entrypoints.

## Components

### `normalize_clip`, `resample_to_48k`, `import_audio_asset`, `process_clip_asset`
- **Does**: Run ffmpeg transforms on individual clips. `import_audio_asset` converts arbitrary source audio into project-local 48 kHz WAV references; `process_clip_asset` trims, filters, fades, normalizes, writes 48 kHz stereo output, and creates a child sidecar.
- **Interacts with**: Frontend utility wrappers in `tauriCommands.ts`, `ClipStudioView.tsx`, CLI post commands, sidecar commands.

### `render_scene`
- **Does**: Tauri command wrapper that resolves the configured projects root and delegates to the shared renderer.
- **Interacts with**: `app_support.rs`, `CompositionView.tsx`.

### `render_scene_with_projects_dir`
- **Does**: Shared render implementation used by both Tauri and CLI modes.
- **Interacts with**: `cli.rs`, `read_script_rows` in `app_support.rs`.
- **Rationale**: Prevents the headless path from reimplementing scene rendering.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `CompositionView.tsx` | Successful render returns output path as a string | Return type changes |
| `ClipStudioView.tsx` | Import and clip processing return new WAV paths and write metadata next to them | Returning the parent path or skipping sidecar writes |
| `cli.rs` | Rendering works without a Tauri window | Adding AppHandle-only dependencies |
| Users/agents | Only placed rows with `file` and `start_ms` render | Changing row inclusion rules |

## Notes
- The mixer is still intentionally simple; ducking and richer track processing remain separate follow-up work.
