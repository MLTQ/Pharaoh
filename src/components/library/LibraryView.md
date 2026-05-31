# LibraryView.tsx

## Purpose
Character Library — project-independent browser/editor for library characters (Pharaoh-z21). Library bundles live at `<projects_dir>/_library/characters/<library_id>/` and are reusable across episodes via fork-and-pull sync. This view is the home for managing the master copies; in-project edits happen in [CharacterDesignerView](../characters/CharacterDesignerView.md) and flow back via "Save to library".

## Components

### `LibraryView`
- **Does**: Lists library characters in a left sidebar (driven by `listLibraryCharacters`) and opens a full editor on the right when one is selected. Supports creating empty characters, editing name / description / base voice description, adding palette emotions, generating palette take audio directly into the library bundle (Pharaoh-g8z), approving takes as references, and deleting.
- **Interacts with**: `tauriCommands::listLibraryCharacters`, `getLibraryCharacter`, `saveLibraryCharacter`, `deleteLibraryCharacter`, `listPaletteTakes`, `submitTtsVoiceDesign`, `useJobStore`, `useProjectStore`.
- **Rationale**: Library characters are real first-class artifacts now — you can design and refine a character entirely in the library without ever creating a project. Corpus building + RVC training are still deferred — those workflows are infrequent and fit cleanly behind import-to-project + push-back.

### Synthetic `LIBRARY_PROJECT_ID = "_library"`
- **Does**: Routes every backend path-resolution site (`<projects_dir>/<project_id>/characters/<character_id>/...`) into the library bundle (`<projects_dir>/_library/characters/<library_id>/...`) without modifying any existing command.
- **Interacts with**: `submitTtsVoiceDesign`, `listPaletteTakes`, future corpus/rvc commands.
- **Rationale**: The library bundle layout was deliberately designed to mirror a project bundle, so the path math just works. No `_library`-aware variants of TTS/RVC commands needed.

### `PaletteRow` (extended)
- **Does**: Per-emotion accordion row. Header shows label, emotion slug, approval state, and a play button for the reference audio. Expanded body has the emotional direction textarea, a "Generate take" button, the per-emotion take list (job-store jobs + MCP/disk takes deduped), and an "Approve as reference" action that promotes a take to the entry's ref_audio_path.
- **Interacts with**: `PlayButton`, `TakeList`/`TakeRow`, `RunningBadge`, `EmptyTakes` from shared.
- **Rationale**: Generation flows through `submitTtsVoiceDesign` with the synthetic library project id and a slug `__library_palette__<library_id>__<emotion>` so the job store can group takes per emotion the same way it does for project palette tabs.

### `emptyCharacter`
- **Does**: Builds the default Character payload for "+ New". `library_id` is null; the backend allocates one on first save and the UI refreshes from the returned record.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | Renders cleanly when `view === "library"` regardless of whether a project is open | Requiring project context |
| `tauriCommands.ts` | `saveLibraryCharacter` returns the saved Character with `library_id` populated | Returning a different shape |
| `commands/character.rs` | `getLibraryCharacter` returns paths absolutized | Returning relative paths (would break `PlayButton`) |

## Notes
- Save button is the "dirty" affordance — it lights up to the TTS accent color when there are unsaved edits.
- "+ New" allocates a fresh library entry on the backend immediately rather than holding an in-memory draft; this keeps the create flow consistent with the round-trip update flow.
- Selecting a different character with unsaved changes prompts to discard — same convention as Settings.
