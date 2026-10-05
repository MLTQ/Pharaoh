//! Cast housekeeping: merge characters, match unnamed voices to named ones,
//! and move characters between projects as a pack.
//!
//! **Merge** moves every line of one or more characters onto another — the
//! script rows (`character` and the dialogue `track`), the Fountain cues and
//! each scene's cast list — then removes the merged characters from the
//! project. Their bundle folders stay on disk; nothing audio is deleted.
//!
//! **Matches** pair a rebuild's "Speaker N" with the named character made
//! from the same dissected speaker (same import, same speaker id in
//! `voice_provenance`) — what happens when voices are named in the dissect
//! review after (or apart from) the rebuild.
//!
//! **Packs** (`.pharaoh-cast`) carry several characters' bundles — voice
//! references, palette, voice-lock model — so they can be imported into
//! another project. Paths inside are relative to each bundle.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_support::{
    absolutize_voice_paths, app_projects_dir, character_dir, library_character_dir, project_dir, read_json,
    read_script_rows, relativize_voice_paths, scene_dir, write_json, write_script_rows,
};
use crate::error::{Error, Result};
use crate::models::{Character, Project, Storyboard};

// ── Matches ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastMatch {
    pub from_id: String,
    pub from_name: String,
    pub into_id: String,
    pub into_name: String,
    pub speaker_id: String,
    /// Dialogue rows the unnamed character has.
    pub lines: usize,
}

/// A placeholder name a rebuild gives a voice nobody named.
pub fn is_placeholder_name(name: &str) -> bool {
    let n = name.trim();
    n.strip_prefix("Speaker ").is_some_and(|rest| rest.split_whitespace().next().is_some_and(|w| w.chars().all(|c| c.is_ascii_digit())))
        || n.strip_prefix('S').is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

fn speakers_of(c: &Character) -> Vec<(String, String)> {
    c.voice_provenance
        .iter()
        .filter(|p| p.kind == "dissect" && !p.speaker_id.is_empty())
        .map(|p| (p.import_id.clone(), p.speaker_id.clone()))
        .collect()
}

fn dialogue_counts(projects_dir: &Path, project_id: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    let storyboard: Storyboard = match read_json(&project_dir(projects_dir, project_id).join("storyboard.json")) {
        Ok(s) => s,
        Err(_) => return counts,
    };
    for scene in &storyboard.scenes {
        if let Ok(rows) = read_script_rows(&scene_dir(projects_dir, project_id, &scene.slug).join("script.csv")) {
            for r in rows.iter().filter(|r| r.track_type == "DIALOGUE") {
                *counts.entry(r.character.clone()).or_insert(0) += 1;
            }
        }
    }
    counts
}

pub fn cast_matches_in(projects_dir: &Path, project_id: &str) -> Result<Vec<CastMatch>> {
    let project: Project = read_json(&project_dir(projects_dir, project_id).join("project.json"))?;
    let counts = dialogue_counts(projects_dir, project_id);
    let mut named: HashMap<(String, String), &Character> = HashMap::new();
    for c in project.characters.iter().filter(|c| !is_placeholder_name(&c.name)) {
        // The Library entry may know more of its speakers than the project
        // copy (two dissected speakers named as one character).
        let mut keys = speakers_of(c);
        if let Some(lib) = &c.library_id {
            if let Ok(l) = read_json::<Character>(&library_character_dir(projects_dir, lib).join("character.json")) {
                keys.extend(speakers_of(&l));
            }
        }
        for key in keys {
            named.entry(key).or_insert(c);
        }
    }
    let mut out = Vec::new();
    for c in project.characters.iter().filter(|c| is_placeholder_name(&c.name)) {
        if let Some((key, into)) = speakers_of(c).into_iter().find_map(|k| named.get(&k).map(|n| (k.clone(), *n))) {
            if into.id != c.id {
                out.push(CastMatch {
                    from_id: c.id.clone(),
                    from_name: c.name.clone(),
                    into_id: into.id.clone(),
                    into_name: into.name.clone(),
                    speaker_id: key.1,
                    lines: counts.get(&c.id).copied().unwrap_or(0),
                });
            }
        }
    }
    Ok(out)
}

// ── Merge ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeReport {
    pub rows_moved: usize,
    pub scenes_touched: usize,
    pub merged: Vec<String>,
}

