//! Every take of a script line, for the Compare takes panel.
//!
//! Takes are found on disk, not in the session's job list, so older takes
//! show up too. A take is one generation plus whatever was made from it —
//! `take.wav`, `take.lock.wav` (voice lock), `take….upscaled.speech.….wav`
//! (AudioSR) — grouped by the file name up to its first dot. The newest file
//! in a group is the version that would be placed. A group belongs to a row
//! when any of its sidecars carries the row's line, or it holds the row's
//! current file.
//!
//! Ratings (1–5) live in `scenes/<slug>/take_ratings.json`, keyed by group.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_support::{app_projects_dir, read_script_rows, scene_dir};
use crate::error::{Error, Result};
use crate::models::SidecarMeta;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowTake {
    /// Group key: the file name up to its first dot.
    pub key: String,
    /// The version that would be placed (newest file in the group).
    pub path: String,
    /// Every file in the group, oldest first.
    pub versions: Vec<String>,
    pub model: String,
    pub seed: Option<i64>,
    pub instruct: Option<String>,
    pub qa_notes: String,
    pub generated_at: Option<String>,
    pub rating: Option<u8>,
    /// The row's current file is one of this take's versions.
    pub in_use: bool,
}

fn group_key(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    Some(name.split('.').next()?.to_string())
}

fn ratings_path(dir: &Path) -> PathBuf {
    dir.join("take_ratings.json")
}

fn read_ratings(dir: &Path) -> BTreeMap<String, u8> {
    std::fs::read(ratings_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn sidecar(audio: &Path) -> Option<SidecarMeta> {
    let meta = PathBuf::from(format!("{}.meta.json", audio.to_string_lossy()));
    serde_json::from_slice(&std::fs::read(meta).ok()?).ok()
}

fn audio_ext(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "wav" | "flac"))
}

pub fn row_takes_in(scene: &Path, row_index: usize) -> Result<Vec<RowTake>> {
    let rows = read_script_rows(&scene.join("script.csv"))?;
    let row = rows.get(row_index).ok_or_else(|| Error::Other(format!("no row {}", row_index)))?;
    let line = row.prompt.trim();
    let current = (!row.file.trim().is_empty()).then(|| PathBuf::from(row.file.trim()));
    let current_key = current.as_deref().and_then(group_key);

    let mut groups: HashMap<String, Vec<(PathBuf, std::time::SystemTime)>> = HashMap::new();
    for dir in [scene.join("assets"), scene.to_path_buf()] {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if !audio_ext(&p) {
                continue;
            }
            let Some(key) = group_key(&p) else { continue };
            let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            groups.entry(key).or_default().push((p, mtime));
        }
    }

    let ratings = read_ratings(scene);
    let mut takes = Vec::new();
    for (key, mut files) in groups {
        files.sort_by_key(|(p, t)| (*t, p.to_string_lossy().len()));
        let metas: Vec<SidecarMeta> = files.iter().filter_map(|(p, _)| sidecar(p)).collect();
        let matches_line = !line.is_empty() && metas.iter().any(|m| m.prompt.trim() == line);
        let holds_current = current_key.as_deref() == Some(key.as_str());
        if !matches_line && !holds_current {
            continue;
        }
        // The first generation's details; later versions only add notes.
        let meta = metas.first();
        let notes: Vec<&str> = metas.iter().map(|m| m.qa_notes.as_str()).filter(|n| !n.is_empty()).collect();
        let versions: Vec<String> = files.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect();
        let in_use = current.as_ref().is_some_and(|c| versions.iter().any(|v| Path::new(v) == c));
        takes.push(RowTake {
            path: versions.last().cloned().unwrap_or_default(),
            versions,
            model: meta.map(|m| m.model.clone()).unwrap_or_else(|| "unknown".into()),
            seed: meta.map(|m| m.seed),
            instruct: meta.and_then(|m| m.instruct.clone()),
            qa_notes: notes.last().map(|s| s.to_string()).unwrap_or_default(),
            generated_at: meta.map(|m| m.generated_at.to_rfc3339()),
            rating: ratings.get(&key).copied(),
            in_use,
            key,
        });
    }
    takes.sort_by(|a, b| a.generated_at.cmp(&b.generated_at).then(a.key.cmp(&b.key)));
    Ok(takes)
}

