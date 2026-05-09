# `peaksStore.ts` — session-scoped waveform-peaks cache

## Intent

Make repeat panel mounts free of Tauri IPC. The Rust side already caches
peaks on disk (one JSON file per resolution next to the WAV); this store
layers an in-memory cache on top so subsequent panel mounts in the same
session don't even round-trip to Rust.

## Why three layers

```
Panel mount  →  in-memory store   (sub-ms)
             →  on-disk JSON      (~1ms read)
             →  ffmpeg/hound      (slow, paid once ever per file+resolution)
```

The two caches are complementary:
- **In-memory** survives panel mounts within a session.
- **On-disk** survives across sessions, machine reboots, and deletes of the
  Pharaoh app data.

Either alone helps; together the user's "first visit" lag becomes a one-time
cost paid at *generation* time (since `jobStore.peaks` already populates the
store on job complete) rather than at view time.

## Contract

```ts
fetchPeaks(path: string, numPeaks: number): Promise<number[]>
peek(path: string, numPeaks: number): number[] | null
invalidate(path: string): void
```

`fetchPeaks` dedupes concurrent requests for the same `(path, numPeaks)` pair
— if three components ask for the same file, only one Tauri call goes out.

## When to invalidate

Generated WAVs in Pharaoh are immutable (a new generation creates a new file
with a unique stem), so cache invalidation is rarely needed. Call
`invalidate(path)` only when:
- An asset was modified externally (rare — would skip the project's normal
  generation pipeline)
- A clip is reprocessed in place (Clip Studio overwrites the source — it
  should call invalidate when it does)
