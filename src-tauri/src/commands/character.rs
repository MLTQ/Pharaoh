//! Character library commands.
//!
//! The library lives at `<projects_dir>/_library/characters/<library_id>/`
//! as a sibling to the per-project `<projects_dir>/<project_id>/` directories.
//! Each library entry is a self-contained bundle: `character.json` plus the
//! `palette/`, `rvc/`, `rvc_corpus/` subdirectories that the in-project
//! character bundle also uses.
//!
//! Sync model is fork-and-pull (see ARCHITECTURE / Pharaoh-d79): import copies
//! the bundle into a project, save copies a project's bundle to the library.
//! Each project character that came from the library carries `library_id` +
//! `library_version` so a future drift indicator (Pharaoh-wpk) can flag when
//! the project version has diverged from the canonical library entry.

use chrono::Utc;
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_support::{
    absolutize_voice_paths, app_projects_dir, character_dir, copy_dir_recursive,
    library_character_dir, library_root_dir, project_dir, read_json, relativize_voice_paths,
    write_json,
};
use crate::error::{Error, Result};
use crate::models::{Character, LibraryCharacterSummary, Project, CURRENT_CHARACTER_SCHEMA};

const LIBRARY_BUNDLE_FILE: &str = "character.json";

/// List every character in the library. Fast — only reads each character.json
/// and stats the rvc/ directory, never scans the corpus.
#[tauri::command]
pub fn list_library_characters(app: AppHandle) -> Result<Vec<LibraryCharacterSummary>> {
    let projects_dir = app_projects_dir(&app)?;
    let root = library_root_dir(&projects_dir);
    if !root.exists() {
        return Ok(vec![]);
    }

    let mut summaries = vec![];
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let bundle_dir = entry.path();
        let bundle_file = bundle_dir.join(LIBRARY_BUNDLE_FILE);
        if !bundle_file.exists() {
            continue;
        }
        let mut character: Character = match read_json(&bundle_file) {
            Ok(c) => c,
            Err(_) => continue, // skip corrupt entries silently — library list should never fail
        };
        // Library bundles store relative paths; absolutize so callers see the
        // right thing if they reuse the returned Character later. Note: list
        // returns summaries, not full Characters, so this is defensive for the
        // future when we might switch to returning full records.
        absolutize_voice_paths(&mut character.voice_assignment, &bundle_dir);

        let palette_count = character
            .voice_assignment
            .emotional_palette
            .iter()
            .filter(|e| e.qa_status == "approved" && e.ref_audio_path.is_some())
            .count() as u32;

        let has_rvc_model = character
            .voice_assignment
            .rvc
            .as_ref()
            .and_then(|r| r.model_path.as_deref())
            .map(|p| std::path::Path::new(p).exists())
            .unwrap_or(false);

        summaries.push(LibraryCharacterSummary {
            library_id: character.library_id.clone().unwrap_or_else(|| {
                // Fall back to dir name if library_id field somehow missing —
                // makes the list resilient against partially-written entries.
                bundle_dir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string()
            }),
            name: character.name,
            description: character.description,
            palette_count,
            has_rvc_model,
            library_version: character
                .library_version
                .unwrap_or_else(|| Utc::now().to_rfc3339()),
        });
    }
    summaries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(summaries)
}