/// Rename a cue line from one character to another, keeping what follows
/// the name (an extension, a `[[id:…]]` note). None when it isn't their cue.
fn rename_cue(line: &str, from: &[String], into: &str) -> Option<String> {
    let indent = &line[..line.len() - line.trim_start().len()];
    let t = line.trim_start();
    for name in from {
        let up = name.trim().to_uppercase();
        if up.is_empty() || !t.starts_with(&up) {
            continue;
        }
        let rest = &t[up.len()..];
        // "SPEAKER 1" must not claim "SPEAKER 15".
        if rest.is_empty() || rest.starts_with(char::is_whitespace) || rest.starts_with('(') || rest.starts_with('[') {
            return Some(format!("{}{}{}", indent, into.trim().to_uppercase(), rest));
        }
    }
    None
}

pub fn merge_characters_in(projects_dir: &Path, project_id: &str, from_ids: &[String], into_id: &str) -> Result<MergeReport> {
    let project_path = project_dir(projects_dir, project_id).join("project.json");
    let mut project: Project = read_json(&project_path)?;
    let into = project.characters.iter().find(|c| c.id == into_id).cloned()
        .ok_or_else(|| Error::Other(format!("no character {} to merge into", into_id)))?;
    let from: Vec<Character> = project.characters.iter().filter(|c| from_ids.contains(&c.id) && c.id != into_id).cloned().collect();
    if from.is_empty() {
        return Err(Error::Other("nothing to merge".into()));
    }
    let from_ids: HashSet<String> = from.iter().map(|c| c.id.clone()).collect();
    let from_tracks: HashSet<String> = from_ids.iter().map(|i| i.to_lowercase()).collect();
    // Longest names first, so "Speaker 12" is tried before "Speaker 1".
    let mut from_names: Vec<String> = from.iter().map(|c| c.name.clone()).collect();
    from_names.sort_by_key(|n| std::cmp::Reverse(n.len()));

    let storyboard_path = project_dir(projects_dir, project_id).join("storyboard.json");
    let mut storyboard: Storyboard = read_json(&storyboard_path)?;
    let mut report = MergeReport { rows_moved: 0, scenes_touched: 0, merged: from.iter().map(|c| c.name.clone()).collect() };
    for scene in storyboard.scenes.iter_mut() {
        let dir = scene_dir(projects_dir, project_id, &scene.slug);
        let mut touched = false;
        let csv = dir.join("script.csv");
        if let Ok(mut rows) = read_script_rows(&csv) {
            let mut moved = 0;
            for r in rows.iter_mut() {
                if from_ids.contains(&r.character) {
                    r.character = into.id.clone();
                    moved += 1;
                }
                if from_tracks.contains(&r.track.to_lowercase()) {
                    r.track = into.id.to_lowercase();
                }
            }
            if moved > 0 {
                write_script_rows(&csv, &rows)?;
                report.rows_moved += moved;
                touched = true;
            }
        }
        let fountain = dir.join("script.fountain");
        if let Ok(text) = std::fs::read_to_string(&fountain) {
            let mut changed = false;
            let lines: Vec<String> = text
                .split('\n')
                .map(|l| match rename_cue(l, &from_names, &into.name) {
                    Some(n) => { changed = true; n }
                    None => l.to_string(),
                })
                .collect();
            if changed {
                std::fs::write(&fountain, lines.join("\n"))?;
                touched = true;
            }
        }
        // The scene's cast list holds names or ids.
        let before = scene.characters.clone();
        let mut cast: Vec<String> = Vec::new();
        for c in &scene.characters {
            let is_from = from_ids.contains(c) || from.iter().any(|f| &f.name == c);
            let entry = if is_from { into.name.clone() } else { c.clone() };
            let dup = cast.iter().any(|x| x == &entry || (x == &into.id && entry == into.name) || (x == &into.name && entry == into.id));
            if !dup {
                cast.push(entry);
            }
        }
        if cast != before {
            scene.characters = cast;
            touched = true;
        }
        if touched {
            report.scenes_touched += 1;
        }
    }
    write_json(&storyboard_path, &storyboard)?;
    project.characters.retain(|c| !from_ids.contains(&c.id));
    project.updated_at = Utc::now();
    write_json(&project_path, &project)?;
    Ok(report)
}

