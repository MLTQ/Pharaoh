use tauri::AppHandle;
use crate::app_support::{app_projects_dir, read_script_rows, script_path, update_script_row_fields, write_script_rows};
use crate::models::ScriptRow;
use crate::error::Result;

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
