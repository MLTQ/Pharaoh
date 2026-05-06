# audio.rs

## Purpose
Rust audio-analysis utilities used by the frontend for waveform display, duration lookup, and edit assistance. These commands are intentionally local and lightweight.

## Components

### `get_waveform_peaks`
- **Does**: Streams a WAV file into a fixed-size peak array for waveform rendering.
- **Interacts with**: `ClipStudioView.tsx`, generator take lists, asset preview UI.
- **Rationale**: Long recordings can be tens of minutes, so this must not allocate one full sample vector.

### `get_duration_ms`
- **Does**: Reads WAV metadata and returns duration in milliseconds.
- **Interacts with**: UI preview and processing controls.

### `find_zero_crossings`
- **Does**: Finds nearby zero crossings around a requested timestamp.
- **Interacts with**: Future clip-editing refinements.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Waveform UI | `get_waveform_peaks(path, n)` returns exactly `n` values | Returning variable-length arrays |
| Clip Studio | Peak extraction stays usable for long imported WAVs | Loading entire recordings into memory |

## Notes
- These helpers currently expect WAV input. Clip Studio imports external audio through ffmpeg into project-local WAV assets before waveform analysis.
