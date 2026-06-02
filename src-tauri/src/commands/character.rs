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

use std::io::{Read, Write};
use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_support::{
    absolutize_voice_paths, app_projects_dir, character_dir, copy_dir_recursive,
    library_character_dir, library_root_dir, lift_legacy_ref_sources, project_dir, read_json,
    relativize_voice_paths, write_json,
};
use crate::error::{Error, Result};
use crate::models::{Character, LibraryCharacterSummary, Project, CURRENT_CHARACTER_SCHEMA};

const LIBRARY_BUNDLE_FILE: &str = "character.json";
const EXPORT_MANIFEST_FILE: &str = "manifest.json";
const EXPORT_CHAR_PREFIX: &str = "character/";
const EXPORT_FORMAT_VERSION: u32 = 1;

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
    lift_legacy_ref_sources(&mut character.voice_assignment);
    character.schema_version = CURRENT_CHARACTER_SCHEMA;
    // Defensive: enforce id == library_id for library-stored characters so
    // legacy entries written before the save_library_character fix get
    // repaired on the next read. See save_library_character for context.
    character.id = library_id.clone();
    character.library_id = Some(library_id);
    Ok(character)
}

/// Pull the canonical library version into a project, replacing the existing
/// project character's bundle and inline record. The project-local character
/// `id` is preserved so script.csv rows that reference it keep resolving.
///
/// Destructive — overwrites any local edits to palette refs, RVC config,
/// description, etc. The caller (UI) is expected to confirm intent.
///
/// Pre-conditions:
/// - The project character must have `library_id` set (we only pull what we
///   originally imported from). Returns an error otherwise.
/// - The library entry must still exist. Returns an error if the library_id
///   has been deleted from the library (the project character is "detached").
#[tauri::command]
pub fn pull_character_from_library(
    app: AppHandle,
    project_id: String,
    character_id: String,
) -> Result<Character> {
    let projects_dir = app_projects_dir(&app)?;
    let project_path = project_dir(&projects_dir, &project_id).join("project.json");
    let mut project: Project = read_json(&project_path)?;

    let original_idx = project
        .characters
        .iter()
        .position(|c| c.id == character_id)
        .ok_or_else(|| {
            Error::Other(format!(
                "character {} not found in project {}",
                character_id, project_id
            ))
        })?;

    let library_id = project.characters[original_idx]
        .library_id
        .clone()
        .ok_or_else(|| {
            Error::Other(format!(
                "character {} is not linked to a library entry — nothing to pull",
                character_id
            ))
        })?;

    let library_bundle = library_character_dir(&projects_dir, &library_id);
    let library_bundle_file = library_bundle.join(LIBRARY_BUNDLE_FILE);
    if !library_bundle_file.exists() {
        return Err(Error::Other(format!(
            "library entry {} no longer exists — character is detached",
            library_id
        )));
    }

    // Read fresh library character. Paths are relative to the library bundle.
    let mut fresh: Character = read_json(&library_bundle_file)?;

    // Wipe and re-copy the project bundle from the library.
    let project_bundle = character_dir(&projects_dir, &project_id, &character_id);
    if project_bundle.exists() {
        std::fs::remove_dir_all(&project_bundle)?;
    }
    std::fs::create_dir_all(&project_bundle)?;
    copy_dir_recursive(&library_bundle, &project_bundle)?;
    // Drop the library's character.json copy — project records live inline.
    let _ = std::fs::remove_file(project_bundle.join(LIBRARY_BUNDLE_FILE));

    // Preserve the project-local id; absolutize paths against the project bundle.
    fresh.id = character_id.clone();
    fresh.library_id = Some(library_id);
    // library_version remains whatever the library has — that's the version
    // we just synchronized to, which is the whole point.
    fresh.schema_version = CURRENT_CHARACTER_SCHEMA;
    absolutize_voice_paths(&mut fresh.voice_assignment, &project_bundle);

    project.characters[original_idx] = fresh.clone();
    project.updated_at = Utc::now();
    write_json(&project_path, &project)?;

    Ok(fresh)
}

