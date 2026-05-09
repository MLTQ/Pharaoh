# AssetBrowser.tsx

## Purpose
Sidebar browser for generated takes, assigned script-row assets, and mock assets. It lets users review waveforms, toggle QA state, and explicitly switch a row to a different take.

## Components

### `TakeGroup`
- **Does**: Renders all completed takes for a single script row with QA and “use” controls.
- **Interacts with**: `jobStore.ts`, `PlayButton.tsx`.

### `AssetBrowser`
- **Does**: Groups completed jobs by row, reads the active scene's assigned `script.csv` files, and renders dialogue/SFX/music sections alongside mock assets.
- **Interacts with**: `listGeneratedAudioAssets`, `readScript`, `updateScriptRow` in `tauriCommands.ts`, `jobStore.ts`, `assetRouting.ts`.

### `PersistentAssetRow`
- **Does**: Renders sidecar-backed or script-assigned assets that are not represented by the current in-memory job store.
- **Interacts with**: `routeAudioToScene`, `updateSidecarQa`.
- **Rationale**: Asset visibility must survive app restarts and cross-scene routing, not depend only on transient jobs.

### Asset dragging
- **Does**: Serializes asset kind, file path, prompt, duration, track, and character metadata into native drag payloads and emits a pointer-drop fallback on release.
- **Interacts with**: `CompositionView.tsx`.

### `handleUse`
- **Does**: Marks a selected take active and writes that file path back to the correct scene row.
- **Interacts with**: `script.rs`.
- **Rationale**: Alternate take selection must target the take’s own scene, not whichever scene is currently open in the composition view.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Users | Clicking `use` swaps the row to that exact take | Writing to a different row/scene |
| `jobStore.ts` | `activeTakes` keys are `{scene_slug}:{row_index}` | Key format changes |
| Generator panels | Routing emits `SCRIPT_ASSETS_CHANGED_EVENT` so assigned assets refresh while mounted | Removing refresh event |
| `CompositionView.tsx` | Drag payload MIME is `application/x-pharaoh-asset`, with JSON/text/snapshot/pointer fallbacks | Changing payload format without updating both sides |

## Notes
- First-take binding now happens automatically in the backend. This component remains responsible for explicit alternate-take promotion.
- The sidebar shows assets assigned to the active scene even when the source sidecar belongs to another scene.
