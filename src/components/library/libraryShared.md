# libraryShared.ts

## Purpose
Shared constants, types, and pure helpers for the Character Library component family (`LibraryView` + extracted tabs/widgets). No React state, no JSX — constants, pure functions, and type aliases only.

## Exports

### `LIBRARY_PROJECT_ID = "_library"`
- **Does**: Synthetic "project id" that routes every backend path-resolution site (`<projects_dir>/<project_id>/characters/<character_id>/...`) into the library bundle (`<projects_dir>/_library/characters/<library_id>/...`) without modifying any existing command.
- **Rationale**: The library bundle layout deliberately mirrors a project bundle, so the path math just works. No `_library`-aware variants of TTS/RVC commands needed.

### `LIBRARY_PALETTE_ROW` / `LIBRARY_DESIGN_ROW` / `DEFAULT_TEST_LINE`
- Fixed row indices for synthetic library jobs + the default synthesis test line.

### `libraryPaletteSlug(libraryId, emotion)` / `libraryDesignSlug(libraryId)`
- **Does**: Build the synthetic scene slugs (`__library_palette__<id>__<emotion>`, `__library_design__<id>`) used to group job-store takes per emotion / per character.

### `LibraryTab` / `tabToStage` / `stageToTab`
- **Does**: Maps the library's tab strip to the same `VoicePipelineStage` enum the project view uses (Voice 1 / Palette 2 / Corpus 3 / Model 4).

### `CHAR_HUE(id)`
- Deterministic hue for a character's color dot.

### `emptyCharacter()`
- **Does**: Builds the default Character payload for "+ New". `library_id` is null; the backend allocates one on first save and the UI refreshes from the returned record.

### `formatRelative(iso)`
- "just now / 5m ago / 3h ago / 2d ago / date" formatting for the meta footer.

### `TakeJob`
- Job-shaped object accepted by `TakeList` — covers job-store jobs and synthesized "disk job" rows for MCP-generated takes that bypass the in-memory queue. Derived as `Parameters<typeof TakeRow>[0]["job"]`.

### `pickAudioFiles(multi)`
- **Does**: Native open dialog → picked source paths (multi-select) or `[]`. Multi-file upload is preferred for voice cloning (Pharaoh-aonr).
- **Errors**: A dialog failure raises a "Pick audio files" error toast via `reportError` and resolves `[]` (user cancel returns `[]` silently — that path doesn't throw).

### `labelStyle`
- The shared mono uppercase field-label `CSSProperties` used across all library form sections.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView` / tabs | Slug helpers stay stable | Changing slug format orphans existing job-store grouping |
| Backend path math | `LIBRARY_PROJECT_ID === "_library"` | Renaming breaks every library-side generation path |
