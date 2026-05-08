# `renderMetaStore.ts` — measured loudness per scene

## Intent

Surfaces the real LUFS / true-peak / loudness-range numbers that `render_scene`
writes to `render.wav.meta.json`. Replaces the placeholder values that used to
live as a hardcoded string in the transport bar.

## Why a separate store

The metering data is keyed by scene slug and updates on two events:
1. A scene render completes (CompositionView writes the new meta in).
2. A scene becomes active in the workspace (CompositionView eagerly loads any
   meta already on disk).

Either event needs to update the transport bar (rendered in `App.tsx`) without
prop-drilling. Zustand keeps it ambient.

## Contract

```ts
metaBySlug: Record<string, RenderMeta>
setMeta(slug, meta)
getMeta(slug) -> RenderMeta | null
clearMeta(slug)
```

`RenderMeta` is the shape of `render.wav.meta.json` — see `tauriCommands.ts`.

## Spec-compliance bands

The transport bar colors the readout by deviation from `target_lufs`:
- ≤ 1 LU drift → green (within spec)
- ≤ 2 LU drift → amber (close)
- > 2 LU drift → alarm (re-render required)

True peak: green ≤ -1 dBTP, amber ≤ 0 dBTP, alarm > 0 dBTP.
