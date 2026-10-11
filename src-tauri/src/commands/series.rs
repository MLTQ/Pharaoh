use std::path::Path;

use chrono::Utc;
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_support::{
    app_projects_dir, project_dir, read_json, series_dir, series_root_dir, write_json,
};
use crate::commands::character::import_into_project;
use crate::commands::project::{create_project_at, list_projects, migrate_project_in_place};
use crate::error::{Error, Result};
use crate::models::{CanonEntry, Project, Series};

const SERIES_FILE: &str = "series.json";
const CANON_FILE: &str = "canon.json";

/// Ids become directory names, and mesh viewers can send them; refuse
/// anything that could walk out of `_series/`.
fn check_id(series_id: &str) -> Result<()> {
    if series_id.is_empty() || !series_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(Error::Other(format!("invalid series id: {series_id:?}")));
    }
    Ok(())
}

pub fn load_series(projects_dir: &Path, series_id: &str) -> Result<Series> {
    check_id(series_id)?;
    let path = series_dir(projects_dir, series_id).join(SERIES_FILE);
    if !path.exists() {
        return Err(Error::Other(format!("series {series_id} not found")));
    }
    let mut series: Series = read_json(&path)?;
    series.id = series_id.to_string();
    absolutize_sounds(&mut series, &series_dir(projects_dir, series_id));
    Ok(series)
}

fn store_series(projects_dir: &Path, series: &Series) -> Result<()> {
    check_id(&series.id)?;
    let dir = series_dir(projects_dir, &series.id);
    std::fs::create_dir_all(&dir)?;
    // Sound files live inside the series folder; store them relative so the
    // folder can move with the projects dir.
    let mut to_write = series.clone();
    for cue in to_write.sounds.iter_mut() {
        if let Some(f) = cue.file.as_mut() {
            if let Ok(rel) = Path::new(f.as_str()).strip_prefix(&dir) {
                *f = rel.to_string_lossy().to_string();
            }
        }
    }
    write_json(&dir.join(SERIES_FILE), &to_write)
}

fn absolutize_sounds(series: &mut Series, dir: &Path) {
    for cue in series.sounds.iter_mut() {
        if let Some(f) = cue.file.as_mut() {
            if !f.is_empty() && Path::new(f.as_str()).is_relative() {
                *f = dir.join(f.as_str()).to_string_lossy().to_string();
            }
        }
        if cue.file.as_deref() == Some("") {
            cue.file = None;
        }
    }
}

pub fn load_canon(projects_dir: &Path, series_id: &str) -> Result<Vec<CanonEntry>> {
    check_id(series_id)?;
    let path = series_dir(projects_dir, series_id).join(CANON_FILE);
    if !path.exists() {
        return Ok(vec![]);
    }
    read_json(&path)
}

pub fn store_canon(projects_dir: &Path, series_id: &str, canon: &[CanonEntry]) -> Result<()> {
    check_id(series_id)?;
    let dir = series_dir(projects_dir, series_id);
    if !dir.join(SERIES_FILE).exists() {
        return Err(Error::Other(format!("series {series_id} not found")));
    }
    write_json(&dir.join(CANON_FILE), &canon.to_vec())
}

#[tauri::command]
pub fn list_series(app: AppHandle) -> Result<Vec<Series>> {
    list_series_in(&app_projects_dir(&app)?)
}

