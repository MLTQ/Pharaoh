//! Shared CLI plumbing: JSON output, `--flag value` parsing, project and
//! storyboard loading with agent-friendly error context, and inference-job
//! submit/poll loops used by every generation command.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

use crate::app_support::{project_dir, read_json, write_json};
use crate::error::{Error, Result};
use crate::models::{Project, Scene, Storyboard};

/// Pretty-print any serializable value to stdout. All successful commands
/// emit JSON through this single chokepoint.
pub(super) fn print_json<T: Serialize>(value: &T) -> Result<()> {
    let output = serde_json::to_string_pretty(value)?;
    println!("{output}");
    Ok(())
}

pub(super) fn parse_flags(rest: &[String]) -> Result<HashMap<String, String>> {
    let mut flags = HashMap::new();
    let mut i = 0usize;
    while i < rest.len() {
        let key = rest[i].as_str();
        if !key.starts_with("--") {
            return Err(Error::Other(format!("expected flag, got {}", key)));
        }
        let name = key.trim_start_matches("--").replace('-', "_");
        i += 1;
        let value = rest
            .get(i)
            .cloned()
            .ok_or_else(|| Error::Other(format!("missing value for {}", key)))?;
        flags.insert(name, value);
        i += 1;
    }
    Ok(flags)
}

pub(super) fn flag_string(flags: &HashMap<String, String>, key: &str, default: &str) -> String {
    flags.get(key).cloned().unwrap_or_else(|| default.into())
}

pub(super) fn flag_opt(flags: &HashMap<String, String>, key: &str) -> Option<String> {
    flags.get(key).cloned().filter(|value| !value.is_empty())
}

pub(super) fn flag_parse<T: std::str::FromStr>(
    flags: &HashMap<String, String>,
    key: &str,
    default: T,
) -> Result<T> {
    match flags.get(key) {
        Some(value) => value
            .parse::<T>()
            .map_err(|_| Error::Other(format!("invalid --{} value", key.replace('_', "-")))),
        None => Ok(default),
    }
}

/// Load `project.json`, failing with the project id, the directory that was
/// searched, and a `pharaoh project list` hint instead of a raw io error.
pub(super) fn load_project(config: &crate::models::AppConfig, project_id: &str) -> Result<Project> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = project_dir(&projects_dir, project_id).join("project.json");
    if !path.exists() {
        return Err(Error::Other(format!(
            "project {} not found in {} — run `pharaoh project list` to see available project ids",
            project_id,
            projects_dir.display()
        )));
    }
    read_json(&path).map_err(|e| {
        Error::Other(format!(
            "cannot read project {} ({}): {}",
            project_id,
            path.display(),
            e
        ))
    })
}

pub(super) fn save_project(config: &crate::models::AppConfig, mut project: Project) -> Result<()> {
    project.updated_at = Utc::now();
    let projects_dir = PathBuf::from(&config.projects_dir);
    write_json(
        &project_dir(&projects_dir, &project.id).join("project.json"),
        &project,
    )
}

/// Load `storyboard.json`, failing with the project id and path when the
/// file is missing or unreadable. Callers that treat a missing storyboard as
/// empty should keep their `path.exists()` check instead.
pub(super) fn load_storyboard(projects_dir: &Path, project_id: &str) -> Result<Storyboard> {
    let path = project_dir(projects_dir, project_id).join("storyboard.json");
    if !path.exists() {
        return Err(Error::Other(format!(
            "project {} has no storyboard.json at {} — run `pharaoh project list` to verify the project id",
            project_id,
            path.display()
        )));
    }
    read_json(&path).map_err(|e| {
        Error::Other(format!(
            "cannot read storyboard for project {} ({}): {}",
            project_id,
            path.display(),
            e
        ))
    })
}

pub(super) fn update_project_timestamp(
    config: &crate::models::AppConfig,
    project_id: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = project_dir(&projects_dir, project_id).join("project.json");
    let mut project: Project = read_json(&path).map_err(|e| {
        Error::Other(format!(
            "cannot read project {} ({}): {}",
            project_id,
            path.display(),
            e
        ))
    })?;
    project.updated_at = Utc::now();
    write_json(&path, &project)
}

pub(super) fn find_scene<'a>(storyboard: &'a Storyboard, scene_ref: &str) -> Option<&'a Scene> {
    storyboard
        .scenes
        .iter()
        .find(|scene| scene.slug == scene_ref || scene.id == scene_ref)
}

pub(super) fn find_scene_mut<'a>(
    storyboard: &'a mut Storyboard,
    scene_ref: &str,
) -> Option<&'a mut Scene> {
    storyboard
        .scenes
        .iter_mut()
        .find(|scene| scene.slug == scene_ref || scene.id == scene_ref)
}

