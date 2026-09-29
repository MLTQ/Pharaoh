# DissectImportModal.tsx

## Purpose
"Import voices from a recording." Runs the dissect server over an existing audio drama and lets the user turn each detected speaker into a Library character. Opened from the Library sidebar (`From audio…`) and from the Cast "Add character" modal (`From an existing recording`).

## Components

### Stages (`pick` → `running` → `review`)
- **Does**: `pick` chooses a file (native dialog) or reopens a previous import; `running` polls `dissectStatus` every 1.5 s and shows the server's stage message; `review` renders one `DissectSpeakerCard` per speaker.
- **Rationale**: Imports persist on disk, so the modal can be closed mid-run and resumed from Previous imports.

### Rights confirmation (`RIGHTS_STATEMENT`)
- **Does**: A checkbox above the speakers. Until it is ticked every card's Add button is disabled; the statement text is sent with each assignment and recorded on the character as `voice_provenance`.
- **Rationale**: Cloning a performer's voice needs their consent. The Rust command enforces the same gate, so the UI is not the only line.

### `handleAssign`
- **Does**: Calls `dissectAssignSpeaker`; for a *new* character with a `projectId` and "Also add to cast" ticked, follows with `importCharacterFromLibrary`.

### Audiobook sources
- **Does**: The file picker leads with `.m4b` / `.m4a`. When the manifest carries `cover`, `source_tags` and `chapters`, the header shows the cover, album/title, author and chapter count, and each speaker card gets the chapter list.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView.tsx` | `onAssigned(character)` fires after each successful add | Removing the callback |
| `CharacterDesignerView.tsx` | `onAssigned(character, addedToProject)`; reloads the project when true | Changing the arity |
| `commands/dissect.rs` | `dissect_status` returns `import_dir` + relative manifest paths | Absolute paths in manifest |