/// Pairs of an unnamed rebuild voice ("Speaker 9") and the named character
/// from the same dissected speaker.
#[tauri::command]
pub fn cast_matches(app: AppHandle, project_id: String) -> Result<Vec<CastMatch>> {
    cast_matches_in(&app_projects_dir(&app)?, &project_id)
}

/// Move every line of `from_ids` onto `into_id` and drop the merged characters.
#[tauri::command]
pub fn merge_characters(app: AppHandle, project_id: String, from_ids: Vec<String>, into_id: String) -> Result<MergeReport> {
    merge_characters_in(&app_projects_dir(&app)?, &project_id, &from_ids, &into_id)
}

// ── Packs ───────────────────────────────────────────────────────────────────

const PACK_FILE: &str = "cast.json";
const PACK_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PackManifest {
    pharaoh_cast_pack_version: u32,
    exported_at: String,
    source_project: String,
    characters: Vec<PackEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PackEntry {
    folder: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackSummary {
    pub characters: Vec<String>,
    pub bytes: u64,
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(PathBuf, String)>, skip_corpus: bool) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for e in entries.flatten() {
        let p = e.path();
        let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        if p.is_dir() {
            if skip_corpus && rel == "rvc_corpus" {
                continue;
            }
            walk(&p, base, out, skip_corpus)?;
        } else {
            out.push((p, rel));
        }
    }
    Ok(())
}

pub fn export_cast_pack_to(projects_dir: &Path, project_id: &str, ids: &[String], output: &Path, include_corpus: bool) -> Result<PackSummary> {
    let project: Project = read_json(&project_dir(projects_dir, project_id).join("project.json"))?;
    let chosen: Vec<&Character> = ids.iter().filter_map(|id| project.characters.iter().find(|c| &c.id == id)).collect();
    if chosen.is_empty() {
        return Err(Error::Other("choose at least one character".into()));
    }
    let part = output.with_extension("part");
    let file = std::fs::File::create(&part)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    // Audio is already compressed or lossless-packed; storing it is faster and no bigger.
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
    let mut manifest = PackManifest { pharaoh_cast_pack_version: PACK_VERSION, exported_at: Utc::now().to_rfc3339(), source_project: project.title.clone(), characters: vec![] };
    for (k, c) in chosen.iter().enumerate() {
        let folder = format!("c{:02}", k + 1);
        let bundle = character_dir(projects_dir, project_id, &c.id);
        let mut ch = (*c).clone();
        relativize_voice_paths(&mut ch.voice_assignment, &bundle);
        zip.start_file(format!("{folder}/character.json"), opts).map_err(|e| Error::Other(format!("zip: {e}")))?;
        zip.write_all(&serde_json::to_vec_pretty(&ch)?)?;
        let mut files = Vec::new();
        walk(&bundle, &bundle, &mut files, !include_corpus)?;
        for (path, rel) in files {
            if rel == "character.json" {
                continue;
            }
            let audio = matches!(path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("wav" | "flac" | "mp3" | "m4a" | "ogg"));
            zip.start_file(format!("{folder}/{rel}"), if audio { stored } else { opts }).map_err(|e| Error::Other(format!("zip: {e}")))?;
            std::io::copy(&mut std::fs::File::open(&path)?, &mut zip)?;
        }
        manifest.characters.push(PackEntry { folder, name: c.name.clone() });
    }
    zip.start_file(PACK_FILE, opts).map_err(|e| Error::Other(format!("zip: {e}")))?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
    zip.finish().map_err(|e| Error::Other(format!("zip finish: {e}")))?;
    std::fs::rename(&part, output)?;
    Ok(PackSummary { characters: manifest.characters.into_iter().map(|e| e.name).collect(), bytes: std::fs::metadata(output)?.len() })
}

pub fn import_cast_pack_into(projects_dir: &Path, project_id: &str, pack: &Path) -> Result<Vec<Character>> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(pack)?).map_err(|e| Error::Other(format!("not a cast pack: {e}")))?;
    let manifest: PackManifest = {
        let mut raw = String::new();
        zip.by_name(PACK_FILE).map_err(|_| Error::Other("not a .pharaoh-cast pack (no cast.json)".into()))?.read_to_string(&mut raw)?;
        serde_json::from_str(&raw)?
    };
    if manifest.pharaoh_cast_pack_version > PACK_VERSION {
        return Err(Error::Other(format!("this pack is from a newer Pharaoh (format {})", manifest.pharaoh_cast_pack_version)));
    }
    let project_path = project_dir(projects_dir, project_id).join("project.json");
    let mut project: Project = read_json(&project_path)?;
    let mut taken: HashSet<String> = project.characters.iter().map(|c| c.name.to_lowercase()).collect();
    let mut added = Vec::new();
    for entry in &manifest.characters {
        let id = format!("CHAR_{}", Uuid::new_v4().simple().to_string()[..6].to_ascii_uppercase());
        let bundle = character_dir(projects_dir, project_id, &id);
        std::fs::create_dir_all(&bundle)?;
        let prefix = format!("{}/", entry.folder);
        let mut character: Option<Character> = None;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| Error::Other(format!("zip: {e}")))?;
            let Some(name) = f.enclosed_name() else { continue };
            let name = name.to_string_lossy().replace('\\', "/");
            let Some(rel) = name.strip_prefix(&prefix) else { continue };
            if f.is_dir() || rel.is_empty() {
                continue;
            }
            if rel == "character.json" {
                let mut raw = String::new();
                f.read_to_string(&mut raw)?;
                character = Some(serde_json::from_str(&raw)?);
                continue;
            }
            let dest = bundle.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::io::copy(&mut f, &mut std::fs::File::create(&dest)?)?;
        }
        let mut c = character.ok_or_else(|| Error::Other(format!("pack entry {} has no character.json", entry.folder)))?;
        c.id = id;
        absolutize_voice_paths(&mut c.voice_assignment, &bundle);
        // Keep the library link only where that library entry exists here.
        if let Some(lib) = c.library_id.clone() {
            if !library_character_dir(projects_dir, &lib).join("character.json").exists() {
                c.library_id = None;
                c.library_version = None;
            }
        }
        let base = c.name.clone();
        let mut k = 2;
        while !taken.insert(c.name.to_lowercase()) {
            c.name = format!("{} ({})", base, k);
            k += 1;
        }
        project.characters.push(c.clone());
        added.push(c);
    }
    project.updated_at = Utc::now();
    write_json(&project_path, &project)?;
    Ok(added)
}