/// Push a project's character to the library. Creates a new library entry if
/// the character has no `library_id` yet, otherwise updates the existing one.
///
/// Side effects:
/// - Copies the project bundle (palette/, rvc/, rvc_corpus/) into the library.
/// - Writes `character.json` into the library bundle with all paths relativized.
/// - Updates the project's character with the (possibly new) `library_id` and
///   the fresh `library_version` timestamp, then re-saves project.json.
#[tauri::command]
pub fn save_character_to_library(
    app: AppHandle,
    project_id: String,
    character_id: String,
) -> Result<LibraryCharacterSummary> {
    let projects_dir = app_projects_dir(&app)?;
    let project_path = project_dir(&projects_dir, &project_id).join("project.json");
    let mut project: Project = read_json(&project_path)?;

    let now = Utc::now().to_rfc3339();
    let project_bundle = character_dir(&projects_dir, &project_id, &character_id);

    // Locate and clone the character so we can rewrite paths without disturbing
    // the in-memory project version until we know the copy succeeded.
    let original_character = project
        .characters
        .iter()
        .find(|c| c.id == character_id)
        .ok_or_else(|| {
            Error::Other(format!(
                "character {} not found in project {}",
                character_id, project_id
            ))
        })?
        .clone();

    let library_id = original_character
        .library_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let library_bundle = library_character_dir(&projects_dir, &library_id);

    // Copy bundle contents (best effort if some subdirs don't exist yet).
    std::fs::create_dir_all(&library_bundle)?;
    if project_bundle.exists() {
        copy_dir_recursive(&project_bundle, &library_bundle)?;
    }

    // Build the library-bound Character: same data, library_id stamped,
    // version set to now, paths relativized against the LIBRARY bundle dir.
    let mut library_character = original_character.clone();
    library_character.library_id = Some(library_id.clone());
    library_character.library_version = Some(now.clone());
    library_character.schema_version = CURRENT_CHARACTER_SCHEMA;
    relativize_voice_paths(&mut library_character.voice_assignment, &library_bundle);
    // Defensive: if any path was *already* relative (pointing into the project
    // bundle), it's now relative against the library bundle, which is correct
    // because we copied the same file layout over.
    write_json(&library_bundle.join(LIBRARY_BUNDLE_FILE), &library_character)?;

    // Update the project's character record with the link metadata.
    for character in project.characters.iter_mut() {
        if character.id == character_id {
            character.library_id = Some(library_id.clone());
            character.library_version = Some(now.clone());
            character.schema_version = CURRENT_CHARACTER_SCHEMA;
            break;
        }
    }
    project.updated_at = Utc::now();
    write_json(&project_path, &project)?;

    let palette_count = library_character
        .voice_assignment
        .emotional_palette
        .iter()
        .filter(|e| e.qa_status == "approved" && e.ref_audio_path.is_some())
        .count() as u32;
    let has_rvc_model = library_character
        .voice_assignment
        .rvc
        .as_ref()
        .and_then(|r| r.model_path.as_deref())
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false);

    Ok(LibraryCharacterSummary {
        library_id,
        name: library_character.name,
        description: library_character.description,
        palette_count,
        has_rvc_model,
        library_version: now,
    })
}

/// Import a library character into a project. Always a copy — the project
/// character gets a fresh project-local `id` but retains `library_id` +
/// `library_version` so future drift checks know its origin.
///
/// If `new_name` is supplied (non-empty), the imported character's `name`
/// is set to it; otherwise the library's name is reused. Useful for "Alex
/// (Younger)" style variants in a single project.
#[tauri::command]
pub fn import_character_from_library(
    app: AppHandle,
    project_id: String,
    library_id: String,
    new_name: Option<String>,
) -> Result<Character> {
    let projects_dir = app_projects_dir(&app)?;
    let library_bundle = library_character_dir(&projects_dir, &library_id);
    let library_bundle_file = library_bundle.join(LIBRARY_BUNDLE_FILE);
    if !library_bundle_file.exists() {
        return Err(Error::Other(format!(
            "library character {} not found",
            library_id
        )));
    }

    let project_path = project_dir(&projects_dir, &project_id).join("project.json");
    let mut project: Project = read_json(&project_path)?;

    // Read library character. Paths inside are relative to the library bundle.
    let mut character: Character = read_json(&library_bundle_file)?;

    // Generate a fresh project-local id (matches the CHAR_XXXX convention used
    // elsewhere in the codebase).
    let short = Uuid::new_v4().simple().to_string();
    let new_id = format!("CHAR_{}", short[..6].to_ascii_uppercase());
    character.id = new_id.clone();
    if let Some(name) = new_name.and_then(|n| {
        let t = n.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }) {
        character.name = name;
    }
    character.library_id = Some(library_id.clone());
    // library_version stays as whatever the library entry had — that's the
    // version we imported from.

    // Copy bundle contents into the project's characters dir.
    let project_bundle = character_dir(&projects_dir, &project_id, &new_id);
    std::fs::create_dir_all(&project_bundle)?;
    copy_dir_recursive(&library_bundle, &project_bundle)?;
    // Remove the copy of character.json — in-project characters live inline
    // in project.json, not as a sibling bundle file. Keeping a stale copy
    // here would be confusing.
    let _ = std::fs::remove_file(project_bundle.join(LIBRARY_BUNDLE_FILE));

    // Rewrite all in-bundle paths from "relative to library bundle" to
    // "absolute pointing at project bundle" so the rest of the codebase
    // (TTS submission, MCP, etc.) keeps working unchanged.
    absolutize_voice_paths(&mut character.voice_assignment, &project_bundle);

    character.schema_version = CURRENT_CHARACTER_SCHEMA;

    project.characters.push(character.clone());
    project.updated_at = Utc::now();
    write_json(&project_path, &project)?;

    Ok(character)
}

