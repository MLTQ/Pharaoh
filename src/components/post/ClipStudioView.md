# ClipStudioView.tsx

## Purpose
Post-production clip editor for generated and imported Pharaoh audio assets. It lets users import long recordings, zoom into sidecar-indexed WAV files, apply practical ffmpeg edits, save child assets, and optionally assign the result to a scene script row.

## Components

### `ClipStudioView`
- **Does**: Lists generated/imported assets, imports external audio, previews zoomable waveform peaks, exposes trim/gain/fade/filter/normalize controls, handles Space-bar crop preview, and calls `processClipAsset`.
- **Interacts with**: `importAudioAsset`, `listGeneratedAudioAssets`, `getWaveformPeaks`, `processClipAsset`, `readScript`, `updateScriptRow`, `useProjectStore`, `useAudioStore`.
- **Rationale**: Clip editing is post-production but not neural upscaling, so it stays separate from `UpscaleView`.

### `CropWaveform`
- **Does**: Renders the waveform with draggable vertical crop handles, zoom/pan viewport support, and trim state tied to `startMs` and `endMs`.
- **Interacts with**: `PeaksWave`, `Wave`, Clip Studio trim state.
- **Rationale**: Cropping needs direct manipulation rather than only numeric fields.

### `saveClip`
- **Does**: Processes the selected asset into a child WAV and, when requested, writes that output path back to the selected script row.
- **Interacts with**: Rust `process_clip_asset` command and script CSV update commands.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | Component renders as the `clip-studio` page | Renaming the exported component |
| `tauriCommands.ts` | `importAudioAsset` and `processClipAsset` return written WAV paths | Changing command return types |
| `audioStore.ts` | `play(path, offset, stopAt)` previews crop regions | Removing region playback support |
| Script rows | Row indexes are zero-based and scene-local | Passing display row numbers instead |

## Notes
- This page performs deterministic local ffmpeg processing, not ML inference. AudioSR remains isolated in `UpscaleView` and the Post server.
