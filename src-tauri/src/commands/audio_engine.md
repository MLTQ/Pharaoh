# audio_engine.rs

## Purpose
Rust-side ffmpeg rendering utilities for scene composition. This file mixes placed `script.csv` rows into a scene render and now exposes a shared render helper for both GUI and CLI entrypoints.

## Components

### `normalize_clip`, `resample_to_48k`, `import_audio_asset`, `process_clip_asset`
- **Does**: Run ffmpeg transforms on individual clips. `import_audio_asset` converts arbitrary source audio into project-local 48 kHz WAV references; `process_clip_asset` trims, filters, applies curved fades, normalizes, writes 48 kHz stereo output, and creates a child sidecar.
- **Interacts with**: Frontend utility wrappers in `tauriCommands.ts`, `ClipStudioView.tsx`, CLI post commands, sidecar commands.

### `render_scene` / `render_scene_with_projects_dir`
- **Does**: Builds a three-stage ffmpeg `filter_complex`:
  1. **Per-clip**: fade in/out → `adelay` → `volume` → stereoize → equal-power `pan`.
  2. **Bus structure**: dialogue (HPF at 80 Hz, no trim, doubles as ducking
     sidechain) / music+bed (-3 dB, optionally sidechain-compressed against
     dialogue) / sfx (-1 dB).
  3. **Master**: `loudnorm=I=<target>:TP=-1.0:LRA=11` then `alimiter=limit=0.891`
     (-1 dBTP brick wall).
  Default `target_lufs` is -16 (podcast/streaming). Caller can pass -14, -18,
  -23, etc. After mux, runs `ebur128` over the result and writes
  `render.wav.meta.json` next to it.
- **Interacts with**: `app_support.rs`, `CompositionView.tsx`, `cli.rs`,
  `renderMetaStore.ts`.
- **Rationale**: Without bus structure + loudnorm + limiter, every render landed
  at a different absolute level and competed for headroom in unprincipled ways.
  Now scene-to-scene loudness is consistent and the result is shippable as-is.

### `read_render_meta`
- **Does**: Reads the `render.wav.meta.json` written by `render_scene` and returns
  the JSON value (or null if no meta). Used by the transport bar to display
  measured LUFS / true peak with spec-compliance color bands.

### `measure_render_loudness` / `parse_ebur128_summary` (private)
- **Does**: Runs `ffmpeg -af ebur128=peak=true` over the rendered file and parses
  the "Summary:" block from stderr. Robust to small ffmpeg version differences
  in label formatting — reads `I:`, `LRA:`/`Range:`, `True peak:`/`Peak:`,
  `Threshold:`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `CompositionView.tsx` | Successful render returns output path as a string | Return type changes |
| `ClipStudioView.tsx` | Import and clip processing return new WAV paths and write metadata next to them | Returning the parent path or skipping sidecar writes |
| `cli.rs` | Rendering works without a Tauri window | Adding AppHandle-only dependencies |
| Users/agents | Only placed rows with `file` and `start_ms` render | Changing row inclusion rules |

## Notes
- `pan` is applied with equal-power gain (cos/sin pan law). For mono-upmixed
  inputs this is exact; for true-stereo sources it slightly downmixes when
  panned hard. Acceptable since music is normally panned 0.
- `reverb_send` is in the data model but **not yet wired** in the master chain;
  it'll need a chosen reverb implementation (likely shipping a small/medium IR
  for `afir`).
