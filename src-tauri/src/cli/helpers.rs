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
pub(super) async fn submit_job<T: Serialize>(
    http: &reqwest::Client,
    url: String,
    params: &T,
    label: &str,
) -> Result<String> {
    let resp: serde_json::Value = http
        .post(&url)
        .json(params)
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

    resp["job_id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Other(format!("{label} response from {url} missing job_id")))
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
            "complete" => return Ok(status),
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
    let Ok(reader) = hound::WavReader::open(path) else {
        return (None, 48000);
    };
    let spec = reader.spec();
    let samples = reader.duration() as u64;
    let channels = u64::from(spec.channels.max(1));
    let duration_ms = samples
        .checked_mul(1000)
        .and_then(|v| v.checked_div(channels))
        .and_then(|v| v.checked_div(u64::from(spec.sample_rate)));
    (duration_ms, spec.sample_rate)
}

pub(super) fn random_seed() -> i64 {
    (Utc::now().timestamp_nanos_opt().unwrap_or_default() % 100_000) as i64
}
