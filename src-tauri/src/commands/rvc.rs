//! RVC (Retrieval-based Voice Conversion) commands.
//!
//! This module provides the Tauri command surface for the RVC voice-conversion
//! pipeline. The pipeline works as follows:
//!
//! 1. Qwen3 VoiceDesign generates palette reference takes.
//! 2. Chatterbox generates a corpus of 50-100 WAVs with paralinguistic tags.
//! 3. The RVC training job consumes that corpus and produces a `.pth` model
//!    file plus an optional `.index` file stored in
//!    `characters/{character_id}/rvc/`.
//! 4. At production time: Chatterbox clones the voice → RVC converts it →
//!    final WAV.
//!
//! All heavy work runs inside the Python RVC server (default port 18006).
//! Commands here are thin HTTP proxies that match the pattern in
//! `inference.rs`: read the base URL from `AppState → server_config`, POST
//! a JSON body, and return the `job_id` immediately so the caller can poll.

use crate::app_support::app_projects_dir;
use crate::error::{Error, Result};
use crate::models::AppState;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, State};

// ── Data structures ───────────────────────────────────────────────────────

/// Metadata about a trained RVC model file found on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RvcModelInfo {
    /// Filename stem, e.g. `"jack_rourke"` (no extension).
    pub name: String,
    /// Absolute path to the `.pth` weights file.
    pub pth_path: String,
    /// Absolute path to the `.index` FAISS file, if present.
    pub index_path: Option<String>,
    /// Size of the `.pth` file in bytes.
    pub size_bytes: u64,
}

/// Parameters for a single RVC voice-conversion job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RvcConvertParams {
    /// Absolute path to the source audio file (Chatterbox output).
    pub input_path: String,
    /// Absolute path where the converted WAV should be written.
    pub output_path: String,
    /// Absolute path to the `.pth` RVC model file.
    pub model_path: String,
    /// Absolute path to the `.index` FAISS file (optional — speeds up
    /// timbre matching when present).
    pub index_path: Option<String>,
    /// Pitch shift in semitones (positive = up, negative = down).
    /// Default: `0`.
    pub pitch_shift: i32,
    /// F0 extraction algorithm. Default: `"rmvpe"`.
    pub f0_method: String,
    /// How strongly the index file influences the output timbre (0–1).
    /// Default: `0.5`.
    pub index_rate: f32,
    /// Median filter radius applied to F0. Default: `3`.
    pub filter_radius: u32,
    /// Mix ratio between source and converted RMS envelopes (0–1).
    /// Default: `0.25`.
    pub rms_mix_rate: f32,
    /// Consonant protection strength (0–0.5). Default: `0.33`.
    pub protect: f32,
}

/// Summary of the RVC training corpus for a character.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusStatus {
    /// Number of WAV files in the corpus directory.
    pub file_count: usize,
    /// Sum of `duration_ms` fields from sidecar `.meta.json` files.
    pub total_duration_ms: u64,
    /// Absolute path to the corpus directory scanned.
    pub corpus_dir: String,
    /// `true` when `total_duration_ms >= 5 * 60 * 1000` (five minutes).
    pub ready_for_training: bool,
}

// ── Internal helpers ──────────────────────────────────────────────────────

/// Extract the RVC server base URL from the current `ServerConfig`.
fn rvc_url(state: &AppState) -> Result<String> {
    let cfg = state
        .server_config
        .read()
        .map_err(|_| Error::Other("lock poisoned".into()))?;
    Ok(cfg.rvc_url.clone())
}

// ── Commands ──────────────────────────────────────────────────────────────

/// List trained RVC models available for a character.
///
/// Scans `<projects_dir>/<project_id>/characters/<character_id>/rvc/` for
/// `.pth` files. For each `.pth` found it checks whether a same-stem `.index`
/// file also exists.
#[tauri::command]
pub async fn list_rvc_models(
    app: AppHandle,
    project_id: String,
    character_id: String,
) -> Result<Vec<RvcModelInfo>> {
    let projects_dir = app_projects_dir(&app)?;
    let rvc_dir = projects_dir
        .join(&project_id)
        .join("characters")
        .join(&character_id)
        .join("rvc");

    if !rvc_dir.exists() {
        return Ok(Vec::new());
    }

    let mut models = Vec::new();
    let entries = std::fs::read_dir(&rvc_dir)?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pth") {
            continue;
        }
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let index_path = {
            let candidate = path.with_extension("index");
            if candidate.exists() {
                Some(candidate.to_string_lossy().into_owned())
            } else {
                None
            }
        };
        models.push(RvcModelInfo {
            name: stem,
            pth_path: path.to_string_lossy().into_owned(),
            index_path,
            size_bytes,
        });
    }

    Ok(models)
}