// ── Clone-from-file: import external audio into a library bundle ────────────

#[derive(Debug, Serialize)]
pub struct ImportedAudioPath {
    /// Absolute path to the file as it now lives inside the library bundle.
    /// The UI uses this directly as `ref_audio_path` for voice/palette refs.
    pub absolute_path: String,
}

/// Copy an external audio file into a library character's bundle so the
/// character stays portable (paths inside the bundle are relative).
///
/// - `slot` selects the sub-directory and is constrained to a small whitelist
///   (`design`, `palette`, `imports`) to keep bundles tidy. Future slots
///   (e.g. `dialogue`) can be added here.
/// - `dest_name` is the final filename inside that slot. If empty, a
///   timestamped fallback is used. The original file extension is preserved
///   only when the source ends in one of the known audio extensions; otherwise
///   `.wav` is appended.
#[tauri::command]
pub fn import_audio_into_library_bundle(
    app: AppHandle,
    library_id: String,
    source_path: String,
    slot: String,
    dest_name: String,
) -> Result<ImportedAudioPath> {
    let projects_dir = app_projects_dir(&app)?;
    let bundle_dir = library_character_dir(&projects_dir, &library_id);
    if !bundle_dir.exists() {
        return Err(Error::Other(format!(
            "library character {} not found",
            library_id
        )));
    }

    let slot_clean = slot.trim();
    if !matches!(slot_clean, "design" | "palette" | "imports") {
        return Err(Error::Other(format!(
            "unsupported slot '{}' (allowed: design, palette, imports)",
            slot_clean
        )));
    }
    let slot_dir = bundle_dir.join(slot_clean);
    std::fs::create_dir_all(&slot_dir)?;

    let src = std::path::Path::new(&source_path);
    if !src.is_file() {
        return Err(Error::Other(format!(
            "source file does not exist: {}",
            source_path
        )));
    }

    // Resolve destination filename.
    let src_ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .filter(|s| matches!(s.as_str(), "wav" | "mp3" | "aac" | "ogg" | "flac" | "m4a"))
        .unwrap_or_else(|| "wav".to_string());
    let stem = dest_name.trim();
    let filename = if stem.is_empty() {
        format!("imported_{}.{}", Utc::now().timestamp(), src_ext)
    } else if std::path::Path::new(stem).extension().is_some() {
        // Caller supplied an extension already — use as-is.
        stem.to_string()
    } else {
        format!("{}.{}", stem, src_ext)
    };
    // Guard against `..` or path separators in the supplied name.
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(Error::Other(format!(
            "destination filename '{}' must be a single filename, not a path",
            filename
        )));
    }
    let dest = slot_dir.join(&filename);

    std::fs::copy(src, &dest)?;
    Ok(ImportedAudioPath {
        absolute_path: dest.to_string_lossy().into_owned(),
    })
}

