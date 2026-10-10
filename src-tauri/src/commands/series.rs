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
use crate::models::{Project, Series};

const SERIES_FILE: &str = "series.json";

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
    Ok(series)
}

fn store_series(projects_dir: &Path, series: &Series) -> Result<()> {
    check_id(&series.id)?;
    let dir = series_dir(projects_dir, &series.id);
    std::fs::create_dir_all(&dir)?;
    write_json(&dir.join(SERIES_FILE), series)
}

#[tauri::command]
pub fn list_series(app: AppHandle) -> Result<Vec<Series>> {
    let root = series_root_dir(&app_projects_dir(&app)?);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in std::fs::read_dir(&root)? {
        let path = entry?.path().join(SERIES_FILE);
        if let Ok(mut s) = read_json::<Series>(&path) {
            if let Some(id) = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
                s.id = id.to_string();
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
    format: Option<String>,
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
        format: format.unwrap_or_else(|| "sitcom".into()),
        continuity: "episodic".into(),
        episode_minutes: 10,
        created_at: Some(now),
        updated_at: Some(now),
        ..Series::default()
    };
    store_series(&app_projects_dir(&app)?, &series)?;
    Ok(series)
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
    Ok(s)
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
    let Ok(entries) = std::fs::read_dir(projects_dir) else { return 0 };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| read_json::<Project>(&e.path().join("project.json")).ok())
        .filter(|p| p.series_id.as_deref() == Some(series_id))
        .count()
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
