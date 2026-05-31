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

use crate::app_support::{app_projects_dir, scan_rvc_corpus_dir};
use crate::commands;
use crate::error::{Error, Result};
use crate::models::{AppState, JobCompleteEvent, JobFailedEvent, JobProgressEvent, JobStatus};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

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
/// Returns a `job_id` immediately. When running against a remote server the
/// input file is uploaded first, and a background task polls for completion
/// and downloads the result. For local servers the caller polls via
/// [`get_rvc_job`] as before.
#[tauri::command]
pub async fn submit_rvc_convert(
    app: AppHandle,
    state: State<'_, AppState>,
    params: RvcConvertParams,
) -> Result<String> {
    let (base_url, http) = {
        let url = rvc_url(&state)?;
        (url, state.http.clone())
    };

    let is_remote = commands::inference::is_remote_url(&base_url);

    // Upload the input audio when running remotely.
    // model_path and index_path are server-side paths (produced by /train)
    // so they don't need uploading.
    // TODO: if the client ever supplies a local model_path/index_path for
    //       a remotely-run convert, upload those too.
    let server_input = if is_remote {
        commands::inference::upload_input_file(&http, &base_url, &params.input_path).await?
    } else {
        params.input_path.clone()
    };

    let body = serde_json::json!({
        "input_path":    server_input,
        "output_path":   if is_remote { String::new() } else { params.output_path.clone() },
        "model_path":    params.model_path,
        "index_path":    params.index_path,
        "pitch_shift":   params.pitch_shift,
        "f0_method":     params.f0_method,
        "index_rate":    params.index_rate,
        "filter_radius": params.filter_radius,
        "rms_mix_rate":  params.rms_mix_rate,
        "protect":       params.protect,
    });

    let resp: serde_json::Value = http
        .post(format!("{}/convert", base_url))
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
        .ok_or_else(|| Error::Other("missing job_id in RVC convert response".into()))?
        .to_string();

    if is_remote {
        tokio::spawn(poll_rvc_convert_until_done(
            app,
            http,
            base_url.clone(),
            format!("{}/jobs", base_url),
            job_id.clone(),
            params.output_path.clone(),
        ));
    }

    Ok(job_id)
}

/// Background poller for remote RVC convert jobs.
///
/// Downloads the converted file once the job completes and emits
/// `job-complete` / `job-failed` events. No script binding is performed
/// since RVC convert isn't bound to script rows.
async fn poll_rvc_convert_until_done(
    app: AppHandle,
    http: reqwest::Client,
    server_base_url: String,
    jobs_url: String,
    job_id: String,
    local_output_path: String,
) {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;

        let result = http
            .get(format!("{}/{}", jobs_url, job_id))
            .timeout(Duration::from_secs(5))
            .send()
            .await;

        let status: JobStatus = match result {
            Ok(r) => match r.json().await {
                Ok(s) => s,
                Err(e) => {
                    let _ = app.emit(
                        "job-failed",
                        &JobFailedEvent {
                            job_id: job_id.clone(),
                            model: "rvc".into(),
                            error: format!("parse error: {}", e),
                        },
                    );
                    return;
                }
            },
            Err(e) => {
                let _ = app.emit(
                    "job-failed",
                    &JobFailedEvent {
                        job_id: job_id.clone(),
                        model: "rvc".into(),
                        error: format!("poll error: {}", e),
                    },
                );
                return;
            }
        };

        let _ = app.emit(
            "job-progress",
            &JobProgressEvent {
                job_id: job_id.clone(),
                model: "rvc".into(),
                status: status.status.clone(),
                progress: status.progress,
            },
        );

        match status.status.as_str() {
            "complete" => {
                let server_out = status.output_path.unwrap_or_default();
                let final_path = if !server_out.is_empty() {
                    match commands::inference::download_remote_file_to(
                        &http,
                        &server_base_url,
                        &job_id,
                        &local_output_path,
                    )
                    .await
                    {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = app.emit(
                                "job-failed",
                                &JobFailedEvent {
                                    job_id: job_id.clone(),
                                    model: "rvc".into(),
                                    error: format!("download error: {}", e),
                                },
                            );
                            return;
                        }
                    }
                } else {
                    local_output_path.clone()
                };

                let _ = app.emit(
                    "job-complete",
                    &JobCompleteEvent {
                        job_id,
                        model: "rvc".into(),
                        output_path: final_path,
                        project_id: String::new(),
                        scene_slug: String::new(),
                        row_index: 0,
                        duration_ms: None,
                        bound_to_script: false,
                    },
                );
                return;
            }
            "failed" => {
                let _ = app.emit(
                    "job-failed",
                    &JobFailedEvent {
                        job_id: job_id.clone(),
                        model: "rvc".into(),
                        error: status.error.unwrap_or_else(|| "unknown error".into()),
                    },
                );
                return;
            }
            _ => {}
        }
    }
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
    let (file_count, total_duration_ms) = scan_rvc_corpus_dir(&corpus_dir);

    const MIN_TRAINING_MS: u64 = 5 * 60 * 1000; // 5 minutes
    Ok(CorpusStatus {
        file_count: file_count as usize,
        total_duration_ms,
        corpus_dir: corpus_dir_str,
        ready_for_training: total_duration_ms >= MIN_TRAINING_MS,
    })
}
