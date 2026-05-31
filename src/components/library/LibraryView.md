# LibraryView.tsx

## Purpose
Character Library — project-independent browser/editor for library characters (Pharaoh-z21). Library bundles live at `<projects_dir>/_library/characters/<library_id>/` and are reusable across episodes via fork-and-pull sync. This view is the home for managing the master copies; in-project edits happen in [CharacterDesignerView](../characters/CharacterDesignerView.md) and flow back via "Save to library".

## Components

### `LibraryView`
- **Does**: Lists library characters in a left sidebar (driven by `listLibraryCharacters`) and opens a metadata editor on the right when one is selected. Supports creating empty characters, editing name/description/base voice description/palette directions, and deleting.
- **Interacts with**: `tauriCommands::listLibraryCharacters`, `getLibraryCharacter`, `saveLibraryCharacter`, `deleteLibraryCharacter`.
- **Rationale**: Library editing is intentionally scoped to metadata only in this MVP — generating palette takes, building the corpus, and training RVC require project context (output paths, job tracking) and are deferred to a follow-up. The user can import the character into a project to do those steps, then "Save to library" to push back.

### `PaletteRow`
- **Does**: Per-emotion accordion row showing the label, emotion slug, approval state, and a play button for the reference audio. Expands to an editable "emotional direction" textarea.
- **Interacts with**: `PlayButton`.
- **Rationale**: Direction text is metadata, so it's editable here. Adding/removing palette entries or regenerating the reference WAV is a generation operation — deferred with the rest.

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
