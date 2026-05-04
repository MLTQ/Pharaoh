use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::models::{AppConfig, AppState, ScriptRow};

const APP_CONFIG_DIR_NAME: &str = "ai.aureum.pharaoh";

pub fn default_config_path() -> Result<PathBuf> {
    let base_dir = dirs::config_dir()
        .ok_or_else(|| Error::Other("could not resolve config directory".into()))?;
    Ok(base_dir.join(APP_CONFIG_DIR_NAME).join("config.json"))
}

pub fn load_or_default_app_config(config_path: &Path) -> Result<AppConfig> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Other("could not resolve home directory".into()))?;

    if !config_path.exists() {
        return Ok(AppConfig::with_home(&home));
    }

    let raw = std::fs::read_to_string(config_path)?;
    serde_json::from_str(&raw).or_else(|_| Ok(AppConfig::with_home(&home)))
}

pub fn ensure_app_dirs(config: &AppConfig) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    if !projects_dir.exists() {
        std::fs::create_dir_all(&projects_dir)?;
    }

    let models_dir = PathBuf::from(&config.models_dir);
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir)?;
    }

    Ok(())
}

pub fn state_projects_dir(state: &AppState) -> Result<PathBuf> {
    let cfg = state
        .app_config
        .read()
        .map_err(|_| Error::Other("app_config lock poisoned".into()))?;
    Ok(PathBuf::from(&cfg.projects_dir))
}

pub fn app_projects_dir(app: &AppHandle) -> Result<PathBuf> {
    let state = app.state::<AppState>();
    state_projects_dir(&state)
}

pub fn project_dir(projects_dir: &Path, project_id: &str) -> PathBuf {
    projects_dir.join(project_id)
}

pub fn scene_dir(projects_dir: &Path, project_id: &str, scene_slug: &str) -> PathBuf {
    project_dir(projects_dir, project_id)
        .join("scenes")
        .join(scene_slug)
}

pub fn script_path(projects_dir: &Path, project_id: &str, scene_slug: &str) -> PathBuf {
    scene_dir(projects_dir, project_id, scene_slug).join("script.csv")
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let data = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&data)?)
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(value)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, json)?;
    Ok(())
}

pub fn read_script_rows(path: &Path) -> Result<Vec<ScriptRow>> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let mut reader = csv::Reader::from_path(path)?;
    let mut rows = vec![];
    for result in reader.deserialize() {
        let row: ScriptRow = result?;
        rows.push(row);
    }
    Ok(rows)
}

pub fn write_script_rows(path: &Path, rows: &[ScriptRow]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp_path = path.with_extension("csv.tmp");
    let mut writer = csv::Writer::from_path(&tmp_path)?;
    for row in rows {
        writer.serialize(row)?;
    }
    writer.flush()?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

pub fn apply_script_row_fields(row: &mut ScriptRow, fields: &HashMap<String, String>) {
    for (key, val) in fields {
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
}

pub fn update_script_row_fields(
    path: &Path,
    row_index: usize,
    fields: HashMap<String, String>,
) -> Result<ScriptRow> {
    let mut rows = read_script_rows(path)?;
    let row = rows
        .get_mut(row_index)
        .ok_or_else(|| Error::Other(format!("row {} out of range", row_index)))?;

    apply_script_row_fields(row, &fields);
    let updated = row.clone();
    write_script_rows(path, &rows)?;
    Ok(updated)
}

pub fn bind_generated_asset(
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    output_path: &str,
    duration_ms: Option<u64>,
) -> Result<bool> {
    let path = script_path(projects_dir, project_id, scene_slug);
    if !path.exists() {
        return Ok(false);
    }

    let mut rows = read_script_rows(&path)?;
    let Some(row) = rows.get_mut(row_index) else {
        return Ok(false);
    };

    if !row.file.trim().is_empty() && row.file != output_path {
        return Ok(false);
    }

    row.file = output_path.to_string();
    if let Some(ms) = duration_ms {
        row.duration_ms = ms.to_string();
    }

    write_script_rows(&path, &rows)?;
    Ok(true)
}