/// Concatenate multiple external audio files into a single WAV inside the
/// library bundle. Use case: build a longer / more-varied reference clip from
/// several recordings of the same actor so Chatterbox's speaker embedding is
/// more stable.
///
/// The N=1 case is a fast-path file copy (equivalent to
/// [`import_audio_into_library_bundle`]). For N>=2 the files are concatenated
/// via ffmpeg's concat audio filter, which transparently resamples mismatched
/// inputs to 48kHz mono 16-bit PCM WAV.
///
/// A `<dest>.sources.json` sidecar is written next to the output listing the
/// original source filenames in order — provenance for "where did this come
/// from?" without needing the original files on disk.
#[tauri::command]
pub fn concat_audio_into_library_bundle(
    app: AppHandle,
    library_id: String,
    source_paths: Vec<String>,
    slot: String,
    dest_name: String,
) -> Result<ImportedAudioPath> {
    if source_paths.is_empty() {
        return Err(Error::Other("source_paths must not be empty".into()));
    }
    let projects_dir = app_projects_dir(&app)?;
    let bundle_dir = library_character_dir(&projects_dir, &library_id);
    if !bundle_dir.exists() {
        return Err(Error::Other(format!(
            "library character {} not found",
            library_id
        )));
    }

    let slot_clean = slot.trim();
    if !matches!(slot_clean, "design" | "palette" | "imports") {
        return Err(Error::Other(format!(
            "unsupported slot '{}' (allowed: design, palette, imports)",
            slot_clean
        )));
    }
    let slot_dir = bundle_dir.join(slot_clean);
    std::fs::create_dir_all(&slot_dir)?;

    // Validate every source up front so we don't half-process and fail late.
    for src in &source_paths {
        if !std::path::Path::new(src).is_file() {
            return Err(Error::Other(format!("source file not found: {}", src)));
        }
    }

    // Resolve destination filename. Concatenated output is always .wav.
    let stem_input = dest_name.trim();
    let dest_filename = if stem_input.is_empty() {
        format!("imported_{}.wav", Utc::now().timestamp())
    } else if std::path::Path::new(stem_input)
        .extension()
        .and_then(|e| e.to_str())
        == Some("wav")
    {
        stem_input.to_string()
    } else {
        // Strip any other extension and append .wav
        let stem_only = std::path::Path::new(stem_input)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(stem_input);
        format!("{}.wav", stem_only)
    };
    if dest_filename.contains('/') || dest_filename.contains('\\') || dest_filename.contains("..") {
        return Err(Error::Other(format!(
            "destination filename '{}' must be a single filename, not a path",
            dest_filename
        )));
    }
    let dest_path = slot_dir.join(&dest_filename);

    if source_paths.len() == 1 {
        // Fast path: single file, just copy (and normalize via ffmpeg so the
        // bundle always has a consistent format).
        let src = &source_paths[0];
        let src_ext = std::path::Path::new(src)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if src_ext == "wav" {
            std::fs::copy(src, &dest_path)?;
        } else {
            run_ffmpeg_for_concat(&[src.clone()], &dest_path)?;
        }
    } else {
        run_ffmpeg_for_concat(&source_paths, &dest_path)?;
    }

    // Provenance sidecar — survives even if the originals are deleted.
    let sidecar_name = format!("{}.sources.json", dest_filename);
    let sidecar_path = slot_dir.join(&sidecar_name);
    let provenance = serde_json::json!({
        "concatenated_from": source_paths,
        "concatenated_at": Utc::now().to_rfc3339(),
        "source_count": source_paths.len(),
    });
    let _ = std::fs::write(
        &sidecar_path,
        serde_json::to_vec_pretty(&provenance).unwrap_or_default(),
    );

    Ok(ImportedAudioPath {
        absolute_path: dest_path.to_string_lossy().into_owned(),
    })
}

/// Internal: run ffmpeg's concat audio filter and emit a normalized 48kHz mono
/// 16-bit PCM WAV. Used by [`concat_audio_into_library_bundle`].
fn run_ffmpeg_for_concat(source_paths: &[String], dest_path: &std::path::Path) -> Result<()> {
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into()];
    for src in source_paths {
        args.push("-i".into());
        args.push(src.clone());
    }
    // Build `[0:a][1:a]…concat=n=N:v=0:a=1[out]`
    let n = source_paths.len();
    let mut filter = String::new();
    for i in 0..n {
        filter.push_str(&format!("[{}:a]", i));
    }
    filter.push_str(&format!("concat=n={}:v=0:a=1[out]", n));
    args.push("-filter_complex".into());
    args.push(filter);
    args.push("-map".into());
    args.push("[out]".into());
    args.push("-ar".into());
    args.push("48000".into());
    args.push("-ac".into());
    args.push("1".into());
    args.push("-sample_fmt".into());
    args.push("s16".into());
    args.push(dest_path.to_string_lossy().into_owned());

    let out = std::process::Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| Error::Other(format!("ffmpeg not found (install ffmpeg): {}", e)))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Other(format!(
            "ffmpeg concat failed:\n{}",
            &stderr[..stderr.len().min(1000)]
        )));
    }
    Ok(())
}

