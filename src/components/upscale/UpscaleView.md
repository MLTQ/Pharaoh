# UpscaleView.tsx

## Purpose
Dedicated post-processing page for reviewing generated WAV assets and running neural upscaling. It indexes persisted sidecars rather than the transient job queue so users can improve assets from previous sessions.

## Components

### Asset list
- **Does**: Loads `GeneratedAudioAsset` records for the active project, filters by kind, shows waveform previews, and selects an input.
- **Interacts with**: `listGeneratedAudioAssets`, `getWaveformPeaks`, `PlayButton`.

### AudioSR controls
- **Does**: Exposes AudioSR model, DDIM steps, guidance, and seed before invoking upscaling.
- **Interacts with**: `upscaleAudioAsset`.
- **Rationale**: AudioSR has a general model and a speech model; users need to pick based on ambience/SFX/music versus dialogue.

### Setup guidance
- **Does**: Shows the optional AudioSR setup command when the backend reports that the CLI is missing.
- **Interacts with**: `inference/setup.sh`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | `UpscaleView` renders as a full canvas page | Requiring props not supplied by the app shell |
| `tauriCommands.ts` | `upscaleAudioAsset` returns the output WAV path | Changing return type |
| Users | Upscaled output appears in the asset list after completion | Not refreshing after success |

## Notes
- The page intentionally does not auto-install AudioSR. Optional model environments stay explicit because they are large and slow.