/// Submit a voice-conversion job to the RVC server.
///
/// Returns a `job_id` immediately. The caller should poll
/// [`get_rvc_job`] until the job reaches `"complete"` or `"failed"`.
#[tauri::command]
pub async fn submit_rvc_convert(
    _app: AppHandle,
    state: State<'_, AppState>,
    params: RvcConvertParams,
) -> Result<String> {
    let (base_url, http) = {
        let url = rvc_url(&state)?;
        (url, state.http.clone())
    };

    let resp: serde_json::Value = http
        .post(format!("{}/convert", base_url))
        .json(&params)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("RVC server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("RVC response error: {}", e)))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id in RVC convert response".into()))?
        .to_string();

    Ok(job_id)
}

/// Submit an RVC training job for a character.
///
/// The server reads audio from
/// `<projects_dir>/<project_id>/characters/<character_id>/rvc_corpus/` and
/// writes the resulting `.pth` / `.index` files to
/// `<projects_dir>/<project_id>/characters/<character_id>/rvc/`.
///
/// Returns a `job_id` immediately. Poll [`get_rvc_job`] for progress.
#[tauri::command]
pub async fn submit_rvc_train(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    character_id: String,
    character_name: String,
    epochs: Option<u32>,
) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    let corpus_dir = projects_dir
        .join(&project_id)
        .join("characters")
        .join(&character_id)
        .join("rvc_corpus");
    let output_dir = projects_dir
        .join(&project_id)
        .join("characters")
        .join(&character_id)
        .join("rvc");

    let (base_url, http) = {
        let url = rvc_url(&state)?;
        (url, state.http.clone())
    };

    let body = serde_json::json!({
        "character_id": character_id,
        "character_name": character_name,
        "corpus_dir": corpus_dir.to_string_lossy(),
        "output_dir": output_dir.to_string_lossy(),
        "epochs": epochs.unwrap_or(100),
    });

    let resp: serde_json::Value = http
        .post(format!("{}/train", base_url))
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("RVC server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("RVC response error: {}", e)))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id in RVC train response".into()))?
        .to_string();

    Ok(job_id)
}

/// Poll the status of an RVC job.
///
/// Returns the raw JSON payload from `GET /jobs/{job_id}` on the RVC server,
/// preserving any server-specific fields (e.g. `progress`, `output_path`,
/// `error`).
#[tauri::command]
pub async fn get_rvc_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<serde_json::Value> {
    let (base_url, http) = {
        let url = rvc_url(&state)?;
        (url, state.http.clone())
    };

    let resp: serde_json::Value = http
        .get(format!("{}/jobs/{}", base_url, job_id))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| Error::Other(format!("RVC poll error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("RVC poll parse error: {}", e)))?;

    Ok(resp)
}

/// Return the corpus status for a character.
///
/// Counts `.wav` files in
/// `<projects_dir>/<project_id>/characters/<character_id>/rvc_corpus/` and
/// sums `duration_ms` from any adjacent `.wav.meta.json` sidecar files.
/// A corpus is considered ready for training when it contains at least
/// five minutes of audio (`total_duration_ms >= 300_000`).
#[tauri::command]
pub async fn get_corpus_status(
    app: AppHandle,
    project_id: String,
    character_id: String,
) -> Result<CorpusStatus> {
    let projects_dir = app_projects_dir(&app)?;
    let corpus_dir = projects_dir
        .join(&project_id)
        .join("characters")
        .join(&character_id)
        .join("rvc_corpus");

    let corpus_dir_str = corpus_dir.to_string_lossy().into_owned();

    if !corpus_dir.exists() {
        return Ok(CorpusStatus {
            file_count: 0,
            total_duration_ms: 0,
            corpus_dir: corpus_dir_str,
            ready_for_training: false,
        });
    }

    let mut file_count: usize = 0;
    let mut total_duration_ms: u64 = 0;

    let entries = std::fs::read_dir(&corpus_dir)?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }
        file_count += 1;

        // Attempt to read duration from sidecar: <name>.wav.meta.json
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

    const MIN_TRAINING_MS: u64 = 5 * 60 * 1000; // 5 minutes
    Ok(CorpusStatus {
        file_count,
        total_duration_ms,
        corpus_dir: corpus_dir_str,
        ready_for_training: total_duration_ms >= MIN_TRAINING_MS,
    })
}
