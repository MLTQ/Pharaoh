# SFXPanel.tsx

## Purpose
Scene-level sound-design panel for generating foley, effects, ambience beds, and long soundscapes. It exposes the SFX server's controllable Woosh and AudioLDM parameters while keeping generated takes tied to the selected scene.

## Components

### Prompt editor
- **Does**: Starts empty and sends the user's direction text as the generation prompt.
- **Interacts with**: `RichDirector`.

### Backend and model controls
- **Does**: Selects Woosh or AudioLDM and exposes compatible model variants.
- **Interacts with**: `submitSfx` in `useGenerateJob.ts`, `sfx_server.py`.
- **Rationale**: Woosh is preferred for short foley; AudioLDM is the long-bed/soundscape path.

### Parameter controls
- **Does**: Exposes duration, steps, seed, Woosh CFG scale, AudioLDM guidance, AudioLDM candidate count, and AudioLDM negative prompt.
- **Interacts with**: `SfxT2ARequest`, `T2AParams`.

### Generated list
- **Does**: Shows running/failed/current-session jobs plus persisted Woosh/AudioLDM SFX sidecars for the selected scene, and lets completed takes be selected for routing.
- **Interacts with**: `jobStore.ts`, `listGeneratedAudioAssets`, `getWaveformPeaks`, `PlayButton`.
- **Rationale**: The page should show real generated takes, not static mock variations.

### Scene routing
- **Does**: Sends the selected completed SFX take to the target scene's first empty `SFX`/`BED` row, replacing the first matching row only if no empty row exists.
- **Interacts with**: `routeAudioToScene` in `assetRouting.ts`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `useGenerateJob.ts` | Backend is one of `woosh` or `audioldm` | Renaming backend values |
| `projectStore.ts` | Selected scene is synced before submission | Submitting to a different scene than the router shows |
| Users | Generated list reflects the selected scene's real SFX takes | Reintroducing mock variation cards |
| Users | Completed SFX takes can be selected and sent to a scene | Making the generated list review-only |

## Notes
- AudioLDM native rounds duration to 2.5 second increments server-side.
- AudioLDM candidate ranking requires CUDA; non-CUDA hosts force one candidate even if the UI requests more.
