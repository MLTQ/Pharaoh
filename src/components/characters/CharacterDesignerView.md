# CharacterDesignerView.tsx

## Purpose
Cast and voice-design workspace for creating characters, testing generated voices, and saving clone references. It owns character-level TTS probes that are separate from scene `script.csv` rows.

## Components

### `handleGenerateDesign`, `handleGenerateClone`
- **Does**: Submit voice design and clone test jobs, then add returned jobs to the frontend queue.
- **Interacts with**: `submitTtsVoiceDesign`, `submitTtsVoiceClone` in `tauriCommands.ts`, `jobStore.ts`.
- **Rationale**: Uses a synthetic `__char__{id}` scene slug so character takes do not collide with scene generation takes.

### Clip Studio reference selection
- **Does**: Lists sidecar-indexed TTS/reference assets so cropped long-recording clips can become clone references.
- **Interacts with**: `listGeneratedAudioAssets`, `getWaveformPeaks`, `ClipStudioView.tsx`.
- **Rationale**: Voice references should be reusable after import/cropping rather than requiring path re-entry.

### `submitting`
- **Does**: Tracks the gap between button click and returned job id so the page shows work-in-progress even before normal job events arrive.
- **Interacts with**: `RunningBadge` in `TakeList.tsx`.

### `saveVoice`, `outputPath`
- **Does**: Persist selected voice assignment data and choose character asset output paths.
- **Interacts with**: `projectStore.ts`, project character folders.

### Cast deletion
- **Does**: Exposes explicit delete controls in the cast list and character header, confirms destructive intent, and removes the character from persisted `project.json`.
- **Interacts with**: `removeCharacter` in `projectStore.ts`.
- **Rationale**: Generated character audio remains on disk, but the cast record should be removable from the project metadata.

### Cast modal (`openCastModal`, `handleImportFromLibrary`, `handleAddCharacter`)
- **Does**: The Cast `+` button opens a modal with two paths: "Import from library" lists `LibraryCharacterSummary` entries with click-to-import, and "New character (project-only)" prompts for a name. Import calls `importCharacterFromLibrary` then `reloadProjectFromDisk` so the new bundle's palette refs / RVC config land in the in-memory project.
- **Interacts with**: `listLibraryCharacters`, `importCharacterFromLibrary`, `projectStore.reloadProjectFromDisk`.
- **Rationale**: Replaces the old inline-form `+` flow. Library-already-imported entries are shown disabled so you can't accidentally add the same character twice.

### `handleSaveToLibrary`
- **Does**: Header button that copies the current character bundle to the library via `saveCharacterToLibrary`. Labelled "Save to library" for project-only characters and "Update library" for library-linked ones — same backend call.
- **Interacts with**: `saveCharacterToLibrary`, `reloadProjectFromDisk` (so the new `library_id` + `library_version` appear on the character).

### `refreshLibrary` + `libraryVersionMap` + `hasDrift`
- **Does**: Fetches library summaries on mount and whenever the character list changes; builds a `library_id → library_version` map; per-character `hasDrift` compares the project's `library_version` against the live library value.
- **Rationale**: Drift gets surfaced as a small dot on the sidebar character chip, a "Drift" badge in the detail header, and a full action banner above the pipeline stages (push / pull / detach).

### Drift banner (`handlePullFromLibrary`, `handleDetachFromLibrary`)
- **Does**: When the active character is library-linked and has drifted, renders a banner above the pipeline header offering three actions: Push your changes (existing `handleSaveToLibrary`), Pull library version (`pullCharacterFromLibrary`), and Detach (clears `library_id` + `library_version` locally via `updateCharacter`).
- **Interacts with**: `pullCharacterFromLibrary`, `updateCharacter`, `reloadProjectFromDisk`, `refreshLibrary`.
- **Rationale**: Pull is destructive (overwrites local edits) so it's gated by a confirm. Detach is purely a local mutation — no backend round-trip — because the character record is what owns the library_id field; clearing it on the project side severs the link without disturbing the library entry itself.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `projectStore.ts` | Voice assignment updates persist into `project.json` | Changing assignment shape |
| `projectStore.ts` | Character deletion removes the cast record and updates selection, including empty-cast state | Blocking deletion of the final character |
| `projectStore.ts` | `reloadProjectFromDisk` exists and returns a promise | Removing the disk-reload hook (import + save-to-library both need it) |
| `commands/character.rs` | `importCharacterFromLibrary` returns the new Character with a project-local `CHAR_XXXX` id | Returning the library id (would collide with existing chars) |
| `jobStore.ts` | Character takes use `scene_slug` + `row_index` keys | Key format changes |
| `ClipStudioView.tsx` | Cropped/imported references are sidecar-indexed and listable | Saving clips without sidecars |
| `inference.rs` | Clone requests include a bounded `max_new_tokens` value | Removing the cap from clone requests |

## Notes
- Clone generation can spend a long time inside Qwen before producing audio. The submitting state keeps the page from looking idle before the backend job id is available.
