# LibraryVoiceTab.tsx

## Purpose
Stage-1 "Voice" tab of the library character editor: description + base voice description metadata, Voice Design take generation, the character reference-audio sources list with gold pick / concat (Pharaoh-0b3l), reference transcript, and voice instructions. Subsumes the editor surface that used to live in CharacterDesignerView's "Voice Design" tab.

## Components

### `LibraryVoiceTab`
- **Does**: Owns the voice-tab action handlers:
  - `handleGenerateDesign` — submits a Voice Design TTS job into `<projects_dir>/_library/characters/<id>/design/` via the synthetic `LIBRARY_PROJECT_ID` and slug `__library_design__<id>`; refuses while `dirty` (generation uses the saved character state).
  - `handleUploadCharacterReference` — `+ Upload…` adds N candidate files (each copied to `design/` individually via `importAudioIntoLibraryBundle`); first upload becomes the gold if none is set.
  - `handleConcatCharacterSources` — `Concatenate all → gold` creates a derived combined WAV (`concatAudioIntoLibraryBundle`) and sets it as the gold; individual sources stay in the list.
  - `handlePickCharacterGold` / `handleRemoveCharacterSource` — radio-dot gold pick and source removal (removing the gold promotes the next source); both auto-save.
  - `handleSaveDesignAsReference` — promotes a design take to gold + adds it to the sources list (dedup) + records the test line as `ref_transcript`.
- **Props**: `character` (non-null), `dirty`, `saving`, `patch`, `setCharacter`, `setDirty`, `setSaving`, `setError` (detail-panel banner), plus lifted UI state: `voiceDesignTestLine`, `generatingDesign`, `designGenError` (+ setters).
- **Interacts with**: `useJobStore` (jobs / addJob / setQaStatus), `useProjectStore` (projectsDir), `tauriCommands::saveLibraryCharacter` / `submitTtsVoiceDesign` / `importAudioIntoLibraryBundle` / `concatAudioIntoLibraryBundle`, [SourceRow](./SourceRow.md), `TakeList`/`TakeRow`/`RunningBadge`/`EmptyTakes` from shared, [libraryShared](./libraryShared.md).
- **Rationale**: Handlers travel with the tab UI; persistent UI state (test line, generating flag, inline error) is lifted to [LibraryView](./LibraryView.md) because the tab unmounts on tab switch and that state must survive.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView` | Failures surface via `setDesignGenError` (inline) or `setError` (banner) — never thrown | Throwing would leave `saving` stuck |
| Job store | Design jobs tagged `scene_slug = libraryDesignSlug(id)`, `row_index = LIBRARY_DESIGN_ROW` | Changing the slug orphans existing takes in the list |
