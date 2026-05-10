// Project archive: bundle a project into a self-contained zip so it can be
// shipped, shared, or stashed. Phase-7 deliverable per ARCHITECTURE.md.
//
// What's included: project.json, storyboard.json, every scene's
// script.csv / script.fountain / render.wav (+ meta) / assets/*.wav (+ meta),
// output/final.wav (+ meta), plus an archive-level manifest with the
// original project ID and creation timestamp.
//
// What's excluded: peaks caches (*.peaks.*.json — regenerated on demand),
// temp files (*.tmp), and any *.clip.* intermediates from clip-studio
// processing. Halves the archive size for asset-heavy projects.

use crate::error::{Error, Result};
use crate::app_support::project_dir;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct ArchiveResult {
    pub output_path: String,
    pub bytes: u64,
    pub file_count: u64,
    pub skipped_count: u64,
}

#[derive(Debug, Serialize)]
struct ArchiveManifest {
    pharaoh_archive_version: u32,
    archived_at: String,
    project_id: String,
    project_title: String,
}

/// Whether a file inside the project tree should be packaged. The exclusions
/// here are all things that are either regeneratable or transient.
fn should_include(rel: &Path) -> bool {
    let s = rel.to_string_lossy();
    if s.contains(".peaks.") && s.ends_with(".json") { return false; }
    if s.ends_with(".tmp") { return false; }
    if s.contains(".clip.") { return false; }
    if s.starts_with(".") || s.contains("/.") { return false; }
    true
}

pub fn archive_project_with_projects_dir(
    projects_dir: &Path,
    project_id: &str,
    output_path: &Path,
) -> Result<ArchiveResult> {
    let project_root = project_dir(projects_dir, project_id);
    if !project_root.exists() {
        return Err(Error::Other(format!(
            "project {} not found at {}",
            project_id, project_root.display()
        )));
    }

    // Read the project's title for the manifest. If project.json is missing
    // or unreadable, fall back to the directory name — the archive is still
    // valid, just less informative.
    let project_title = std::fs::read(project_root.join("project.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("title").and_then(|t| t.as_str().map(|s| s.to_string())))
        .unwrap_or_else(|| project_id.to_string());

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(output_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(6));

    // Manifest first — easy to read with `unzip -p archive.zip manifest.json`
    let manifest = ArchiveManifest {
        pharaoh_archive_version: 1,
        archived_at: chrono::Utc::now().to_rfc3339(),
        project_id: project_id.to_string(),
        project_title: project_title.clone(),
    };
    zip.start_file("manifest.json", opts).map_err(|e| Error::Other(format!("zip start: {}", e)))?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    zip.write_all(&manifest_bytes)?;

    let mut bytes_written: u64 = manifest_bytes.len() as u64;
    let mut file_count: u64 = 1;
    let mut skipped: u64 = 0;

    // Walk the project tree and stream files into the zip
    for entry in walkdir(&project_root)? {
        let path = entry;
        let rel = match path.strip_prefix(&project_root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        if !should_include(&rel) {
            skipped += 1;
            continue;
        }

        // Convert OS-specific separators to forward slashes for zip portability
        let archive_name = format!("project/{}", rel.to_string_lossy().replace('\\', "/"));

        if path.is_dir() {
            // Directories are implicit when files inside them are added; skip
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => { skipped += 1; continue; }
        };
        zip.start_file(&archive_name, opts).map_err(|e| Error::Other(format!("zip start file: {}", e)))?;
        zip.write_all(&bytes)?;
        bytes_written += bytes.len() as u64;
        file_count += 1;
    }

    zip.finish().map_err(|e| Error::Other(format!("zip finish: {}", e)))?;

    Ok(ArchiveResult {
        output_path: output_path.to_string_lossy().to_string(),
        bytes: bytes_written,
        file_count,
        skipped_count: skipped,
    })
}

/// Iterative directory walk — depth-first, files only at the leaves.
/// Avoids pulling in walkdir for one usage.
fn walkdir(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    Ok(out)
}

// ── Tauri command ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn archive_project(
    app: tauri::AppHandle,
    project_id: String,
    output_path: String,
) -> Result<ArchiveResult> {
    let projects_dir = crate::app_support::app_projects_dir(&app)?;
    let out = PathBuf::from(output_path);
    archive_project_with_projects_dir(&projects_dir, &project_id, &out)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn archive_round_trip_includes_expected_files_and_skips_caches() {
        let projects_dir = std::env::temp_dir().join(format!("pharaoh_archive_test_{}", std::process::id()));
        std::fs::create_dir_all(&projects_dir).unwrap();
        let project_id = Uuid::new_v4().to_string();
        let project_root = projects_dir.join(&project_id);
        let scenes = project_root.join("scenes").join("00_test");
        let assets = scenes.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let output_dir = project_root.join("output");
        std::fs::create_dir_all(&output_dir).unwrap();

        // Minimal project.json so manifest.title resolves
        std::fs::write(
            project_root.join("project.json"),
            r#"{"id":"x","title":"Test","logline":"","synopsis":"","tone":"","global_audio_notes":"","target_duration_minutes":0,"created_at":"2026-05-09T00:00:00Z","updated_at":"2026-05-09T00:00:00Z","characters":[],"llm_config":{"provider":"anthropic","model":"x","api_key_env":"X"}}"#,
        ).unwrap();
        std::fs::write(scenes.join("script.csv"), b"scene,track\n").unwrap();
        std::fs::write(scenes.join("script.fountain"), b"INT. ROOM - DAY\n").unwrap();
        std::fs::write(assets.join("clip.wav"), b"WAVDATA").unwrap();
        // Should be excluded: peaks cache + tmp + clip-studio intermediate
        std::fs::write(assets.join("clip.wav.peaks.120.json"), b"[0]").unwrap();
        std::fs::write(assets.join("staged.tmp"), b"x").unwrap();
        std::fs::write(assets.join("source.clip.20260101.wav"), b"x").unwrap();

        let archive_path = std::env::temp_dir().join(format!("pharaoh_archive_test_{}.zip", std::process::id()));
        let result = archive_project_with_projects_dir(&projects_dir, &project_id, &archive_path).unwrap();

        assert!(result.file_count >= 4, "expected manifest + project.json + script.csv + fountain + wav (>=4), got {}", result.file_count);
        assert!(result.skipped_count >= 3, "expected to skip peaks/tmp/clip files, skipped {}", result.skipped_count);
        assert!(archive_path.exists(), "archive file should exist");

        // Read the zip back and check manifest + an excluded file is absent
        let f = std::fs::File::open(&archive_path).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.contains(&"manifest.json".to_string()));
        assert!(names.iter().any(|n| n == "project/scenes/00_test/assets/clip.wav"));
        assert!(!names.iter().any(|n| n.contains(".peaks.")), "peaks should be excluded");
        assert!(!names.iter().any(|n| n.ends_with(".tmp")),  "tmp files should be excluded");

        // Cleanup
        std::fs::remove_dir_all(&projects_dir).ok();
        std::fs::remove_file(&archive_path).ok();
    }
}