/// Delete a library character entry. Does NOT touch any project character that
/// imported from this entry; those become "detached" (library_id still set,
/// but pull/push will report the library entry as missing). Future drift UI
/// (Pharaoh-wpk) handles surfacing that state.
#[tauri::command]
pub fn delete_library_character(app: AppHandle, library_id: String) -> Result<()> {
    let projects_dir = app_projects_dir(&app)?;
    let bundle = library_character_dir(&projects_dir, &library_id);
    if !bundle.exists() {
        return Ok(()); // idempotent
    }
    std::fs::remove_dir_all(&bundle)?;
    Ok(())
}

/// Read a full library character by id. Paths are absolutized so the result is
/// usable directly (audio playback, take previews, etc.) without further work
/// on the caller side.
#[tauri::command]
pub fn get_library_character(app: AppHandle, library_id: String) -> Result<Character> {
    let projects_dir = app_projects_dir(&app)?;
    let bundle = library_character_dir(&projects_dir, &library_id);
    let bundle_file = bundle.join(LIBRARY_BUNDLE_FILE);
    if !bundle_file.exists() {
        return Err(Error::Other(format!(
            "library character {} not found",
            library_id
        )));
    }
    let mut character: Character = read_json(&bundle_file)?;
    absolutize_voice_paths(&mut character.voice_assignment, &bundle);
    character.schema_version = CURRENT_CHARACTER_SCHEMA;
    Ok(character)
}

/// Create or update a library character directly (no project context).
/// - If `character.library_id` is None, allocates a new UUID and bundle dir.
/// - If set, overwrites the existing library entry in place.
/// - Always bumps `library_version` to now.
/// - Paths inside the character are relativized against the library bundle
///   dir before write; the returned Character has them absolutized again so
///   the caller can keep using it.
///
/// Used by the Character Library route (Pharaoh-z21) for metadata edits and
/// for creating empty library characters from scratch.
#[tauri::command]
pub fn save_library_character(app: AppHandle, character: Character) -> Result<Character> {
    let projects_dir = app_projects_dir(&app)?;
    let now = Utc::now().to_rfc3339();

    let library_id = character
        .library_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let bundle = library_character_dir(&projects_dir, &library_id);
    std::fs::create_dir_all(&bundle)?;

    let mut to_write = character;
    to_write.library_id = Some(library_id.clone());
    to_write.library_version = Some(now);
    to_write.schema_version = CURRENT_CHARACTER_SCHEMA;
    relativize_voice_paths(&mut to_write.voice_assignment, &bundle);
    write_json(&bundle.join(LIBRARY_BUNDLE_FILE), &to_write)?;

    // Re-absolutize so the returned value is ready to use as-is.
    absolutize_voice_paths(&mut to_write.voice_assignment, &bundle);
    Ok(to_write)
}
