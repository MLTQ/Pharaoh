use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::models::ScriptRow;
use crate::error::Result;

fn projects_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .home_dir()
        .expect("no home dir")
        .join("pharaoh-projects")
}

#[tauri::command]
pub fn read_script(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
) -> Result<Vec<ScriptRow>> {
    let path = projects_dir(&app)
        .join(&project_id)
        .join("scenes")
        .join(&scene_slug)
        .join("script.csv");

    if !path.exists() {
        return Ok(vec![]);
    }

    let mut reader = csv::Reader::from_path(&path)?;
    let mut rows = vec![];
    for result in reader.deserialize() {
        let row: ScriptRow = result?;
        rows.push(row);
    }
    Ok(rows)
}

#[tauri::command]
pub fn write_script(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    rows: Vec<ScriptRow>,
) -> Result<()> {
    let path = projects_dir(&app)
        .join(&project_id)
        .join("scenes")
        .join(&scene_slug)
        .join("script.csv");

    let tmp_path = path.with_extension("csv.tmp");
    let mut writer = csv::Writer::from_path(&tmp_path)?;
    for row in &rows {
        writer.serialize(row)?;
    }
    writer.flush()?;
    std::fs::rename(&tmp_path, &path)?;
    Ok(())
}

#[tauri::command]
pub fn update_script_row(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    fields: std::collections::HashMap<String, String>,
) -> Result<ScriptRow> {
    let path = projects_dir(&app)
        .join(&project_id)
        .join("scenes")
        .join(&scene_slug)
        .join("script.csv");

    let mut rows: Vec<ScriptRow> = {
        let mut reader = csv::Reader::from_path(&path)?;
        reader.deserialize().collect::<csv::Result<_>>()?
    };

    let row = rows
        .get_mut(row_index)
        .ok_or_else(|| crate::error::Error::Other(format!("row {} out of range", row_index)))?;

    for (key, val) in &fields {
        match key.as_str() {
            "file" => row.file = val.clone(),
            "start_ms" => row.start_ms = val.clone(),
            "duration_ms" => row.duration_ms = val.clone(),
            "prompt" => row.prompt = val.clone(),
            "instruct" => row.instruct = val.clone(),
            "gain_db" => row.gain_db = val.clone(),
            "pan" => row.pan = val.clone(),
            "reverb_send" => row.reverb_send = val.clone(),
            "fade_in_ms" => row.fade_in_ms = val.clone(),
            "fade_out_ms" => row.fade_out_ms = val.clone(),
            "notes" => row.notes = val.clone(),
            _ => {}
        }
    }

    let updated = row.clone();

    let tmp_path = path.with_extension("csv.tmp");
    let mut writer = csv::Writer::from_path(&tmp_path)?;
    for r in &rows {
        writer.serialize(r)?;
    }
    writer.flush()?;
    std::fs::rename(&tmp_path, &path)?;

    Ok(updated)
}
