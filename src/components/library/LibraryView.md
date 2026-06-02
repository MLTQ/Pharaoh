# LibraryView.tsx

## Purpose
Character Library — the **canonical character creation suite** (Pharaoh-37l). Library bundles live at `<projects_dir>/_library/characters/<library_id>/` and are reusable across episodes via fork-and-pull sync. All voice design, palette construction, corpus building, and RVC training happens here; [CharacterDesignerView](../characters/CharacterDesignerView.md) is a read-only per-episode manifest that imports library characters and shows their assigned lines.

## Components

### `LibraryView`
- **Does**: Lists library characters in a left sidebar and opens a full 4-stage pipeline editor on the right when one is selected. Tabs map to the same `VoicePipelineStage` enum the project view uses (Voice / Palette / Corpus / Model) so users see one consistent pipeline shape regardless of where they're editing.
- **Interacts with**: `CharacterPipeline`, `CorpusBuilder`, `RvcModelStage`, `tauriCommands::listLibraryCharacters` / `getLibraryCharacter` / `saveLibraryCharacter` / `deleteLibraryCharacter` / `listPaletteTakes` / `submitTtsVoiceDesign`, `useJobStore`, `useProjectStore`.
- **Rationale**: Resolves the two-editors-for-same-data confusion in the original Cast+Library split. One editor, one place to learn the pipeline, one place where audio generation happens.

### Voice tab (stage 1)
- **Does**: Description + base voice description + Voice Design take generation + single-ref upload + reference transcript + voice instructions.
- **Rationale**: Subsumes the editor surface that used to live in CharacterDesignerView's "Voice Design" tab.

### Palette tab (stage 2)
- **Does**: Add emotions + generate per-emotion palette takes + approve as reference. Unchanged from Pharaoh-g8z.

### Corpus tab (stage 3)
- **Does**: Drops in `CorpusBuilder` with `projectId="_library"`. The component is project-store-independent — it takes `projectId + character + projectsDir + onCorpusUpdated` as props and routes all backend calls through the synthetic library project id.

### Model tab (stage 4)
- **Does**: Drops in `RvcModelStage` similarly. Re-fetches the library character via `getLibraryCharacter` after training completes so the trained model path appears in the UI immediately.

### Clone-from-file (Pharaoh-b9hf + Pharaoh-aonr)
- **Does**: Two upload affordances that copy / concatenate external audio file(s) into the library bundle and wire them as a reference:
  - Voice tab "Upload audio file…" button — multi-select; picks the character's single `ref_audio_path` (slot=`design`). When N>1 the files are concatenated into a single richer reference clip.
  - Palette tab per-emotion "Upload reference…" button — multi-select; sets that emotion's `ref_audio_path` and auto-approves it (slot=`palette`). Same N>1 → concat behavior.
- **Interacts with**: `concatAudioIntoLibraryBundle`, `@tauri-apps/plugin-dialog::open`, `saveLibraryCharacter` (auto-save after upload).
- **Rationale**: Restores the clone-from-file surface lost in the role-separation refactor (Pharaoh-b9hf) and extends it with multi-file concatenation (Pharaoh-aonr) so users with multiple takes of the same actor can build a longer, more-varied reference — Chatterbox's speaker embedding is much more stable from 30-60s of varied audio than from a single ~10s clip. Files live inside the bundle so `.pharaoh-character` exports stay self-contained.

### Export / Import file (Pharaoh-tlt4)
- **Does**: Per-character `Export…` button + a `+corpus` toggle write a `.pharaoh-character` file (zip) via the native save dialog. Library-header `Import…` button reads one back via the native open dialog and adds it as a new library entry with a fresh `library_id`.
- **Interacts with**: `exportLibraryCharacter`, `importLibraryCharacterFromFile`, `@tauri-apps/plugin-dialog`.
- **Rationale**: Cross-machine character portability. Trained RVC model + index are always included; raw `rvc_corpus/` is opt-in (large files, only useful for retraining). Import always forks — no risk of clobbering a local entry by accident.

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