// ── Bulk import into RVC corpus (Pharaoh-mo0q) ──────────────────────────────

#[derive(Debug, Serialize)]
pub struct CorpusImportResult {
    pub copied_count: u64,
    pub skipped_count: u64,
    pub total_duration_ms: u64,
    pub corpus_dir: String,
}

/// Bulk-import real audio recordings into a library character's
/// `rvc_corpus/` directory. The synthesized-from-Chatterbox corpus build is
/// still available — this command just adds an orthogonal path for users who
/// already have hours of real audio of a voice actor and want to train RVC
/// on the actual recordings (substantially better quality than training on
/// Chatterbox output).
///
/// Each source file is normalized via ffmpeg to 48kHz mono 16-bit PCM WAV so
/// the RVC trainer sees a consistent format. Files that fail to convert are
/// skipped (counted, not fatal) so a single bad clip doesn't poison the batch.
#[tauri::command]
pub fn import_audio_files_into_corpus(
    app: AppHandle,
    library_id: String,
    source_paths: Vec<String>,
) -> Result<CorpusImportResult> {
    let projects_dir = app_projects_dir(&app)?;
    let bundle_dir = library_character_dir(&projects_dir, &library_id);
    if !bundle_dir.exists() {
        return Err(Error::Other(format!(
            "library character {} not found",
            library_id
        )));
    }
    let corpus_dir = bundle_dir.join("rvc_corpus");
    std::fs::create_dir_all(&corpus_dir)?;

    let mut copied: u64 = 0;
    let mut skipped: u64 = 0;
    let mut total_duration_ms: u64 = 0;
    let base_ts = Utc::now().timestamp();

    for (i, src) in source_paths.iter().enumerate() {
        let src_path = std::path::Path::new(src);
        if !src_path.is_file() {
            skipped += 1;
            continue;
        }
        let stem = src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("clip")
            .chars()
            .filter(|c| c.is_alphanumeric() || matches!(c, '_' | '-'))
            .take(40)
            .collect::<String>();
        let dest_name = format!("import_{}_{:03}_{}.wav", base_ts, i, stem);
        let dest = corpus_dir.join(&dest_name);

        // Single-input ffmpeg normalize. Cheap to retry per file because
        // most are tiny relative to the cost of the failure path.
        let args = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-i".into(),
            src.clone(),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "1".into(),
            "-sample_fmt".into(),
            "s16".into(),
            dest.to_string_lossy().into_owned(),
        ];
        let result = std::process::Command::new("ffmpeg")
            .args(&args)
            .output();
        let ok = matches!(&result, Ok(o) if o.status.success());
        if !ok {
            skipped += 1;
            continue;
        }
        copied += 1;

        // Write a `.meta.json` sidecar with duration so existing
        // scan_rvc_corpus_dir picks it up without re-decoding the WAV.
        if let Ok(reader) = hound::WavReader::open(&dest) {
            let spec = reader.spec();
            let samples = reader.duration() as u64;
            let channels = u64::from(spec.channels.max(1));
            if let Some(dur_ms) = samples
                .checked_mul(1000)
                .and_then(|v| v.checked_div(channels))
                .and_then(|v| v.checked_div(u64::from(spec.sample_rate)))
            {
                total_duration_ms = total_duration_ms.saturating_add(dur_ms);
                let meta_path = corpus_dir.join(format!("{}.meta.json", dest_name));
                let meta = serde_json::json!({
                    "duration_ms": dur_ms,
                    "source_path": src,
                    "imported_at": Utc::now().to_rfc3339(),
                });
                let _ = std::fs::write(
                    &meta_path,
                    serde_json::to_vec_pretty(&meta).unwrap_or_default(),
                );
            }
        }
    }

    Ok(CorpusImportResult {
        copied_count: copied,
        skipped_count: skipped,
        total_duration_ms,
        corpus_dir: corpus_dir.to_string_lossy().into_owned(),
    })
}

