//! RVC (Retrieval-based Voice Conversion) commands.
//!
//! The Tauri command surface for the optional voice lock:
//!
//! 1. The corpus is the character's real lines (from a dissected recording
//!    or imported audio), in `characters/{id}/rvc_corpus/`.
//! 2. RVC trains on it, producing `rvc/{name}.pth` + `.index`.
//! 3. At production time the TTS engine (Breeze) clones the line, and calm
//!    lines pass through RVC (`submit_voice_lock`).
//!
//! All heavy work runs inside the Python RVC server (default port 18006).
//! Commands here are thin HTTP proxies that match the pattern in
//! `inference.rs`: read the base URL from `AppState → server_config`, POST
//! a JSON body, and return the `job_id` immediately so the caller can poll.

use crate::app_support::{app_projects_dir, character_dir, scan_rvc_corpus_dir};
use crate::commands;
use crate::error::{Error, Result};
use crate::models::{AppState, JobCompleteEvent, JobFailedEvent, JobProgressEvent, JobStatus, RvcConfig};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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
    /// Absolute path to the source audio file (a TTS take).
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
            true,
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
    remote: bool,
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
                let final_path = if remote && !server_out.is_empty() {
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
    let char_dir = character_dir(&projects_dir, &project_id, &character_id);
    let (base_url, http) = (rvc_url(&state)?, state.http.clone());
    let remote = commands::inference::is_remote_url(&base_url);

    let mut corpus: Vec<_> = std::fs::read_dir(char_dir.join("rvc_corpus"))
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav"))).collect())
        .unwrap_or_default();
    corpus.sort();
    if corpus.is_empty() {
        return Err(Error::Other("the corpus is empty — fill it from the recording first".into()));
    }
    // A remote server can't read this machine's files: send the corpus over.
    // Named per character so two characters' clips never overwrite each other.
    let mut corpus_paths = Vec::with_capacity(corpus.len());
    for p in &corpus {
        let local = p.to_string_lossy();
        corpus_paths.push(if remote {
            let name = format!("{}-corpus-{}", character_id, p.file_name().and_then(|n| n.to_str()).unwrap_or("clip.wav"));
            commands::inference::upload_file_as(&http, &base_url, &local, &name).await?
        } else {
            local.into_owned()
        });
    }
    // Locally the model lands straight in the bundle; a remote server keeps it
    // in its own models folder and `finish_rvc_train` fetches copies.
    let (model_out, index_out) = if remote {
        (String::new(), String::new())
    } else {
        let dir = char_dir.join("rvc");
        let name = sanitize_name(&character_name);
        (dir.join(format!("{name}.pth")).to_string_lossy().into_owned(), dir.join(format!("{name}.index")).to_string_lossy().into_owned())
    };

    let body = serde_json::json!({
        "corpus_paths": corpus_paths,
        "output_model_path": model_out,
        "output_index_path": index_out,
        "character_name": sanitize_name(&character_name),
        "sample_rate": 48000,
        "epochs": epochs.unwrap_or(100),
        "batch_size": 8,
    });
    let resp: serde_json::Value = http
        .post(format!("{}/train", base_url))
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| Error::Other(format!("RVC server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("RVC response error: {}", e)))?;
    resp["job_id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| Error::Other(format!("RVC train refused: {}", resp)))
}

fn sanitize_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '_' }).collect();
    if s.trim_matches('_').is_empty() { "voice".into() } else { s }
}

/// Where a character's model lives on the RVC server (`rvc/<stem>.server.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerModel {
    server: String,
    model_path: String,
    index_path: String,
}

fn server_model_file(pth: &Path) -> PathBuf {
    pth.with_extension("server.json")
}

