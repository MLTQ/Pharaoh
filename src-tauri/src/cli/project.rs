//! `pharaoh project ...` commands: list, status, create, update, archive.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use super::helpers::{
    flag_opt, flag_parse, load_project, parse_flags, print_json,
};
use crate::app_support::{project_dir, read_json, read_script_rows, script_path, write_json};
use crate::error::{Error, Result};
use crate::models::{LlmConfig, Project, Storyboard};

pub(super) async fn project_list(config: &crate::models::AppConfig) -> Result<()> {
    let root = PathBuf::from(&config.projects_dir);
    let mut projects = vec![];
    if root.exists() {
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let project_json = entry.path().join("project.json");
            if project_json.exists() {
                if let Ok(project) = read_json::<Project>(&project_json) {
                    projects.push(project);
                }
            }
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    print_json(&projects)
}

pub(super) async fn project_status(
    config: &crate::models::AppConfig,
    project_id: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let storyboard_path = project_dir(&projects_dir, project_id).join("storyboard.json");

    let project = load_project(config, project_id)?;
    let storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };

    let mut total_rows = 0usize;
    let mut unresolved_rows = 0usize;
    let mut placed_rows = 0usize;
    for scene in &storyboard.scenes {
        let rows = read_script_rows(&script_path(&projects_dir, project_id, &scene.slug))?;
        total_rows += rows.len();
        unresolved_rows += rows
            .iter()
            .filter(|row| row.track_type != "DIRECTION" && row.file.trim().is_empty())
            .count();
        placed_rows += rows
            .iter()
            .filter(|row| !row.file.trim().is_empty() && !row.start_ms.trim().is_empty())
            .count();
    }

    print_json(&json!({
        "project": {
            "id": project.id,
            "title": project.title,
            "updated_at": project.updated_at,
        },
        "scenes": storyboard.scenes,
        "metrics": {
            "total_scenes": project_scene_count(&storyboard),
            "script_rows": total_rows,
            "unresolved_rows": unresolved_rows,
            "placed_rows": placed_rows,
        }
    }))
}

fn project_scene_count(storyboard: &Storyboard) -> usize {
    storyboard.scenes.len()
}

pub(super) async fn project_create(
    config: &crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let mut title: Option<String> = None;
    let mut logline: Option<String> = None;
    let mut tone: Option<String> = None;

    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--title" => {
                i += 1;
                title = rest.get(i).cloned();
            }
            "--logline" => {
                i += 1;
                logline = rest.get(i).cloned();
            }
            "--tone" => {
                i += 1;
                tone = rest.get(i).cloned();
            }
            other => {
                return Err(Error::Other(format!("unknown flag: {}", other)));
            }
        }
        i += 1;
    }

    let title = title.ok_or_else(|| Error::Other("missing --title".into()))?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let project = Project {
        id: id.clone(),
        title,
        logline: logline.unwrap_or_default(),
        synopsis: String::new(),
        tone: tone.unwrap_or_default(),
        global_audio_notes: String::new(),
        target_duration_minutes: 30,
        created_at: now,
        updated_at: now,
        characters: vec![],
        llm_config: LlmConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            api_key_env: "ANTHROPIC_API_KEY".into(),
        },
    };

    let projects_dir = PathBuf::from(&config.projects_dir);
    let dir = project_dir(&projects_dir, &id);
    std::fs::create_dir_all(dir.join("scenes"))?;
    std::fs::create_dir_all(dir.join("output"))?;
    write_json(&dir.join("project.json"), &project)?;
    write_json(&dir.join("storyboard.json"), &Storyboard { scenes: vec![] })?;

    print_json(&project)
}

pub(super) async fn project_update(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = project_dir(&projects_dir, project_id).join("project.json");
    let mut project = load_project(config, project_id)?;
    if let Some(value) = flag_opt(&flags, "title") {
        project.title = value;
    }
    if let Some(value) = flag_opt(&flags, "logline") {
        project.logline = value;
    }
    if let Some(value) = flag_opt(&flags, "synopsis") {
        project.synopsis = value;
    }
    if let Some(value) = flag_opt(&flags, "tone") {
        project.tone = value;
    }
    if let Some(value) = flag_opt(&flags, "global_audio_notes") {
        project.global_audio_notes = value;
    }
    if flags.contains_key("target_duration_minutes") {
        project.target_duration_minutes = flag_parse(
            &flags,
            "target_duration_minutes",
            project.target_duration_minutes,
        )?;
    }
    project.updated_at = Utc::now();
    write_json(&path, &project)?;
    print_json(&project)
}

/// `pharaoh project archive <project> [--output <path>]`
///
/// Bundles the project into a zip. Defaults the output to
/// ./pharaoh-archive-<title-slug>-<date>.zip in the current directory.
pub(super) async fn project_archive(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    // Resolve a default output path: ./pharaoh-archive-<slug>-<YYYYMMDD>.zip
    let project = load_project(config, project_id).ok();
    let title_slug = project
        .as_ref()
        .map(|p| {
            p.title
                .to_lowercase()
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        })
        .unwrap_or_else(|| project_id.to_string());
    let default_output = format!(
        "./pharaoh-archive-{}-{}.zip",
        title_slug.trim_matches('_'),
        Utc::now().format("%Y%m%d"),
    );
    let output = flag_opt(&flags, "output").unwrap_or(default_output);
    let result = crate::commands::archive::archive_project_with_projects_dir(
        &projects_dir,
        project_id,
        Path::new(&output),
    )?;
    print_json(&result)
}