pub fn list_series_in(projects_dir: &Path) -> Result<Vec<Series>> {
    let root = series_root_dir(projects_dir);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in std::fs::read_dir(&root)? {
        let path = entry?.path().join(SERIES_FILE);
        if let Ok(mut s) = read_json::<Series>(&path) {
            if let Some(dir) = path.parent() {
                if let Some(id) = dir.file_name().and_then(|n| n.to_str()) {
                    s.id = id.to_string();
                }
                absolutize_sounds(&mut s, dir);
            }
            out.push(s);
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn get_series(app: AppHandle, series_id: String) -> Result<Series> {
    load_series(&app_projects_dir(&app)?, &series_id)
}

#[tauri::command]
pub fn create_series(
    app: AppHandle,
    title: String,
    logline: Option<String>,
) -> Result<Series> {
    create_series_at(&app_projects_dir(&app)?, title, logline)
}

pub fn create_series_at(
    projects_dir: &Path,
    title: String,
    logline: Option<String>,
) -> Result<Series> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(Error::Other("series title is required".into()));
    }
    let now = Utc::now();
    let series = Series {
        id: Uuid::new_v4().to_string(),
        title,
        logline: logline.unwrap_or_default(),
        continuity: "episodic".into(),
        episode_minutes: 10,
        created_at: Some(now),
        updated_at: Some(now),
        ..Series::default()
    };
    store_series(projects_dir, &series)?;
    Ok(series)
}

/// A series by id, or by title (case-insensitive; a unique fragment will do),
/// so the CLI can say `episode new "Night Shift"`.
pub fn resolve_series(projects_dir: &Path, reference: &str) -> Result<Series> {
    let r = reference.trim();
    if check_id(r).is_ok() && series_dir(projects_dir, r).join(SERIES_FILE).exists() {
        return load_series(projects_dir, r);
    }
    let all = list_series_in(projects_dir)?;
    let lower = r.to_lowercase();
    if let Some(s) = all.iter().find(|s| s.title.to_lowercase() == lower) {
        return Ok(s.clone());
    }
    let hits: Vec<&Series> = all.iter().filter(|s| s.title.to_lowercase().contains(&lower) || s.id.starts_with(r)).collect();
    match hits.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(Error::Other(format!("no series matches {r:?}; `pharaoh series list` shows them"))),
        many => Err(Error::Other(format!(
            "{r:?} matches several series: {}",
            many.iter().map(|s| s.title.as_str()).collect::<Vec<_>>().join(", ")
        ))),
    }
}

#[tauri::command]
pub fn update_series(app: AppHandle, series: Series) -> Result<Series> {
    let projects_dir = app_projects_dir(&app)?;
    // Must already exist: update never creates a series from a stray id.
    let existing = load_series(&projects_dir, &series.id)?;
    let mut s = series;
    s.created_at = existing.created_at.or(s.created_at);
    s.updated_at = Some(Utc::now());
    store_series(&projects_dir, &s)?;
    load_series(&projects_dir, &s.id)
}

#[tauri::command]
pub fn list_series_canon(app: AppHandle, series_id: String) -> Result<Vec<CanonEntry>> {
    load_canon(&app_projects_dir(&app)?, &series_id)
}

