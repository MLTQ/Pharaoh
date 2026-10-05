# LibraryPaletteTab.tsx

## Purpose
Stage-2 "Palette" tab of the library character editor: add emotions, generate per-emotion Voice Design takes directly into the library bundle (Pharaoh-g8z), upload existing recordings as per-emotion references, and approve a take as the entry's reference audio.

## Components

### `LibraryPaletteTab`
- **Does**: Owns the palette action handlers:
  - `handleAddEmotion` — validates/slugifies the new-emotion form (dupes rejected via `paletteGenError`) and appends a `PaletteEntry` through `patch` (marks dirty; saved with the Save button).
  - `handleBuildFromRecording` — "⤓ Build from recording" (characters with Dissect provenance): `build_palette_from_recording` fills the palette from the performance — per emotion the clearest lines (recipe + `strong`), best approved as the reference (a different line per emotion), the rest as alternates; existing approvals kept unless "replace approved". Shows a report: emotions filled, lines added, emotions with no clear example, sources not yet read.
  - `handleAddBaseline` — "+ Baseline set": appends the missing `BASELINE_EMOTIONS` (neutral, happy, excited, tender, sad, angry, afraid, sardonic, whisper) with written directions; marks dirty.
  - `handleGeneratePaletteTake` — for a cloned voice (`clonesVoice`: has a gold reference) clones the gold on the TTS port with the emotion's direction as `instruct` and its sample line (the test line, if set, overrides it). Otherwise submits a Voice Design job with instruct = base voice description + entry direction, output into `<bundle>/palette/`, slug `__library_palette__<id>__<emotion>`; saves pending edits first via `ensureSaved`.
  - `handleUploadPaletteReference` — per-emotion upload-as-source (mirrors voice-tab semantics: first upload promoted to gold + auto-approved if no existing ref); auto-saves.
  - `handleUseRecordingClip` — "Use" in [RecordingClips](./RecordingClips.md): cuts the clip from the dissected dialogue, copies it into the bundle's `palette/`, and makes it the entry's approved reference (its text becomes `ref_transcript`).
  - `handleApprovePaletteTake` — promotes a take to the entry's `ref_audio_path`, persists immediately (approval is high-value; no manual Save needed), then `refreshList`.
- **Props**: `character` (non-null), `dirty`, `patch`, `setCharacter`, `setDirty`, `setSaving`, `setError`, `refreshList`, plus lifted UI state (`paletteTestLine`, add-emotion form fields, `paletteGenError` + setters) and `paletteDiskTakes` (disk-scanned takes, refreshed by LibraryView on character change).
- **Interacts with**: `useJobStore`, `useProjectStore`, `tauriCommands::saveLibraryCharacter` / `submitTtsVoiceDesign` / `importAudioIntoLibraryBundle`, [libraryShared](./libraryShared.md).

### `PaletteRow` (private)
- **Does**: Per-emotion accordion row. Header shows label, emotion slug, approval state, and a play button for the reference audio. Expanded body has the emotional direction textarea, "Generate take" / "Upload reference…" buttons, the per-emotion take list (job-store jobs + MCP/disk takes deduped by output path; disk takes get synthetic `disk::<path>` ids), and an "Approve as reference" action.
- **Interacts with**: `PlayButton`, `TakeList`/`TakeRow`, `RunningBadge`, `EmptyTakes` from shared.
- **Rationale**: Generation flows through `submitTtsVoiceDesign` with the synthetic library project id so the job store can group takes per emotion the same way it does for project palette tabs.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView` | `paletteDiskTakes` keyed by emotion slug; this tab never fetches it | Fetching here would only scan while the tab is open |
| Job store | QA updates skipped for `disk::` ids (sidecar-backed, not in the store) | Forwarding them would throw on unknown job ids |
- With Breeze, "Generate take" clones the gold clip performing the emotion's written direction on its sample line.
