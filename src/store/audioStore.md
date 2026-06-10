# audioStore.ts

## Purpose
Lightweight streaming preview store for generated WAV files. It centralizes clip playback so page components and shared preview buttons do not each create their own audio pipeline.

## Components

### `useAudioStore`
- **Does**: Tracks the active path, duration, and playback position; exposes `play`, `stop`, and `toggle`.
- **Interacts with**: `PlayButton.tsx`, `ClipStudioView.tsx`.

### `play`
- **Does**: Uses a streaming `HTMLAudioElement`, starts playback from an optional offset, and stops at an optional stop point.
- **Rationale**: Clip Studio needs deterministic region preview from crop handles while existing preview buttons still play whole files.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `PlayButton.tsx` | `toggle(path)` plays or stops the full file | Removing toggle or changing active path semantics |
| `ClipStudioView.tsx` | `play(path, offset, stopAt)` starts at the left crop handle and can stop at the right handle | Ignoring offset/stop parameters |

## Notes
- Local filesystem paths are converted with Tauri `convertFileSrc`; browser-like URLs are passed through unchanged.
- **Error surfacing**: `play` never rejects — failures are caught internally, reported via `lib/errors.reportError("Playback failed", …)` (error toast + console), and playback state is reset. The toast uses the stable id `audio-play-failed` so rapid retries (e.g. scrubbing) refresh one toast instead of stacking. Call sites do not need their own `.catch` for user feedback.
- `playableSrc` resolves through `fileSrc` in `lib/transport.ts`: Tauri asset protocol on the host, the share server's Range-aware `/file` route for mesh viewers.
