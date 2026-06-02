# character.rs

## Purpose
Character library commands. Implements the fork-and-pull sync model between
project-scoped characters (inline in `project.json`) and the project-independent
library at `<projects_dir>/_library/characters/<library_id>/`. Library bundles
mirror in-project bundle layout (`character.json` + `palette/` + `rvc/` +
`rvc_corpus/`) so import/save are essentially a recursive copy plus a path
relativization pass.

## Components

### `list_library_characters`
- **Does**: Scans `<projects_dir>/_library/characters/` for `character.json` files and returns lightweight `LibraryCharacterSummary` entries (name, description, palette count, RVC presence, version timestamp).
- **Interacts with**: `app_support::library_root_dir`, `LibraryCharacterSummary` in `models.rs`.
- **Rationale**: List is intentionally cheap — it never scans the RVC corpus or loads full character data. Corrupt or partially-written entries are skipped silently rather than failing the whole call.

### `save_character_to_library`
- **Does**: Copies a project's character bundle into the library and writes the relativized `character.json`. Generates a fresh `library_id` if the character has none, otherwise updates the existing library entry in place. Updates the project's character record with the new `library_id` + `library_version` and rewrites `project.json`.
- **Interacts with**: `app_support::copy_dir_recursive`, `app_support::relativize_voice_paths`, `commands::project`.
- **Rationale**: Bundle copy and metadata update happen in sequence with the bundle copy first — if it fails, the project record stays untouched. `relativize_voice_paths` runs against the LIBRARY bundle dir because the copy preserves filenames, so the library version's relative paths resolve correctly when later imported.

### `import_character_from_library`
- **Does**: Copies a library bundle into a project, generates a fresh project-local `CHAR_XXXX` id, applies an optional name override, and pushes the new character into `project.json`. Library `character.json` copy is removed from the project bundle (project characters live inline in `project.json`, not as sibling files).
- **Interacts with**: `app_support::copy_dir_recursive`, `app_support::absolutize_voice_paths`.
- **Rationale**: Paths inside the library bundle are relative; the rest of the codebase (TTS submission, MCP, etc.) still expects absolute paths until Pharaoh-1qp lands. `absolutize_voice_paths` is the seam — switch storage to relative later by deleting the absolutize call.

### `delete_library_character`
- **Does**: Removes a library bundle directory. Idempotent — missing entries return Ok.
- **Interacts with**: `app_support::library_character_dir`.
- **Rationale**: Does not scan or modify any project. Project characters that imported from this entry become "detached" (library_id still set, library entry missing); surfacing that state is a UI concern handled in Pharaoh-wpk.

### `get_library_character`
- **Does**: Reads a single library character.json by library_id, absolutizes paths, returns the full `Character`.
- **Interacts with**: `LibraryView.tsx` (Pharaoh-z21 detail panel).

### `save_library_character`
- **Does**: Direct library-side create/update. Accepts a full `Character`; allocates a new UUID if `library_id` is None; bumps `library_version` to now; relativizes paths before write; returns the saved record with paths re-absolutized.
- **Interacts with**: `LibraryView.tsx` save / new-character flows.
- **Rationale**: Lets the library editor mutate metadata (name, description, base voice description, palette directions) without going through a project. Audio-generating mutations remain project-scoped for now.

### `pull_character_from_library`
- **Does**: Replaces a project character's inline record + bundle with the canonical library version. Preserves the project-local `id` (script.csv references stay valid) and bumps `library_version` to the library's current value.
- **Interacts with**: `CharacterDesignerView.tsx` drift-banner "Pull library version" action.
- **Rationale**: Destructive (overwrites local edits); the UI confirms intent. Errors if the character has no `library_id` or the library entry has been deleted — surfaces the "detached" state explicitly rather than silently no-op'ing.

### `export_library_character` (Pharaoh-tlt4)
- **Does**: Packages a library character into a single `.pharaoh-character` zip file. Archive layout: `manifest.json` at root + `character/...` mirroring the bundle. The trained RVC model + index are always included; the raw `rvc_corpus/` is opt-in via `include_corpus` because it can add hundreds of MB.
- **Interacts with**: `LibraryView.tsx` Export… button, `zip` crate (same one `commands/archive.rs` uses).
- **Rationale**: Cross-machine portability. Workflow: clone voices on a high-storage machine, export, import on the laptop for episode production.

### `import_library_character_from_file` (Pharaoh-tlt4)
- **Does**: Reads a `.pharaoh-character` file, validates the format version against `EXPORT_FORMAT_VERSION`, allocates a fresh `library_id`, extracts every `character/*` entry into the new bundle dir, then stamps the new id + a current `library_version` into the imported `character.json`.
- **Interacts with**: `LibraryView.tsx` Import… button, `zip` crate.
- **Rationale**: Always forks (new `library_id`) — never replaces a local entry, so imports are always safe. Guards against zip-bomb path traversal (`..`, absolute paths, drive prefixes) before writing anything to disk.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `tauriCommands.ts` | Command names and arg shapes match (`list_library_characters`, `save_character_to_library`, `import_character_from_library`, `delete_library_character`) | Renaming commands or changing arg keys |
| `commands::project` | Imported characters get a fresh project-local `id`; `library_id` is preserved | Reusing the library_id as the project id |
| `app_support` | `relativize_voice_paths` / `absolutize_voice_paths` are the only path-rewriting seams | Adding path fields to `VoiceAssignment` without updating both functions |

## Notes
- The library directory name `_library` is deliberately underscore-prefixed so `list_projects` ignores it (it has no `project.json`).
- Bundle copy uses `copy_dir_recursive` which skips dotfiles — macOS `.DS_Store` won't pollute library entries.
- Library entries don't track which projects imported them. The drift indicator (Pharaoh-wpk) compares per-character `library_version` against the live library entry on demand instead of maintaining a reverse index.