/// Write the chosen characters to a `.pharaoh-cast` pack.
#[tauri::command]
pub fn export_cast_pack(app: AppHandle, project_id: String, character_ids: Vec<String>, output_path: String, include_corpus: Option<bool>) -> Result<PackSummary> {
    export_cast_pack_to(&app_projects_dir(&app)?, &project_id, &character_ids, Path::new(&output_path), include_corpus.unwrap_or(false))
}

/// Add a pack's characters to a project (names that clash get "(2)").
#[tauri::command]
pub fn import_cast_pack(app: AppHandle, project_id: String, file_path: String) -> Result<Vec<Character>> {
    import_cast_pack_into(&app_projects_dir(&app)?, &project_id, Path::new(&file_path))
}

/// One file's worth of an import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedCharacter {
    pub id: String,
    pub name: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportFailure {
    pub file: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastImportReport {
    pub added: Vec<ImportedCharacter>,
    pub failed: Vec<ImportFailure>,
}

/// Whether a zip is a cast pack (cast.json) rather than a single character.
fn is_cast_pack(path: &Path) -> bool {
    std::fs::File::open(path)
        .ok()
        .and_then(|f| zip::ZipArchive::new(f).ok())
        .is_some_and(|mut z| z.by_name(PACK_FILE).is_ok())
}

/// Import any mix of `.pharaoh-cast` packs and single `.pharaoh-character`
/// files into a project. A single character is linked to its Library entry —
/// the one it was exported from when that's on this machine, otherwise a new
/// Library entry made from the file. One bad file doesn't
/// stop the rest; it's reported in `failed`.
pub fn import_cast_files_into(projects_dir: &Path, project_id: &str, files: &[String]) -> CastImportReport {
    let mut report = CastImportReport { added: vec![], failed: vec![] };
    for file in files {
        let path = Path::new(file);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file.clone());
        let result: Result<Vec<Character>> = if is_cast_pack(path) {
            import_cast_pack_into(projects_dir, project_id, path)
        } else {
            (|| {
                use crate::commands::character as ch;
                // Exported from this machine's Library: link that entry rather
                // than forking a duplicate into the Library.
                let (library_id, name) = match ch::local_origin_of_character_file(projects_dir, file) {
                    Some(lib) => {
                        let c: Character = read_json(&library_character_dir(projects_dir, &lib).join("character.json"))?;
                        (lib, c.name)
                    }
                    None => {
                        let summary = ch::import_library_file(projects_dir, file.clone())?;
                        (summary.library_id, summary.name)
                    }
                };
                let project: Project = read_json(&project_dir(projects_dir, project_id).join("project.json"))?;
                let taken: HashSet<String> = project.characters.iter().map(|c| c.name.to_lowercase()).collect();
                let mut unique = name.clone();
                let mut k = 2;
                while taken.contains(&unique.to_lowercase()) {
                    unique = format!("{} ({})", name, k);
                    k += 1;
                }
                let new_name = (unique != name).then_some(unique);
                Ok(vec![ch::import_into_project(projects_dir, project_id, &library_id, new_name)?])
            })()
        };
        match result {
            Ok(chars) => report.added.extend(chars.into_iter().map(|c| ImportedCharacter { id: c.id, name: c.name, file: name.clone() })),
            Err(e) => report.failed.push(ImportFailure { file: name, error: e.to_string() }),
        }
    }
    report
}

