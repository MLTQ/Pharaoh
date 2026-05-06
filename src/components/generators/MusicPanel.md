# MusicPanel.tsx

## Purpose
Scene-level score composition panel for ACE-Step music generation. It starts with empty direction fields, exposes the request parameters the backend accepts, and lists real generated cues for the selected scene.

## Components

### Caption and lyrics editors
- **Does**: Collect the ACE-Step caption and optional lyrics/textless vocal instruction.
- **Interacts with**: `submitMusic` in `useGenerateJob.ts`.

### Parameter controls
- **Does**: Exposes duration, BPM, key, LM model size, diffusion steps, thinking mode, reference audio path, seed, and batch size.
- **Interacts with**: `MusicText2MusicRequest`, `music_server.py`.

### Generated list
- **Does**: Shows running/failed/current-session music jobs plus persisted ACE-Step sidecars for the selected scene.
- **Interacts with**: `jobStore.ts`, `listGeneratedAudioAssets`, `getWaveformPeaks`, `PlayButton`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `useGenerateJob.ts` | Music parameters are passed through rather than hardcoded | Removing parameter fields |
| `projectStore.ts` | Selected scene is synced before submission | Submitting to a different scene than the router shows |
| Users | Generated list reflects real score cues for the selected scene | Reintroducing static hit-list/mock cues |

## Notes
- Reference audio is currently passed as a path, consistent with the rest of Pharaoh's shared-filesystem inference contract.
