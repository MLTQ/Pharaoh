# SFXPanel.tsx

## Purpose
Scene-level sound-design panel for generating foley, effects, ambience beds, and long soundscapes.

## Components

### Backend selector
- **Does**: Lets users choose Woosh for short foley or AudioLDM for long soundscapes.
- **Interacts with**: `submitSfx` in `useGenerateJob.ts`.
- **Rationale**: Woosh quality is preferred for short effects, but it is not the right tool for minute-scale rain, room tone, wind, traffic, or other beds.

### Duration control
- **Does**: Sends an explicit requested duration with the SFX job.
- **Interacts with**: Tauri `submit_sfx_t2a` and `sfx_server.py`.
- **Rationale**: Agents need headless access to long ambience generation without stitching or looping many 5-second clips.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `useGenerateJob.ts` | Backend is one of `woosh` or `audioldm` | Renaming backend values |
| Users | AudioLDM is selected explicitly for long beds | Silently forcing all SFX through AudioLDM |

## Notes
- The panel does not auto-install AudioLDM dependencies. `PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh` prepares that optional backend.