#[tauri::command]
pub fn save_series_canon(app: AppHandle, series_id: String, canon: Vec<CanonEntry>) -> Result<Vec<CanonEntry>> {
    store_canon(&app_projects_dir(&app)?, &series_id, &canon)?;
    Ok(canon)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SoundTake {
    pub path: String,
    pub duration_ms: Option<u64>,
    /// Seconds since the epoch, for newest-first ordering.
    pub modified: u64,
}

/// Create and return `<series>/sound/<cue_id>/`, where that cue's takes go.
#[tauri::command]
pub fn prepare_series_sound_dir(app: AppHandle, series_id: String, cue_id: String) -> Result<String> {
    check_id(&series_id)?;
    check_id(&cue_id.replace('_', "-"))?;
    let dir = series_dir(&app_projects_dir(&app)?, &series_id).join("sound").join(&cue_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Takes generated for one sound cue: `<series>/sound/<cue_id>/*.wav`.
#[tauri::command]
pub fn list_series_sound_takes(app: AppHandle, series_id: String, cue_id: String) -> Result<Vec<SoundTake>> {
    check_id(&series_id)?;
    check_id(&cue_id.replace('_', "-"))?;
    let dir = series_dir(&app_projects_dir(&app)?, &series_id).join("sound").join(&cue_id);
    let mut out = vec![];
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(out) };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("wav") {
            continue;
        }
        let duration_ms = hound::WavReader::open(&p)
            .ok()
            .map(|r| r.duration() as u64 * 1000 / r.spec().sample_rate.max(1) as u64);
        let modified = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(SoundTake { path: p.to_string_lossy().to_string(), duration_ms, modified });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn list_series_episodes(app: AppHandle, series_id: String) -> Result<Vec<Project>> {
    check_id(&series_id)?;
    let mut eps: Vec<Project> = list_projects(app)?
        .into_iter()
        .filter(|p| p.series_id.as_deref() == Some(series_id.as_str()))
        .collect();
    eps.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(eps)
}

/// A new episode is an ordinary project linked to the series: tone and
/// length come from the bible, and every voiced cast member is imported
/// from the character library under their series name.
#[tauri::command]
pub fn create_series_episode(
    app: AppHandle,
    series_id: String,
    title: Option<String>,
    logline: Option<String>,
) -> Result<Project> {
    let projects_dir = app_projects_dir(&app)?;
    create_episode_at(&projects_dir, &series_id, title, logline)
}

pub fn create_episode_at(
    projects_dir: &Path,
    series_id: &str,
    title: Option<String>,
    logline: Option<String>,
) -> Result<Project> {
    let series = load_series(projects_dir, series_id)?;
    let title = match title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => {
            let n = episode_count(projects_dir, series_id) + 1;
            format!("Episode {n}")
        }
    };
    let project = create_project_at(
        projects_dir,
        title,
        logline.unwrap_or_default(),
        series.tone.clone(),
        Some(series.id.clone()),
    )?;

    let path = project_dir(projects_dir, &project.id).join("project.json");
    if series.episode_minutes > 0 {
        let mut p: Project = read_json(&path)?;
        p.target_duration_minutes = series.episode_minutes;
        write_json(&path, &p)?;
    }

    for member in &series.cast {
        if let Some(lib) = member.library_id.as_deref().filter(|l| !l.is_empty()) {
            import_into_project(projects_dir, &project.id, lib, Some(member.name.clone()))?;
        }
    }

    let mut p: Project = read_json(&path)?;
    migrate_project_in_place(&mut p, projects_dir);
    Ok(p)
}

fn episode_count(projects_dir: &Path, series_id: &str) -> usize {
    episodes_in(projects_dir, series_id).len()
}

/// A series' episodes as stored on disk, oldest first.
pub fn episodes_in(projects_dir: &Path, series_id: &str) -> Vec<Project> {
    let Ok(entries) = std::fs::read_dir(projects_dir) else { return vec![] };
    let mut eps: Vec<Project> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| read_json::<Project>(&e.path().join("project.json")).ok())
        .filter(|p| p.series_id.as_deref() == Some(series_id))
        .collect();
    eps.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    eps
}

#[cfg(test)]
pub(crate) fn tests_store(projects_dir: &Path, series: &Series) {
    store_series(projects_dir, series).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CastMember;

    fn temp_dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pharaoh-series-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn episode_inherits_series_and_numbers_itself() {
        let dir = temp_dir();
        let series = Series {
            id: Uuid::new_v4().to_string(),
            title: "Night Shift".into(),
            tone: "Cozy horror".into(),
            episode_minutes: 7,
            cast: vec![CastMember { id: "c1".into(), name: "Dot".into(), ..Default::default() }],
            ..Default::default()
        };
        store_series(&dir, &series).unwrap();

        let ep1 = create_episode_at(&dir, &series.id, None, None).unwrap();
        assert_eq!(ep1.title, "Episode 1");
        assert_eq!(ep1.series_id.as_deref(), Some(series.id.as_str()));
        assert_eq!(ep1.tone, "Cozy horror");
        assert_eq!(ep1.target_duration_minutes, 7);
        // Cast without a library voice is not imported.
        assert!(ep1.characters.is_empty());

        let ep2 = create_episode_at(&dir, &series.id, Some("The Vending Machine".into()), None).unwrap();
        assert_eq!(ep2.title, "The Vending Machine");
        assert_eq!(create_episode_at(&dir, &series.id, None, None).unwrap().title, "Episode 3");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_path_ids() {
        assert!(check_id("../x").is_err());
        assert!(check_id("a/b").is_err());
        assert!(check_id("").is_err());
        assert!(check_id("0f8c-12ab").is_ok());
    }

    #[test]
    fn one_shot_json_has_no_series_field() {
        let dir = temp_dir();
        let p = create_project_at(&dir, "Solo".into(), String::new(), String::new(), None).unwrap();
        let raw = std::fs::read_to_string(project_dir(&dir, &p.id).join("project.json")).unwrap();
        assert!(!raw.contains("series_id"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