/// After a remote training job completes: copy the model and its index into
/// the character's `rvc/` folder (so it travels with the bundle) and remember
/// where the server keeps them. A local server already wrote the bundle copy.
/// Returns the local `.pth` path.
#[tauri::command]
pub async fn finish_rvc_train(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    character_id: String,
    character_name: String,
    job_id: String,
) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    let dir = character_dir(&projects_dir, &project_id, &character_id).join("rvc");
    let (base_url, http) = (rvc_url(&state)?, state.http.clone());
    let name = sanitize_name(&character_name);
    let pth = dir.join(format!("{name}.pth"));
    if !commands::inference::is_remote_url(&base_url) {
        return Ok(pth.to_string_lossy().into_owned());
    }
    let job: serde_json::Value = http
        .get(format!("{}/jobs/{}", base_url, job_id))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("RVC poll error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("RVC poll parse error: {}", e)))?;
    let model_path = job["result"]["model_path"].as_str().unwrap_or_default().to_string();
    if job["status"] != "complete" || model_path.is_empty() {
        return Err(Error::Other(format!("training job {} hasn't produced a model ({})", job_id, job["status"])));
    }
    let index_path = job["result"]["index_path"].as_str().unwrap_or_default().to_string();
    std::fs::create_dir_all(&dir)?;
    download(&http, &format!("{}/files/{}", base_url, job_id), &pth).await?;
    let index = pth.with_extension("index");
    if !index_path.is_empty() {
        download(&http, &format!("{}/files/{}/index", base_url, job_id), &index).await?;
    } else {
        let _ = std::fs::remove_file(&index);
    }
    let rec = ServerModel { server: base_url, model_path, index_path };
    std::fs::write(server_model_file(&pth), serde_json::to_vec_pretty(&rec)?)?;
    Ok(pth.to_string_lossy().into_owned())
}

/// Stream a large file (an RVC index runs to hundreds of MB) to disk.
async fn download(http: &reqwest::Client, url: &str, to: &Path) -> Result<()> {
    use futures_util::StreamExt;
    let resp = http
        .get(url)
        .timeout(Duration::from_secs(1800))
        .send()
        .await
        .map_err(|e| Error::Other(format!("download {}: {}", url, e)))?;
    if !resp.status().is_success() {
        return Err(Error::Other(format!("download {}: HTTP {}", url, resp.status())));
    }
    let part = to.with_extension("part");
    let mut f = std::fs::File::create(&part)?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Error::Other(format!("download {}: {}", url, e)))?;
        std::io::Write::write_all(&mut f, &chunk)?;
    }
    drop(f);
    std::fs::rename(&part, to)?;
    Ok(())
}

// ── Voice lock ────────────────────────────────────────────────────────────

/// Words in a line or its direction that mark a delivery RVC flattens. In the
/// blind test (Breeze vs Breeze → RVC on five lines) the lock made calm lines
/// sound more like the character but took the edge off anger, the air out of
/// sighs and whispers, and some life out of laughs.
const EXPRESSIVE: &[&str] = &[
    "whisper", "hush", "murmur", "breath", "sigh", "laugh", "chuckl", "giggl", "snicker", "sob", "cry", "crying",
    "weep", "tear", "gasp", "scream", "shout", "yell", "bellow", "roar", "furious", "angry", "anger", "rage",
    "livid", "terrif", "panic", "afraid", "fear", "frighten", "hysteric",
];

/// Whether voice lock applies to a line: the character has it on and, unless
/// set to lock every line, the line is a calm one (no expressive direction,
/// no vocal events like `(laughs)` / `[sigh]` in the text).
pub fn locks_line(rvc: &RvcConfig, text: &str, direction: &str) -> bool {
    if !rvc.enabled {
        return false;
    }
    if rvc.lock_lines == "all" {
        return true;
    }
    let events = text.contains('(') || text.contains('[');
    let words = format!("{} {}", text, direction).to_lowercase();
    let expressive = words
        .split(|c: char| !c.is_ascii_alphabetic())
        .any(|w| !w.is_empty() && EXPRESSIVE.iter().any(|e| w.starts_with(e)));
    !(events || expressive)
}

