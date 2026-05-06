# audioStore.ts

## Purpose
Lightweight Web Audio preview store for generated WAV files. It centralizes clip playback so page components and shared preview buttons do not each create their own audio pipeline.

## Components

### `useAudioStore`
- **Does**: Tracks the active path, duration, and playback position; exposes `play`, `stop`, and `toggle`.
- **Interacts with**: `PlayButton.tsx`, `ClipStudioView.tsx`.

### `play`
- **Does**: Loads a local audio file, decodes it with Web Audio, and starts playback from an optional offset until an optional stop point.
- **Rationale**: Clip Studio needs deterministic region preview from crop handles while existing preview buttons still play whole files.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `PlayButton.tsx` | `toggle(path)` plays or stops the full file | Removing toggle or changing active path semantics |
| `ClipStudioView.tsx` | `play(path, offset, stopAt)` starts at the left crop handle and can stop at the right handle | Ignoring offset/stop parameters |

## Notes
- Playback uses `@tauri-apps/plugin-fs` for local files and falls back to `fetch` for browser-like paths.