pub fn rate_take_in(scene: &Path, key: &str, rating: Option<u8>) -> Result<()> {
    if rating.is_some_and(|r| !(1..=5).contains(&r)) {
        return Err(Error::Other("rating must be 1–5".into()));
    }
    let mut ratings = read_ratings(scene);
    match rating {
        Some(r) => ratings.insert(key.to_string(), r),
        None => ratings.remove(key),
    };
    std::fs::write(ratings_path(scene), serde_json::to_vec_pretty(&ratings)?)?;
    Ok(())
}

/// Every take of a script line (see the module docs).
#[tauri::command]
pub fn row_takes(app: AppHandle, project_id: String, scene_slug: String, row_index: usize) -> Result<Vec<RowTake>> {
    row_takes_in(&scene_dir(&app_projects_dir(&app)?, &project_id, &scene_slug), row_index)
}

/// Rate a take 1–5 (`None` clears it).
#[tauri::command]
pub fn rate_take(app: AppHandle, project_id: String, scene_slug: String, key: String, rating: Option<u8>) -> Result<()> {
    rate_take_in(&scene_dir(&app_projects_dir(&app)?, &project_id, &scene_slug), &key, rating)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_support::write_script_rows;
    use crate::models::ScriptRow;

    fn row(prompt: &str, file: &str) -> ScriptRow {
        serde_json::from_value(serde_json::json!({
            "scene": "S01", "track": "t", "type": "DIALOGUE", "character": "C", "prompt": prompt, "file": file,
            "start_ms": "", "duration_ms": "", "loop": "false", "pan": "0", "gain_db": "0", "instruct": "",
            "fade_in_ms": "0", "fade_out_ms": "0", "reverb_send": "0", "emotion": "", "notes": ""
        }))
        .unwrap()
    }

    fn meta(prompt: &str) -> String {
        serde_json::json!({
            "model": "breeze-tts-2-direction", "model_variant": null, "prompt": prompt, "instruct": "calm",
            "speaker": "C", "language": "en", "seed": 7, "temperature": null, "top_p": null,
            "duration_target_ms": null, "duration_actual_ms": null, "sample_rate": 24000,
            "generated_at": "2026-10-04T12:00:00Z", "parent": null, "take_index": 1,
            "qa_status": "unreviewed", "qa_notes": "take check: 0% off the script"
        })
        .to_string()
    }

    #[test]
    fn groups_versions_matches_the_line_and_keeps_ratings() {
        let scene = std::env::temp_dir().join(format!("pharaoh-takes-{}", uuid::Uuid::new_v4()));
        let assets = scene.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let w = |n: &str| std::fs::write(assets.join(n), b"RIFF").unwrap();
        w("c_1.wav");
        std::fs::write(assets.join("c_1.wav.meta.json"), meta("Hello there.")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        w("c_1.lock.wav");
        w("c_2.wav");
        std::fs::write(assets.join("c_2.wav.meta.json"), meta("Hello there.")).unwrap();
        w("c_3.wav");
        std::fs::write(assets.join("c_3.wav.meta.json"), meta("Another line.")).unwrap();
        let locked = assets.join("c_1.lock.wav").to_string_lossy().into_owned();
        write_script_rows(&scene.join("script.csv"), &[row("Hello there.", &locked)]).unwrap();

        rate_take_in(&scene, "c_2", Some(4)).unwrap();
        let takes = row_takes_in(&scene, 0).unwrap();
        assert_eq!(takes.len(), 2, "the other line's take isn't listed");
        let t1 = takes.iter().find(|t| t.key == "c_1").unwrap();
        assert_eq!(t1.versions.len(), 2);
        assert_eq!(t1.path, locked, "the newest version is the one placed");
        assert!(t1.in_use);
        assert_eq!(takes.iter().find(|t| t.key == "c_2").unwrap().rating, Some(4));
        assert!(rate_take_in(&scene, "c_2", Some(9)).is_err());
        std::fs::remove_dir_all(&scene).ok();
    }
}
