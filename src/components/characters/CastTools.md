# CastTools.tsx

## Purpose
Cast & Voices housekeeping UI over [cast.rs](../../../src-tauri/src/commands/cast.md).

## Components

### `CastMatchBanner`
- **Does**: Above the character detail, when unnamed rebuild voices match named characters: a count, a Review list (checkbox per pair, with speaker id and line count) and **Merge N**. Reloads the project after.

### `MergeIntoControl`
- **Does**: "Merge into…" in the character header: moves the character's lines onto the chosen one (with a confirm) and removes it.

### `CastPackButtons`
- **Does**: Under the cast list header: **Import cast** (pick any number of `.pharaoh-cast` packs and `.pharaoh-character` files; a file that fails is reported and the rest still import), **Export cast** (every character, one pack, straight to a save dialog) and **…** (choose some: All / None / Named only, optional training corpus).
