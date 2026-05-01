use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use chrono::Utc;
use crate::models::{AppState, Project, Scene, Storyboard, LlmConfig, SceneStatus};
use crate::error::{Error, Result};

fn projects_dir(app: &AppHandle) -> PathBuf {
    let state = app.state::<AppState>();
    let cfg = state.app_config.read().expect("app_config lock poisoned");
    PathBuf::from(&cfg.projects_dir)
}

fn project_dir(app: &AppHandle, project_id: &str) -> PathBuf {
    projects_dir(app).join(project_id)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T> {
    let data = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&data)?)
}

fn write_json<T: serde::Serialize>(path: &PathBuf, value: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(value)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, json)?;
    Ok(())
}

#[tauri::command]
pub fn get_projects_dir(app: AppHandle) -> String {
    projects_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
pub fn create_project(
    app: AppHandle,
    title: String,
    logline: Option<String>,
    tone: Option<String>,
) -> Result<Project> {
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
            provider: "anthropic".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            api_key_env: "ANTHROPIC_API_KEY".to_string(),
        },
    };

    let dir = project_dir(&app, &id);
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(dir.join("scenes"))?;
    std::fs::create_dir_all(dir.join("output"))?;

    write_json(&dir.join("project.json"), &project)?;

    let storyboard = Storyboard { scenes: vec![] };
    write_json(&dir.join("storyboard.json"), &storyboard)?;

    Ok(project)
}

#[tauri::command]
pub fn open_project(app: AppHandle, project_id: String) -> Result<Project> {
    let path = project_dir(&app, &project_id).join("project.json");
    read_json(&path)
}

#[tauri::command]
pub fn get_project(app: AppHandle, project_id: String) -> Result<Project> {
    let path = project_dir(&app, &project_id).join("project.json");
    read_json(&path)
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<Project>> {
    let dir = projects_dir(&app);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut projects = vec![];
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let project_json = entry.path().join("project.json");
        if project_json.exists() {
            if let Ok(p) = read_json::<Project>(&project_json) {
                projects.push(p);
            }
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

#[tauri::command]
pub fn update_project(app: AppHandle, project: Project) -> Result<Project> {
    let mut p = project;
    p.updated_at = Utc::now();
    let path = project_dir(&app, &p.id).join("project.json");
    write_json(&path, &p)?;
    Ok(p)
}

#[tauri::command]
pub fn create_scene(
    app: AppHandle,
    project_id: String,
    title: String,
    description: Option<String>,
    location: Option<String>,
    index: u32,
) -> Result<Scene> {
    let slug = format!(
        "{:02}_{}",
        index,
        title.to_lowercase().replace(' ', "_").replace(|c: char| !c.is_alphanumeric() && c != '_', "")
    );

    let scene = Scene {
        id: Uuid::new_v4().to_string(),
        index,
        slug: slug.clone(),
        title,
        description: description.unwrap_or_default(),
        location: location.unwrap_or_default(),
        characters: vec![],
        notes: String::new(),
        connects_from: None,
        connects_to: None,
        status: SceneStatus::Draft,
    };

    // Create scene directories
    let scene_dir = project_dir(&app, &project_id)
        .join("scenes")
        .join(&slug);
    std::fs::create_dir_all(scene_dir.join("assets"))?;
    std::fs::create_dir_all(scene_dir.join("render"))?;

    // Write empty script.csv
    let script_path = scene_dir.join("script.csv");
    std::fs::write(
        &script_path,
        "scene,track,type,character,prompt,file,start_ms,duration_ms,loop,pan,gain_db,instruct,fade_in_ms,fade_out_ms,reverb_send,notes\n"
    )?;

    // Update storyboard.json
    let project_dir = project_dir(&app, &project_id);
    let storyboard_path = project_dir.join("storyboard.json");
    let mut storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };
    storyboard.scenes.push(scene.clone());
    storyboard.scenes.sort_by_key(|s| s.index);
    write_json(&storyboard_path, &storyboard)?;

    // Touch updated_at on project
    let project_path = project_dir.join("project.json");
    if let Ok(mut proj) = read_json::<Project>(&project_path) {
        proj.updated_at = Utc::now();
        let _ = write_json(&project_path, &proj);
    }

    Ok(scene)
}

#[tauri::command]
pub fn update_scene(
    app: AppHandle,
    project_id: String,
    scene: Scene,
) -> Result<Scene> {
    let storyboard_path = project_dir(&app, &project_id).join("storyboard.json");
    let mut storyboard: Storyboard = read_json(&storyboard_path)?;
    if let Some(existing) = storyboard.scenes.iter_mut().find(|s| s.id == scene.id) {
        *existing = scene.clone();
    } else {
        return Err(Error::Other(format!("scene {} not found", scene.id)));
    }
    write_json(&storyboard_path, &storyboard)?;
    Ok(scene)
}

#[tauri::command]
pub fn get_scene(
    app: AppHandle,
    project_id: String,
    scene_id: String,
) -> Result<Scene> {
    let storyboard_path = project_dir(&app, &project_id).join("storyboard.json");
    let storyboard: Storyboard = read_json(&storyboard_path)?;
    storyboard
        .scenes
        .into_iter()
        .find(|s| s.id == scene_id)
        .ok_or_else(|| Error::Other(format!("scene {} not found", scene_id)))
}

#[tauri::command]
pub fn list_scenes(app: AppHandle, project_id: String) -> Result<Vec<Scene>> {
    let storyboard_path = project_dir(&app, &project_id).join("storyboard.json");
    if !storyboard_path.exists() {
        return Ok(vec![]);
    }
    let storyboard: Storyboard = read_json(&storyboard_path)?;
    Ok(storyboard.scenes)
}
