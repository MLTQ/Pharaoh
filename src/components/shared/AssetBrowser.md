# AssetBrowser.tsx

## Purpose
Sidebar browser for generated takes and mock assets. It lets users review waveforms, toggle QA state, and explicitly switch a row to a different take.

## Components

### `TakeGroup`
- **Does**: Renders all completed takes for a single script row with QA and “use” controls.
- **Interacts with**: `jobStore.ts`, `PlayButton.tsx`.

### `AssetBrowser`
- **Does**: Groups completed jobs by row and renders dialogue/SFX/music sections alongside mock assets.
- **Interacts with**: `updateScriptRow` in `tauriCommands.ts`, `jobStore.ts`.

### `handleUse`
- **Does**: Marks a selected take active and writes that file path back to the correct scene row.
- **Interacts with**: `script.rs`.
- **Rationale**: Alternate take selection must target the take’s own scene, not whichever scene is currently open in the composition view.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Users | Clicking `use` swaps the row to that exact take | Writing to a different row/scene |
| `jobStore.ts` | `activeTakes` keys are `{scene_slug}:{row_index}` | Key format changes |

## Notes
- First-take binding now happens automatically in the backend. This component remains responsible for explicit alternate-take promotion.