/// The character's model: the configured `.pth` if it exists, else the first
/// in `rvc/`.
pub(crate) fn local_model(char_dir: &Path, rvc: &RvcConfig) -> Option<PathBuf> {
    if let Some(p) = rvc.model_path.as_deref().map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let mut pths: Vec<_> = std::fs::read_dir(char_dir.join("rvc"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pth"))
        .collect();
    pths.sort();
    pths.into_iter().next()
}

/// Model and index paths the RVC server can open. A remote server is sent
/// the bundle's copies once (an imported character, a wiped server) and the
/// paths are remembered beside the model.
pub(crate) async fn server_model_paths(
    http: &reqwest::Client,
    base_url: &str,
    character_id: &str,
    pth: &Path,
) -> Result<(String, String)> {
    let index = pth.with_extension("index");
    if !commands::inference::is_remote_url(base_url) {
        let idx = if index.is_file() { index.to_string_lossy().into_owned() } else { String::new() };
        return Ok((pth.to_string_lossy().into_owned(), idx));
    }
    let record = server_model_file(pth);
    if let Some(rec) = std::fs::read(&record).ok().and_then(|b| serde_json::from_slice::<ServerModel>(&b).ok()) {
        if rec.server == base_url && server_has(http, base_url, &rec.model_path).await {
            return Ok((rec.model_path, rec.index_path));
        }
    }
    let stem = pth.file_stem().and_then(|s| s.to_str()).unwrap_or("voice");
    let model_path = commands::inference::upload_file_as(http, base_url, &pth.to_string_lossy(), &format!("{character_id}-{stem}.pth")).await?;
    let index_path = if index.is_file() {
        commands::inference::upload_file_as(http, base_url, &index.to_string_lossy(), &format!("{character_id}-{stem}.index")).await?
    } else {
        String::new()
    };
    let rec = ServerModel { server: base_url.to_string(), model_path: model_path.clone(), index_path: index_path.clone() };
    std::fs::write(&record, serde_json::to_vec_pretty(&rec)?)?;
    Ok((model_path, index_path))
}

async fn server_has(http: &reqwest::Client, base_url: &str, model_path: &str) -> bool {
    let Some(dir) = Path::new(model_path).parent().map(|d| d.to_string_lossy().into_owned()) else { return false };
    let Ok(resp) = http.get(format!("{}/models", base_url)).query(&[("models_dir", dir)]).timeout(Duration::from_secs(10)).send().await else {
        return false;
    };
    resp.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v["models"].as_array().cloned())
        .is_some_and(|ms| ms.iter().any(|m| m["model_path"] == model_path))
}

/// The `/convert` body for a voice-lock pass. The input must already be a
/// path the server can read.
pub(crate) fn voice_lock_body(rvc: &RvcConfig, input: &str, output: &str, model: &str, index: &str) -> serde_json::Value {
    serde_json::json!({
        "input_path": input,
        "output_path": output,
        "model_path": model,
        "index_path": index,
        "pitch_shift": rvc.pitch_shift,
        "f0_method": "rmvpe",
        "index_rate": rvc.index_rate,
        "filter_radius": 3,
        "rms_mix_rate": 0.25,
        "protect": rvc.protect,
    })
}

/// Voice-lock a finished take: when the character has the lock on and the
/// line qualifies (see [`locks_line`]), convert `input_path` through the
/// character's RVC model into `<input>.lock.wav`. Returns the RVC job id, or
/// `None` when the line keeps the engine's take as-is. Completion arrives as
/// a `job-complete` event (model `"rvc"`).
#[tauri::command]
pub async fn submit_voice_lock(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    character_id: String,
    rvc: RvcConfig,
    input_path: String,
    text: String,
    direction: String,
) -> Result<Option<String>> {
    if !locks_line(&rvc, &text, &direction) {
        return Ok(None);
    }
    let projects_dir = app_projects_dir(&app)?;
    let char_dir = character_dir(&projects_dir, &project_id, &character_id);
    let Some(pth) = local_model(&char_dir, &rvc) else {
        return Err(Error::Other("voice lock is on but no model is trained — train one or turn it off".into()));
    };
    let (base_url, http) = (rvc_url(&state)?, state.http.clone());
    let remote = commands::inference::is_remote_url(&base_url);
    let (model, index) = server_model_paths(&http, &base_url, &character_id, &pth).await?;
    let output_path = lock_output_path(&input_path);
    let input = if remote { commands::inference::upload_input_file(&http, &base_url, &input_path).await? } else { input_path.clone() };
    let body = voice_lock_body(&rvc, &input, if remote { "" } else { &output_path }, &model, &index);
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
    let job_id = resp["job_id"].as_str().map(str::to_string).ok_or_else(|| Error::Other(format!("RVC convert refused: {}", resp)))?;
    tokio::spawn(poll_rvc_convert_until_done(app, http, base_url.clone(), format!("{}/jobs", base_url), job_id.clone(), output_path, remote));
    Ok(Some(job_id))
}

/// `take.wav` → `take.lock.wav`, beside the engine's take.
pub(crate) fn lock_output_path(input: &str) -> String {
    let p = Path::new(input);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("take");
    p.with_file_name(format!("{stem}.lock.wav")).to_string_lossy().into_owned()
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

/// The character's active RVC model plus the corpus it was trained from.
///
/// [`RvcModelInfo`] describes a file on disk; the Model stage also shows when
/// the model was trained and how much corpus audio went into it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RvcModelDetail {
    pub name: String,
    pub pth_path: String,
    pub index_path: Option<String>,
    pub pth_size_bytes: u64,
    /// RFC 3339 mtime of the `.pth` file.
    pub trained_at: String,
    /// WAV count currently in `rvc_corpus/`.
    pub corpus_count: usize,
    /// Summed duration of that corpus, in milliseconds.
    pub corpus_duration_ms: u64,
}

/// Return the character's trained RVC model, if one exists.
///
/// The Model stage shows a single active model per character; this is the
/// alphabetically first `.pth` found by [`list_rvc_models`], or `None` when the
/// character has not been trained yet.
#[tauri::command]
pub async fn get_rvc_model_info(
    app: AppHandle,
    project_id: String,
    character_id: String,
) -> Result<Option<RvcModelDetail>> {
    let projects_dir = app_projects_dir(&app)?;
    let corpus_dir = projects_dir
        .join(&project_id)
        .join("characters")
        .join(&character_id)
        .join("rvc_corpus");
    let (corpus_count, corpus_duration_ms) = scan_rvc_corpus_dir(&corpus_dir);

    let mut models = list_rvc_models(app, project_id, character_id).await?;
    // Stable pick, so repeated calls agree when a character has more than one
    // checkpoint on disk.
    models.sort_by(|a, b| a.name.cmp(&b.name));
    let Some(model) = models.into_iter().next() else {
        return Ok(None);
    };

    let trained_at = std::fs::metadata(&model.pth_path)
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_default();

    Ok(Some(RvcModelDetail {
        name: model.name,
        pth_path: model.pth_path,
        index_path: model.index_path,
        pth_size_bytes: model.size_bytes,
        trained_at,
        corpus_count: corpus_count as usize,
        corpus_duration_ms,
    }))
}

#[cfg(test)]
mod voice_lock_tests {
    use super::*;

    fn on(lines: &str) -> RvcConfig {
        RvcConfig { enabled: true, lock_lines: lines.into(), ..RvcConfig::default() }
    }

    #[test]
    fn calm_lines_get_the_lock_expressive_ones_keep_the_take() {
        let rvc = on("calm");
        assert!(locks_line(&rvc, "The ledger was exactly where she said it would be.", "Calm, even and conversational."));
        assert!(!locks_line(&rvc, "Don't move.", "Terrified whisper, breathless and close."));
        assert!(!locks_line(&rvc, "I kept the lamp lit.", "Quiet and heartbroken, with a tired sigh first."));
        assert!(!locks_line(&rvc, "No. Not after everything!", "Furious and hurt, voice rising."));
        assert!(!locks_line(&rvc, "You believed him?", "Delighted, laughing through the first words."));
        assert!(!locks_line(&rvc, "(laughs) Oh, wonderful.", ""), "vocal events in the text count");
        assert!(locks_line(&on("all"), "Don't move.", "Terrified whisper."));
        assert!(!locks_line(&RvcConfig::default(), "Calm line.", ""), "off unless turned on");
    }

    #[test]
    fn defaults_keep_the_blind_test_settings() {
        let d = RvcConfig::default();
        assert_eq!((d.index_rate, d.lock_lines.as_str(), d.enabled), (0.5, "calm", false));
        let old: RvcConfig = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!((old.index_rate, old.lock_lines.as_str()), (0.5, "calm"));
    }

    #[test]
    fn lock_output_sits_beside_the_take() {
        assert_eq!(lock_output_path("/p/scenes/s/assets/dumbledore_1.wav"), "/p/scenes/s/assets/dumbledore_1.lock.wav");
    }
}