/// Build the standard "scene not found" error with a `pharaoh scene list`
/// hint, so every command that resolves a scene reports it the same way.
pub(super) fn scene_not_found(scene_ref: &str, project_id: &str) -> Error {
    Error::Other(format!(
        "scene {} not found in project {} — run `pharaoh scene list {}` to see scene slugs",
        scene_ref, project_id, project_id
    ))
}

/// POST a generation request to an inference server and return the job id.
/// Local output path per remote job id: a remote server can't write into
/// this Mac's projects folder, so `submit_job` blanks `output_path` and
/// `poll_job` downloads the result here when the job completes.
fn pending_downloads() -> &'static std::sync::Mutex<HashMap<String, String>> {
    static P: std::sync::OnceLock<std::sync::Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    P.get_or_init(Default::default)
}

/// `http://host:port` of a job URL.
fn base_of(url: &str) -> String {
    let after = url.find("://").map(|i| i + 3).unwrap_or(0);
    match url[after..].find('/') {
        Some(j) => url[..after + j].to_string(),
        None => url.to_string(),
    }
}

/// Input-file fields a remote server needs uploaded first.
const UPLOAD_FIELDS: [&str; 5] = ["ref_audio_path", "reference_audio_path", "input_path", "audio_path", "source_path"];

pub(super) async fn submit_job<T: Serialize>(
    http: &reqwest::Client,
    url: String,
    params: &T,
    label: &str,
) -> Result<String> {
    let mut body = serde_json::to_value(params)?;
    let base = base_of(&url);
    let mut local_out: Option<String> = None;
    if crate::commands::inference::is_remote_url(&base) {
        if let Some(obj) = body.as_object_mut() {
            for f in UPLOAD_FIELDS {
                if let Some(serde_json::Value::String(p)) = obj.get(f).cloned() {
                    if !p.is_empty() && std::path::Path::new(&p).is_file() {
                        let server = crate::commands::inference::upload_input_file(http, &base, &p).await?;
                        obj.insert(f.to_string(), serde_json::Value::String(server));
                    }
                }
            }
            if let Some(serde_json::Value::String(o)) = obj.get("output_path").cloned() {
                if !o.is_empty() {
                    local_out = Some(o);
                    obj.insert("output_path".into(), serde_json::Value::String(String::new()));
                }
            }
        }
    }
    let resp: serde_json::Value = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "{label} server request to {url} failed: {e} — check `pharaoh server health` and `pharaoh server config`"
            ))
        })?
        .json()
        .await
        .map_err(|e| Error::Other(format!("{label} response from {url} was not valid JSON: {e}")))?;

    let job_id = resp["job_id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Other(format!("{label} response from {url} missing job_id: {resp}")))?;
    if let Some(o) = local_out {
        if let Ok(mut m) = pending_downloads().lock() {
            m.insert(job_id.clone(), o);
        }
    }
    Ok(job_id)
}

/// Poll a submitted job until it completes or fails.
pub(super) async fn poll_job(
    http: &reqwest::Client,
    jobs_url: String,
    job_id: &str,
    label: &str,
) -> Result<crate::models::JobStatus> {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let status = http
            .get(format!("{jobs_url}/{job_id}"))
            .send()
            .await
            .map_err(|e| {
                Error::Other(format!(
                    "{label} poll error for job {job_id} at {jobs_url}: {e}"
                ))
            })?
            .json::<crate::models::JobStatus>()
            .await
            .map_err(|e| {
                Error::Other(format!(
                    "{label} poll parse error for job {job_id} at {jobs_url}: {e}"
                ))
            })?;

        match status.status.as_str() {
            "complete" => {
                let local = pending_downloads().lock().ok().and_then(|mut m| m.remove(job_id));
                let mut status = status;
                if let Some(local) = local {
                    let path = crate::commands::inference::download_remote_file_to(http, &base_of(&jobs_url), job_id, &local)
                        .await
                        .map_err(|e| Error::Other(format!("{label} job {job_id} finished but its output couldn't be downloaded: {e}")))?;
                    status.output_path = Some(path);
                }
                return Ok(status);
            }
            "failed" => {
                return Err(Error::Other(
                    status
                        .error
                        .unwrap_or_else(|| format!("{label} generation failed (job {job_id})")),
                ))
            }
            _ => {}
        }
    }
}

/// Best-effort duration/sample-rate probe for a WAV on disk. Returns
/// `(None, 48000)` when the file cannot be opened.
pub(super) fn cli_wav_info(path: &str) -> (Option<u64>, u32) {
    match crate::app_support::wav_info(path) {
        Ok(info) => (info.duration_ms(), info.sample_rate),
        Err(_) => (None, 48000),
    }
}

pub(super) fn random_seed() -> i64 {
    (Utc::now().timestamp_nanos_opt().unwrap_or_default() % 100_000) as i64
}