// ── Cross-machine export/import ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct ExportManifest {
    pharaoh_character_export_version: u32,
    exported_at: String,
    original_library_id: String,
    name: String,
    description: String,
    schema_version: u32,
    includes_corpus: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub output_path: String,
    pub bytes: u64,
    pub file_count: u64,
}

/// Package a library character into a single `.pharaoh-character` file (zip).
///
/// The archive contains:
/// - `manifest.json` (format version, original library_id, content flags)
/// - `character/character.json` (the canonical record, paths still relative)
/// - `character/palette/*.wav`, `character/design/*.wav`
/// - `character/rvc/*.pth`, `character/rvc/*.index`
/// - `character/rvc_corpus/*.wav` (only when `include_corpus = true`)
///
/// Use case: train a voice on a high-storage machine, export, import on a
/// laptop for episode production. The corpus is excluded by default since
/// it's only useful for retraining and adds hundreds of MB to file size.
#[tauri::command]
pub fn export_library_character(
    app: AppHandle,
    library_id: String,
    output_path: String,
    include_corpus: bool,
) -> Result<ExportResult> {
    let projects_dir = app_projects_dir(&app)?;
    let bundle_dir = library_character_dir(&projects_dir, &library_id);
    let bundle_file = bundle_dir.join(LIBRARY_BUNDLE_FILE);
    if !bundle_file.exists() {
        return Err(Error::Other(format!(
            "library character {} not found",
            library_id
        )));
    }

    // Read the character so we can stamp metadata into the manifest cheaply.
    let character: Character = read_json(&bundle_file)?;

    let output = Path::new(&output_path);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(output)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(6));

    let manifest = ExportManifest {
        pharaoh_character_export_version: EXPORT_FORMAT_VERSION,
        exported_at: Utc::now().to_rfc3339(),
        original_library_id: library_id.clone(),
        name: character.name.clone(),
        description: character.description.clone(),
        schema_version: character.schema_version,
        includes_corpus: include_corpus,
    };
    zip.start_file(EXPORT_MANIFEST_FILE, opts)
        .map_err(|e| Error::Other(format!("zip start manifest: {}", e)))?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    zip.write_all(&manifest_bytes)?;

    let mut bytes_written: u64 = manifest_bytes.len() as u64;
    let mut file_count: u64 = 1;

    // Walk the bundle dir and stream files into the archive under `character/`.
    let mut stack: Vec<std::path::PathBuf> = vec![bundle_dir.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let ty = entry.file_type()?;
            if ty.is_dir() {
                // Skip corpus dir when not requested.
                if !include_corpus
                    && path.file_name().and_then(|n| n.to_str()) == Some("rvc_corpus")
                {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !ty.is_file() {
                continue;
            }
            // Skip macOS / metadata noise.
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }

            let rel = match path.strip_prefix(&bundle_dir) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            let archive_name = format!(
                "{}{}",
                EXPORT_CHAR_PREFIX,
                rel.to_string_lossy().replace('\\', "/")
            );

            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            zip.start_file(&archive_name, opts)
                .map_err(|e| Error::Other(format!("zip start file: {}", e)))?;
            zip.write_all(&bytes)?;
            bytes_written += bytes.len() as u64;
            file_count += 1;
        }
    }

    zip.finish()
        .map_err(|e| Error::Other(format!("zip finish: {}", e)))?;

    Ok(ExportResult {
        output_path: output.to_string_lossy().into_owned(),
        bytes: bytes_written,
        file_count,
    })
}

