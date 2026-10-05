# cast.rs

## Purpose
Cast housekeeping: merge characters, pair unnamed rebuild voices with named ones, and carry characters between projects as `.pharaoh-cast` packs.

## Components

### `cast_matches(project_id)`
- **Does**: Pairs each placeholder character ("Speaker 9", "S9") with the named character from the same dissected speaker: same `import_id` and `speaker_id` in `voice_provenance`, the named side's Library entry included (a voice split into two speakers and named as one). Reports how many dialogue rows each has.

### `merge_characters(project_id, from_ids, into_id)`
- **Does**: Moves every line of `from_ids` onto `into_id`: script rows (`character`, and dialogue `track`), Fountain cue lines (boundary-safe, so "SPEAKER 1" never claims "SPEAKER 15"; `[[id:…]]` notes kept), each scene's cast list. Removes the merged characters from project.json; their bundle folders stay on disk.

### `export_cast_pack` / `import_cast_pack`
- **Does**: A pack is a zip with `cast.json` and one folder per character (character.json with bundle-relative paths, plus the bundle: references, palette, voice-lock model; the RVC corpus only on request; audio stored uncompressed). Import gives each a fresh id, makes paths absolute, keeps the Library link only if that entry exists locally, and renames clashing names "Name (2)".

### `import_cast_files(project_id, file_paths)`
- **Does**: Imports a mix of packs and single `.pharaoh-character` files at once, returning what was added and which files failed (one bad file doesn't stop the rest). A character file exported from this machine's Library links that entry; otherwise it becomes a new Library entry and is linked.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `CastTools.tsx` | Commands above; merge followed by a project reload | Changing what merge rewrites |
| `cli/dissect.rs` | `pharaoh cast matches|merge|export|import` | Signature changes |

## Notes
- Placeholder names: "Speaker <n>" and "S<n>" only. A character someone renamed is never auto-merged.
