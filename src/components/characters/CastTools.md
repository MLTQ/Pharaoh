# CastTools.tsx

## Purpose
Cast & Voices housekeeping UI over [cast.rs](../../../src-tauri/src/commands/cast.md).

## Components

### `CastMatchBanner`
- **Does**: Above the character detail, when unnamed rebuild voices match named characters: a count, a Review list (checkbox per pair, with speaker id and line count) and **Merge N**. Reloads the project after.

### `MergeIntoControl`
- **Does**: "Merge into…" in the character header: moves the character's lines onto the chosen one (with a confirm) and removes it.

### `CastPackButtons`
- **Does**: **Import pack** / **Export pack** under the cast list header. Export opens a checklist (All / None / Named only, optional training corpus) and a save dialog; import adds a pack's characters to the project.
