use tauri::AppHandle;
use crate::app_support::{app_projects_dir, read_script_rows, scene_dir, script_path, update_script_row_fields, write_script_rows};
use crate::models::ScriptRow;
use crate::error::{Error, Result};

#[tauri::command]
pub fn read_script(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
) -> Result<Vec<ScriptRow>> {
    let projects_dir = app_projects_dir(&app)?;
    read_script_rows(&script_path(&projects_dir, &project_id, &scene_slug))
}

#[tauri::command]
pub fn write_script(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    rows: Vec<ScriptRow>,
) -> Result<()> {
    let projects_dir = app_projects_dir(&app)?;
    write_script_rows(&script_path(&projects_dir, &project_id, &scene_slug), &rows)
}

#[tauri::command]
pub fn update_script_row(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    fields: std::collections::HashMap<String, String>,
) -> Result<ScriptRow> {
    let projects_dir = app_projects_dir(&app)?;
    update_script_row_fields(
        &script_path(&projects_dir, &project_id, &scene_slug),
        row_index,
        fields,
    )
}

// ── Fountain text persistence ─────────────────────────────────────────────
//
// The Fountain editor compiles to script.csv but the prose itself is what
// the writer actually edits — handwritten line breaks, scene-heading
// formatting, comments, structure that doesn't survive a CSV round-trip.
// Persist it next to script.csv so it survives reload, restart, and source
// control. Returns null when the file doesn't exist (untouched scenes).

fn fountain_path(projects_dir: &std::path::Path, project_id: &str, scene_slug: &str) -> std::path::PathBuf {
    scene_dir(projects_dir, project_id, scene_slug).join("script.fountain")
}

#[tauri::command]
pub fn read_fountain(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
) -> Result<Option<String>> {
    let projects_dir = app_projects_dir(&app)?;
    let path = fountain_path(&projects_dir, &project_id, &scene_slug);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| Error::Other(format!("read {}: {}", path.display(), e)))?;
    let s = String::from_utf8(bytes)
        .map_err(|e| Error::Other(format!("non-utf8 fountain at {}: {}", path.display(), e)))?;
    Ok(Some(s))
}

#[tauri::command]
pub fn write_fountain(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    text: String,
) -> Result<()> {
    let projects_dir = app_projects_dir(&app)?;
    let path = fountain_path(&projects_dir, &project_id, &scene_slug);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Atomic write: stage to a sibling .tmp then rename, so a crash mid-write
    // doesn't truncate the user's prose to zero bytes.
    let tmp = path.with_extension("fountain.tmp");
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| Error::Other(format!("write {}: {}", tmp.display(), e)))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| Error::Other(format!("rename {} → {}: {}", tmp.display(), path.display(), e)))?;
    Ok(())
}