/// Import a `.pharaoh-character` file into the local library.
///
/// Always allocates a fresh `library_id` (no collisions with existing local
/// entries). The original `library_id` from the source machine is recorded in
/// the manifest for traceability but not reused — treating import as a fork.
///
/// Returns a summary of the new library entry so the UI can scroll to it.
#[tauri::command]
pub fn import_library_character_from_file(
    app: AppHandle,
    file_path: String,
) -> Result<LibraryCharacterSummary> {
    let projects_dir = app_projects_dir(&app)?;
    let archive_file = std::fs::File::open(&file_path)?;
    let mut zip = zip::ZipArchive::new(archive_file)
        .map_err(|e| Error::Other(format!("zip open: {}", e)))?;

    // Read manifest first so we can fail fast on incompatible formats.
    {
        let mut manifest_entry = zip
            .by_name(EXPORT_MANIFEST_FILE)
            .map_err(|_| Error::Other("archive is missing manifest.json — not a .pharaoh-character file?".into()))?;
        let mut raw = String::new();
        manifest_entry.read_to_string(&mut raw)?;
        let manifest: ExportManifest = serde_json::from_str(&raw)
            .map_err(|e| Error::Other(format!("manifest parse: {}", e)))?;
        if manifest.pharaoh_character_export_version > EXPORT_FORMAT_VERSION {
            return Err(Error::Other(format!(
                "archive uses export format v{} but this build only understands v{}",
                manifest.pharaoh_character_export_version, EXPORT_FORMAT_VERSION
            )));
        }
    }

    // Allocate a fresh library_id and bundle dir.
    let new_library_id = Uuid::new_v4().to_string();
    let bundle = library_character_dir(&projects_dir, &new_library_id);
    std::fs::create_dir_all(&bundle)?;

    // Extract every entry under `character/` into the bundle dir.
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| Error::Other(format!("zip entry {}: {}", i, e)))?;
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix(EXPORT_CHAR_PREFIX) else {
            continue;
        };
        if rel.is_empty() || rel.ends_with('/') {
            continue;
        }
        // Guard against path-traversal in the archive (.. components, abs paths).
        let rel_path = std::path::Path::new(rel);
        if rel_path.components().any(|c| matches!(c,
            std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
        )) {
            return Err(Error::Other(format!(
                "archive contains unsafe path: {}",
                rel
            )));
        }
        let out_path = bundle.join(rel_path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out_file = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out_file)?;
    }

    // Stamp the new library_id into the imported character.json and refresh
    // the library_version so listings sort by import time on this machine.
    let bundle_file = bundle.join(LIBRARY_BUNDLE_FILE);
    let mut character: Character = read_json(&bundle_file)?;
    character.library_id = Some(new_library_id.clone());
    character.library_version = Some(Utc::now().to_rfc3339());
    character.schema_version = CURRENT_CHARACTER_SCHEMA;
    write_json(&bundle_file, &character)?;

    // Build the summary the same way list_library_characters does.
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
        .map(|p| bundle.join(p).exists() || std::path::Path::new(p).exists())
        .unwrap_or(false);

    Ok(LibraryCharacterSummary {
        library_id: new_library_id,
        name: character.name,
        description: character.description,
        palette_count,
        has_rvc_model,
        library_version: character.library_version.unwrap_or_default(),
    })
}

// ────────────────────────────────────────────────────────────────────────────

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
    // For library-stored characters, `id` and `library_id` must match: the
    // bundle directory name IS the id, so any backend command that resolves a
    // path from <projects_dir>/_library/characters/<character_id>/ (e.g.
    // CorpusBuilder, RvcModelStage) needs character.id == library_id.
    // Project-imported characters get their id reassigned to a fresh CHAR_XXXX
    // by import_character_from_library — this rule only applies to entries
    // living in the library.
    to_write.id = library_id.clone();
    to_write.library_id = Some(library_id.clone());
    to_write.library_version = Some(now);
    to_write.schema_version = CURRENT_CHARACTER_SCHEMA;
    relativize_voice_paths(&mut to_write.voice_assignment, &bundle);
    write_json(&bundle.join(LIBRARY_BUNDLE_FILE), &to_write)?;

    // Re-absolutize so the returned value is ready to use as-is.
    absolutize_voice_paths(&mut to_write.voice_assignment, &bundle);
    Ok(to_write)
}
