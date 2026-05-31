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

// Character bundle helpers — see app_support.md for the bundle layout contract.

pub fn character_dir(projects_dir: &Path, project_id: &str, character_id: &str) -> PathBuf {
    project_dir(projects_dir, project_id)
        .join("characters")
        .join(character_id)
}

/// Resolve a character-bundle asset path to an absolute filesystem path.
/// - If `path` is absolute, returned as-is (external Clip Studio refs etc.).
/// - If `path` is relative, joined onto `bundle_dir`.
///
/// Currently unused; future issue Pharaoh-vor (library import/export) and a
/// follow-up sweep will switch in-bundle path storage to relative and call this
/// at every job-submit site.
#[allow(dead_code)]
pub fn resolve_character_asset(bundle_dir: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        bundle_dir.join(p)
    }
}

/// If `abs_path` lies inside `bundle_dir`, return the path relative to the bundle.
/// Returns None for paths outside the bundle (e.g. external references).
///
/// Paired with [`resolve_character_asset`]; see that doc for context.
#[allow(dead_code)]
pub fn relativize_character_asset(bundle_dir: &Path, abs_path: &str) -> Option<String> {
    let p = PathBuf::from(abs_path);
    if !p.is_absolute() {
        return None;
    }
    p.strip_prefix(bundle_dir)
        .ok()
        .map(|rel| rel.to_string_lossy().into_owned())
}

/// Scan a `rvc_corpus/` directory: count `.wav` files and sum `duration_ms`
/// from any adjacent `<name>.wav.meta.json` sidecars.
/// Returns `(file_count, total_duration_ms)`. Missing dir → `(0, 0)`.
///
/// Shared between [`commands::rvc::get_corpus_status`] and the project-load
/// migration so corpus stats stay consistent regardless of caller.
pub fn scan_rvc_corpus_dir(corpus_dir: &Path) -> (u32, u64) {
    if !corpus_dir.exists() {
        return (0, 0);
    }
    let entries = match std::fs::read_dir(corpus_dir) {
        Ok(e) => e,
        Err(_) => return (0, 0),
    };

    let mut file_count: u32 = 0;
    let mut total_duration_ms: u64 = 0;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }
        file_count += 1;

        let meta_path = {
            let mut p = path.clone();
            let mut name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            name.push_str(".meta.json");
            p.set_file_name(name);
            p
        };

        if let Ok(raw) = std::fs::read_to_string(&meta_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(ms) = json["duration_ms"].as_u64() {
                    total_duration_ms += ms;
                } else if let Some(ms) = json["duration_actual_ms"].as_u64() {
                    total_duration_ms += ms;
                }
            }
        }
    }

    (file_count, total_duration_ms)
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
            "gain_envelope" => row.gain_envelope = val.clone(),
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

    // Auto-populate duration_ms from the WAV file whenever a file is assigned
    // and the caller didn't explicitly supply duration_ms. This means agents,
    // the MCP, and the UI never have to manually fill in duration — it's always
    // derived from ground truth.
    if fields.contains_key("file") && !fields.contains_key("duration_ms") {
        let file_path = row.file.trim().to_string();
        if !file_path.is_empty() {
            if let Ok(ms) = wav_duration_ms(&file_path) {
                row.duration_ms = ms.to_string();
            }
        }
    }

    let updated = row.clone();
    write_script_rows(path, &rows)?;
    Ok(updated)
}

/// Read a WAV file's duration in milliseconds without decoding samples —
/// computed from the header fields (sample_rate × total_frames).
fn wav_duration_ms(path: &str) -> Result<u64> {
    let reader = hound::WavReader::open(path)
        .map_err(|e| Error::Other(format!("cannot open WAV for duration: {}", e)))?;
    let spec = reader.spec();
    let total_frames = reader.duration() as u64; // frames (samples ÷ channels)
    let ms = total_frames * 1000 / spec.sample_rate as u64;
    Ok(ms)
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
    // Prefer the caller-supplied duration; fall back to reading from the WAV.
    let resolved_ms = duration_ms.or_else(|| wav_duration_ms(output_path).ok());
    if let Some(ms) = resolved_ms {
        row.duration_ms = ms.to_string();
    }

    write_script_rows(&path, &rows)?;
    Ok(true)
}