/// Import several cast packs and/or character files at once.
#[tauri::command]
pub fn import_cast_files(app: AppHandle, project_id: String, file_paths: Vec<String>) -> Result<CastImportReport> {
    Ok(import_cast_files_into(&app_projects_dir(&app)?, &project_id, &file_paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_names() {
        assert!(is_placeholder_name("Speaker 9"));
        assert!(is_placeholder_name("Speaker 12 2"));
        assert!(is_placeholder_name("S15"));
        assert!(!is_placeholder_name("Speaker Fudge"));
        assert!(!is_placeholder_name("Percey Weasley (GOF)"));
    }

    #[test]
    fn cue_renames_respect_word_boundaries() {
        let from = vec!["Speaker 15".to_string(), "Speaker 1".to_string()];
        assert_eq!(rename_cue("SPEAKER 15 [[id:r-1]]", &from, "Percey Weasley (GOF)").as_deref(), Some("PERCEY WEASLEY (GOF) [[id:r-1]]"));
        assert_eq!(rename_cue("SPEAKER 1", &from, "Narrator").as_deref(), Some("NARRATOR"));
        assert_eq!(rename_cue("SPEAKER 16 [[id:r-2]]", &["Speaker 1".to_string()], "Narrator"), None);
        assert_eq!(rename_cue("Speaker 1 said nothing.", &from, "Narrator"), None, "action lines aren't cues");
    }
}
