use std::path::Path;

use tauri::AppHandle;
use uuid::Uuid;
use chrono::Utc;
use crate::app_support::{
    absolutize_voice_paths, app_projects_dir, character_dir, lift_legacy_ref_sources,
    project_dir, read_json, relativize_voice_paths, scan_rvc_corpus_dir, write_json,
};
use crate::models::{
    Project, Scene, Storyboard, LlmConfig, RvcConfig, SceneStatus, CURRENT_CHARACTER_SCHEMA,
};
use crate::error::{Error, Result};

/// Bring a project's characters up to [`CURRENT_CHARACTER_SCHEMA`] and refresh
/// transient stats (corpus count/duration) from on-disk truth.
///
/// Idempotent. Called on every read path (`get_project`, `open_project`,
/// `list_projects`) so the UI always sees a consistent, current shape regardless
/// of how the project was last written.
fn migrate_project_in_place(project: &mut Project, projects_dir: &Path) {
    for character in project.characters.iter_mut() {
        character.voice_assignment.consolidate_legacy_rvc();

        let bundle = character_dir(projects_dir, &project.id, &character.id);

        // Path absolutization: if disk paths are relative (post-Pharaoh-1qp),
        // turn them into absolute paths joined onto the bundle dir so the UI
        // and downstream callers don't need to know about the storage format.
        // Idempotent — absolute paths pass through unchanged.
        absolutize_voice_paths(&mut character.voice_assignment, &bundle);

        // Lift legacy single-ref characters into the sources-list shape so
        // the UI sees one consistent model (Pharaoh-0b3l).
        lift_legacy_ref_sources(&mut character.voice_assignment);

        // Refresh transient corpus stats. If a corpus dir exists but there's no
        // RvcConfig yet, create one with stats only — keeps the UI in sync when
        // a corpus is populated outside the standard flow (MCP, manual copy).
        let corpus_dir = bundle.join("rvc_corpus");
        let (count, dur_ms) = scan_rvc_corpus_dir(&corpus_dir);

        match character.voice_assignment.rvc.as_mut() {
            Some(rvc) => {
                rvc.corpus_count = count;
                rvc.corpus_duration_ms = dur_ms;
            }
            None if count > 0 => {
                character.voice_assignment.rvc = Some(RvcConfig {
                    corpus_count: count,
                    corpus_duration_ms: dur_ms,
                    ..RvcConfig::default()
                });
            }
            None => {}
        }

        character.schema_version = CURRENT_CHARACTER_SCHEMA;
    }
}

/// Relativize all in-bundle voice paths before writing project.json to disk.
/// Paired with [`absolutize_voice_paths`] on the read side; together they make
/// the on-disk storage format (relative) transparent to the UI and MCP.
fn relativize_for_write(project: &mut Project, projects_dir: &Path) {
    for character in project.characters.iter_mut() {
        let bundle = character_dir(projects_dir, &project.id, &character.id);
        relativize_voice_paths(&mut character.voice_assignment, &bundle);
    }
}

#[tauri::command]
pub fn get_projects_dir(app: AppHandle) -> String {
    app_projects_dir(&app)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
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

    let dir = project_dir(&app_projects_dir(&app)?, &id);
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
    let projects_dir = app_projects_dir(&app)?;
    let path = project_dir(&projects_dir, &project_id).join("project.json");
    let mut project: Project = read_json(&path)?;
    migrate_project_in_place(&mut project, &projects_dir);
    Ok(project)
}

#[tauri::command]
pub fn get_project(app: AppHandle, project_id: String) -> Result<Project> {
    let projects_dir = app_projects_dir(&app)?;
    let path = project_dir(&projects_dir, &project_id).join("project.json");
    let mut project: Project = read_json(&path)?;
    migrate_project_in_place(&mut project, &projects_dir);
    Ok(project)
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<Project>> {
    let dir = app_projects_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut projects = vec![];
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let project_json = entry.path().join("project.json");
        if project_json.exists() {
            if let Ok(mut p) = read_json::<Project>(&project_json) {
                migrate_project_in_place(&mut p, &dir);
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
    // Ensure write conforms to the current schema regardless of caller hygiene:
    // - lift any stray legacy rvc_* fields the UI sent back
    // - stamp schema_version=CURRENT so the file no longer needs migration on read
    let projects_dir = app_projects_dir(&app)?;
    for character in p.characters.iter_mut() {
        character.voice_assignment.consolidate_legacy_rvc();
        character.schema_version = CURRENT_CHARACTER_SCHEMA;
    }
    // Convert in-bundle voice paths to relative for portable on-disk storage.
    // Mutates a clone so the response we return to the UI keeps its absolute
    // paths (avoids the UI having to re-resolve everything after a save).
    let mut to_write = p.clone();
    relativize_for_write(&mut to_write, &projects_dir);
    let path = project_dir(&projects_dir, &p.id).join("project.json");
    write_json(&path, &to_write)?;
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
    let scene_dir = project_dir(&app_projects_dir(&app)?, &project_id)
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
    let project_root = project_dir(&app_projects_dir(&app)?, &project_id);
    let storyboard_path = project_root.join("storyboard.json");
    let mut storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };
    storyboard.scenes.push(scene.clone());
    storyboard.scenes.sort_by_key(|s| s.index);
    write_json(&storyboard_path, &storyboard)?;

    // Touch updated_at on project
    let project_path = project_root.join("project.json");
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
    let storyboard_path = project_dir(&app_projects_dir(&app)?, &project_id).join("storyboard.json");
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
    let storyboard_path = project_dir(&app_projects_dir(&app)?, &project_id).join("storyboard.json");
    let storyboard: Storyboard = read_json(&storyboard_path)?;
    storyboard
        .scenes
        .into_iter()
        .find(|s| s.id == scene_id)
        .ok_or_else(|| Error::Other(format!("scene {} not found", scene_id)))
}

#[tauri::command]
pub fn list_scenes(app: AppHandle, project_id: String) -> Result<Vec<Scene>> {
    let storyboard_path = project_dir(&app_projects_dir(&app)?, &project_id).join("storyboard.json");
    if !storyboard_path.exists() {
        return Ok(vec![]);
    }
    let storyboard: Storyboard = read_json(&storyboard_path)?;
    Ok(storyboard.scenes)
}
