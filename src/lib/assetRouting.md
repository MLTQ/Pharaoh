# assetRouting.ts

## Purpose
Shared frontend helper for assigning generated audio assets into scene `script.csv` rows. It keeps generator panels and the asset browser on one routing contract.

## Components

### `routeAudioToScene`
- **Does**: Routes a TTS, SFX, or music file to the first matching script row for a scene, preferring empty rows over replacing populated rows.
- **Interacts with**: `readScript`, `updateScriptRow` in `tauriCommands.ts`.
- **Rationale**: Generator pages select assets by kind, not by arbitrary row; the helper centralizes the kind-to-row-type mapping.

### `SCRIPT_ASSETS_CHANGED_EVENT`
- **Does**: Notifies mounted UI such as `AssetBrowser.tsx` that script file assignments changed.
- **Interacts with**: Browser `window` events.

### Asset drag payload helpers
- **Does**: Defines the drag MIME type, pointer-drop event, and current in-process asset payload while dragging.
- **Interacts with**: `AssetBrowser.tsx`, `CompositionView.tsx`.
- **Rationale**: Tauri/WebKit can be inconsistent about exposing custom drag MIME data; the pointer-drop event and snapshot provide a reliable fallback.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Generator panels | TTS routes to `DIALOGUE`, SFX routes to `SFX`/`BED`, music routes to `MUSIC` | Changing row-type mapping |
| `AssetBrowser.tsx` | Routing emits `SCRIPT_ASSETS_CHANGED_EVENT` after assignment | Removing the event |
| `CompositionView.tsx` | Drag MIME is `application/x-pharaoh-asset`; pointer drop and fallback snapshot use the same payload shape | Changing drag payload fields |
