# CharacterDesignerView.tsx

## Purpose
Per-episode **Cast manifest** (Pharaoh-8xu) — a read-only browser of who's in this episode and what they say. The full character editor (Voice / Palette / Corpus / Model) lives in [LibraryView](../library/LibraryView.md); this view is for project-scoped concerns: roster, library linkage / drift, and the per-character line list across scenes.

## Components

### `deriveVoiceBadge`
- **Does**: Pure derivation of the UI mode badge ("Chatterbox + RVC" / "Chatterbox" / "Reference" / "Voice Design" / "Empty") from data shape, replacing the overloaded legacy `model` enum.
- **Interacts with**: sidebar chip, detail header chip, right-meta "Mode" section.
- **Rationale**: The `VoiceAssignment.model` field is retained for back-compat reads but no longer drives the UI — `production_pipeline`, palette state, and ref presence are the real source. Lets us delete the enum cleanly when MCP no longer writes it.

### Lines manifest (Pharaoh-8xu)
- **Does**: For the active character, loads every scene's `script.csv` via `readScript`, filters rows whose `character` column matches the character's id or name, groups by scene, renders a list with prompt + emotion + render-state dot + play button when rendered.
- **Interacts with**: `tauriCommands::readScript`, `realScenes` from `projectStore`, `PlayButton`.
- **Rationale**: Cast is now answering "who's in this episode and what do they say?" — not "how is this character designed?" The line list makes that role explicit and gives the user a quick scan of unresolved vs rendered dialogue per character.

### Open-in-Library CTA (`setView("library")`)
- **Does**: Sidebar/header button on every character that switches the active view to the Character Library. Labelled "Open in Library →" for library-linked characters or "Design voice in Library →" for project-only ones.
- **Rationale**: All voice editing happens in the Library now. The CTA is the discoverable bridge.

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
