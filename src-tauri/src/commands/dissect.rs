//! Dissect commands — lift voices out of an existing audio drama.
//!
//! The Python dissect server (default port 18007) separates the source into
//! dialogue / music / effects, diarizes and transcribes the dialogue, and picks
//! clean solo reference clips per speaker. Each run is an *import*: a
//! self-contained directory under `<projects_dir>/_library/imports/<import_id>/`
//! holding `import.json` (our bookkeeping), and — once the job completes —
//! `manifest.json`, `stems/` and `candidates/` exactly as the server wrote them.
//!
//! Same-machine servers write the import directory in place. Remote servers
//! write to their own scratch dir; `dissect_status` downloads the finished
//! directory as a zip and unpacks it here.
//!
//! `dissect_assign_speaker` turns a speaker into (or onto) a Library character.
//! It refuses unless the caller passes `rights_confirmed = true`, and it stamps
//! a [`VoiceProvenance`] record on the character naming the source recording and
//! the statement the user agreed to.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::app_support::{
    absolutize_voice_paths, app_projects_dir, library_character_dir, read_json,
    relativize_voice_paths, write_json, LIBRARY_DIR_NAME,
};
use crate::commands::inference::is_remote_url;
use crate::error::{Error, Result};
use crate::models::{
    AppState, Character, VoiceAssignment, VoiceProvenance, CURRENT_CHARACTER_SCHEMA,
};

const IMPORT_FILE: &str = "import.json";
const MANIFEST_FILE: &str = "manifest.json";
const LIBRARY_BUNDLE_FILE: &str = "character.json";

/// Default statement shown next to the rights checkbox. The UI may send its
/// own wording; whatever is sent is what gets recorded.
pub const DEFAULT_RIGHTS_STATEMENT: &str = "I own this recording or have permission from the \
performer to clone this voice, and I will not use it to impersonate them.";

// ── Types ─────────────────────────────────────────────────────────────────

/// Options forwarded to the server's `/generate/dissect`. All optional so the
/// frontend can send only what the user changed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DissectOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub separate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_candidates: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_clip_s: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_clip_s: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_minutes: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_threshold: Option<f32>,
}

/// Our bookkeeping for one import, persisted as `import.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DissectImport {
    pub import_id: String,
    pub job_id: String,
    pub source_path: String,
    pub source_name: String,
    pub server_url: String,
    pub remote: bool,
    /// "running" | "complete" | "failed" | "cancelled"
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: String,
    /// What the run was started with, so a retry repeats it exactly.
    #[serde(default)]
    pub options: DissectOptions,
    /// First failed poll in the current run of failures (RFC 3339). Cleared on
    /// the next successful poll; after UNREACHABLE_GRACE the import fails.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreachable_since: Option<String>,
}

/// How long a running import may go without reaching its server before it is
/// marked failed (and offered a Retry) instead of polling forever.
const UNREACHABLE_GRACE_SECS: i64 = 120;

/// Poll result for `dissect_status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DissectStatus {
    pub import_id: String,
    pub status: String,
    pub progress: f32,
    pub message: Option<String>,
    pub error: Option<String>,
    /// Absolute import directory; manifest paths are relative to it.
    pub import_dir: String,
    /// The server manifest, present once `status == "complete"`.
    pub manifest: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DissectImportSummary {
    pub import_id: String,
    pub source_name: String,
    pub status: String,
    pub created_at: String,
    pub speaker_count: Option<usize>,
    pub duration_s: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignSpeakerRequest {
    pub import_id: String,
    pub speaker_id: String,
    /// Candidate ids (e.g. "S2_c1") to copy into the character.
    pub candidate_ids: Vec<String>,
    /// Which of `candidate_ids` becomes the gold clone reference. Defaults to
    /// the first one when the character has no gold yet.
    #[serde(default)]
    pub gold_candidate_id: Option<String>,
    /// Attach to this existing Library character...
    #[serde(default)]
    pub library_id: Option<String>,
    /// ...or create a new one with this name.
    #[serde(default)]
    pub new_name: Option<String>,
    pub rights_confirmed: bool,
    #[serde(default)]
    pub rights_statement: Option<String>,
    /// Performer of this voice, if known — recorded on the provenance entry.
    #[serde(default)]
    pub performer: Option<String>,
}

// ── Paths + helpers ───────────────────────────────────────────────────────

pub fn imports_root(projects_dir: &Path) -> PathBuf {
    projects_dir.join(LIBRARY_DIR_NAME).join("imports")
}

fn import_dir(projects_dir: &Path, import_id: &str) -> Result<PathBuf> {
    // import ids are uuids we minted; reject anything else so a crafted id
    // can't point the delete/read commands outside the imports root.
    if Uuid::parse_str(import_id).is_err() {
        return Err(Error::Other(format!("invalid import id '{}'", import_id)));
    }
    Ok(imports_root(projects_dir).join(import_id))
}

fn dissect_url(app: &AppHandle) -> Result<String> {
    let state = app.state::<AppState>();
    let cfg = state
        .server_config
        .read()
        .map_err(|_| Error::Other("lock poisoned".into()))?;
    Ok(cfg.dissect_url.clone())
}

fn http(app: &AppHandle) -> reqwest::Client {
    app.state::<AppState>().http.clone()
}

/// Upload with a timeout sized for whole episodes rather than short refs.
async fn upload_source(http: &reqwest::Client, base_url: &str, local_path: &str) -> Result<String> {
    let bytes = tokio::fs::read(local_path)
        .await
        .map_err(|e| Error::Other(format!("read source '{}': {}", local_path, e)))?;
    // Unique per upload: two imports of the same file used to share one
    // uploads/ path, and the first to finish deleted the other's input.
    let filename = format!(
        "{}_{}",
        &Uuid::new_v4().simple().to_string()[..8],
        Path::new(local_path).file_name().and_then(|n| n.to_str()).unwrap_or("source.wav")
    );
    let resp: Value = http
        .post(format!("{}/upload", base_url))
        .query(&[("filename", &filename)])
        .body(bytes)
        .header("content-type", "application/octet-stream")
        .timeout(Duration::from_secs(30 * 60))
        .send()
        .await
        .map_err(|e| Error::Other(format!("upload to {}: {}", base_url, e)))?
        .error_for_status()
        .map_err(|e| Error::Other(format!("upload rejected: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("upload response parse: {}", e)))?;
    resp["server_path"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| Error::Other("upload response missing server_path".into()))
}

/// Unpack the server's zip bundle into `dest`, refusing entries that would
/// escape it.
fn unpack_bundle(zip_path: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| Error::Other(format!("dissect bundle is not a zip: {}", e)))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| Error::Other(format!("dissect bundle entry {}: {}", i, e)))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut f)?;
    }
    Ok(())
}

fn read_manifest(dir: &Path) -> Result<Option<Value>> {
    let p = dir.join(MANIFEST_FILE);
    if !p.is_file() {
        return Ok(None);
    }
    Ok(Some(read_json(&p)?))
}

// ── Background result download ────────────────────────────────────────────

#[derive(Debug, Clone)]
enum DownloadState {
    Running { done: u64, total: u64 },
    Failed(String),
}

fn download_map() -> &'static std::sync::Mutex<HashMap<String, DownloadState>> {
    static M: std::sync::OnceLock<std::sync::Mutex<HashMap<String, DownloadState>>> = std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn download_state(import_id: &str) -> Option<DownloadState> {
    download_map().lock().ok()?.get(import_id).cloned()
}

fn set_download(import_id: &str, st: DownloadState) {
    if let Ok(mut m) = download_map().lock() {
        m.insert(import_id.to_string(), st);
    }
}

fn clear_download(import_id: &str) {
    if let Ok(mut m) = download_map().lock() {
        m.remove(import_id);
    }
}

fn fmt_bytes_progress(done: u64, total: u64) -> String {
    let gb = |b: u64| b as f64 / 1e9;
    if total > 0 { format!("{:.1} / {:.1} GB", gb(done), gb(total)) } else { format!("{:.1} GB", gb(done)) }
}

/// Stream the server's zip to `<import>/.bundle.zip.part`, unpack, delete.
/// One per import (guarded by the map). Transient failures retry; a 404 —
/// the server no longer has the results — fails the import with that reason.
fn start_download(http: reqwest::Client, import: DissectImport, dir: PathBuf) {
    set_download(&import.import_id, DownloadState::Running { done: 0, total: 0 });
    tokio::spawn(async move {
        let id = import.import_id.clone();
        let url = format!("{}/files/{}", import.server_url, import.job_id);
        let part = dir.join(".bundle.zip.part");
        let mut last_err = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            match download_once(&http, &url, &part, &id).await {
                Ok(()) => {
                    let (p, d) = (part.clone(), dir.clone());
                    let unpacked = tokio::task::spawn_blocking(move || unpack_bundle(&p, &d)).await;
                    let _ = std::fs::remove_file(&part);
                    match unpacked {
                        Ok(Ok(())) => {
                            clear_download(&id);
                            return;
                        }
                        Ok(Err(e)) => last_err = e.to_string(),
                        Err(e) => last_err = format!("unpack task: {}", e),
                    }
                }
                Err((fatal, e)) => {
                    let _ = std::fs::remove_file(&part);
                    last_err = e;
                    if fatal {
                        break;
                    }
                }
            }
        }
        set_download(&id, DownloadState::Failed(format!("Couldn't download the results: {}", last_err)));
    });
}

/// Err((fatal, message)): fatal when retrying can't help (404).
async fn download_once(http: &reqwest::Client, url: &str, part: &Path, id: &str) -> std::result::Result<(), (bool, String)> {
    use tokio::io::AsyncWriteExt;
    let mut resp = http
        .get(url)
        .timeout(Duration::from_secs(6 * 60 * 60))
        .send()
        .await
        .map_err(|e| (false, e.to_string()))?;
    if resp.status().as_u16() == 404 {
        return Err((true, "the server no longer has this job's results (it may have been restarted or cleaned up) — Retry the import".into()));
    }
    let resp_status = resp.status();
    if !resp_status.is_success() {
        return Err((false, format!("HTTP {}", resp_status)));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(part).await.map_err(|e| (true, format!("write {}: {}", part.display(), e)))?;
    let mut done = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| (false, e.to_string()))? {
        file.write_all(&chunk).await.map_err(|e| (true, format!("write {}: {}", part.display(), e)))?;
        done += chunk.len() as u64;
        set_download(id, DownloadState::Running { done, total });
    }
    file.flush().await.map_err(|e| (true, e.to_string()))?;
    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Start dissecting `source_path`. Returns the new import (status "running").
#[tauri::command]
pub async fn dissect_submit(
    app: AppHandle,
    source_path: String,
    options: Option<DissectOptions>,
) -> Result<DissectImport> {
    let projects_dir = app_projects_dir(&app)?;
    submit(&http(&app), &dissect_url(&app)?, &projects_dir, &source_path, options.unwrap_or_default()).await
}

/// Shared by the Tauri command and `pharaoh dissect run`.
pub async fn submit(
    http: &reqwest::Client,
    base: &str,
    projects_dir: &Path,
    source_path: &str,
    options: DissectOptions,
) -> Result<DissectImport> {
    let source_path = source_path.to_string();
    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err(Error::Other(format!("source file not found: {}", source_path)));
    }
    let import_id = Uuid::new_v4().to_string();
    let dir = import_dir(projects_dir, &import_id)?;
    std::fs::create_dir_all(&dir)?;

    let base = base.trim_end_matches('/').to_string();
    let (job_id, remote) = match start_job(http, &base, &dir, &source_path, &options).await {
        Ok(v) => v,
        Err(e) => {
            // Nothing was started; don't leave an empty import behind.
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };

    let import = DissectImport {
        import_id,
        job_id,
        source_name: src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        source_path,
        server_url: base,
        remote,
        status: "running".into(),
        error: None,
        created_at: Utc::now().to_rfc3339(),
        options,
        unreachable_since: None,
    };
    write_json(&dir.join(IMPORT_FILE), &import)?;
    Ok(import)
}

/// Upload (when remote) and POST /generate/dissect. Returns (job_id, remote).
async fn start_job(
    http: &reqwest::Client,
    base: &str,
    dir: &Path,
    source_path: &str,
    options: &DissectOptions,
) -> Result<(String, bool)> {
    let remote = is_remote_url(base);
    let (input_path, output_path) = if remote {
        (upload_source(http, base, source_path).await?, String::new())
    } else {
        (source_path.to_string(), dir.to_string_lossy().into_owned())
    };

    let mut body = serde_json::to_value(options)?;
    let obj = body
        .as_object_mut()
        .ok_or_else(|| Error::Other("options must be an object".into()))?;
    obj.insert("input_path".into(), Value::String(input_path));
    obj.insert("output_path".into(), Value::String(output_path));

    let resp: Value = http
        .post(format!("{}/generate/dissect", base))
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "dissect server unreachable at {} ({}). Start it with ./inference/start_servers.sh",
                base, e
            ))
        })?
        .error_for_status()
        .map_err(|e| Error::Other(format!("dissect submit rejected: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("dissect submit response: {}", e)))?;
    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("dissect server returned no job_id".into()))?
        .to_string();
    Ok((job_id, remote))
}

/// Stop a running import. The server stops at its next checkpoint; the import
/// is marked cancelled locally right away so the UI doesn't wait on it, and a
/// server that can't be reached doesn't block the cancel.
#[tauri::command]
pub async fn dissect_cancel(app: AppHandle, import_id: String) -> Result<DissectImport> {
    cancel(&http(&app), &app_projects_dir(&app)?, &import_id).await
}

pub async fn cancel(http: &reqwest::Client, projects_dir: &Path, import_id: &str) -> Result<DissectImport> {
    let dir = import_dir(projects_dir, import_id)?;
    let path = dir.join(IMPORT_FILE);
    let mut import: DissectImport = read_json(&path)?;
    if import.status != "running" {
        return Err(Error::Other(format!("import is {}, not running", import.status)));
    }
    let _ = http
        .post(format!("{}/cancel/{}", import.server_url, import.job_id))
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    import.status = "cancelled".into();
    import.error = None;
    write_json(&path, &import)?;
    Ok(import)
}

/// Why a source can't be read, in words that point at the fix. A file on a
/// network mount (e.g. a fuse-t/NFS mount of the GPU box) can be briefly
/// unreachable, or blocked for this app by macOS — "it's gone" is wrong then.
fn source_readable(path: &str) -> Result<()> {
    let p = Path::new(path);
    match std::fs::metadata(p) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(Error::Other(format!("{} is not a file", path))),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Err(Error::Other(format!(
            "Pharaoh isn't allowed to read {} — on macOS, allow it under System Settings → Privacy & \
             Security → Files & Folders (Network Volumes), then Retry",
            path
        ))),
        Err(_) => {
            let parent_ok = p.parent().map(|d| d.is_dir()).unwrap_or(false);
            Err(Error::Other(if parent_ok {
                format!("the original recording is no longer at {} — it was moved or deleted; start a new import", path)
            } else {
                format!(
                    "can't reach {} — its folder isn't available (is a network drive unmounted?). Reconnect it, then Retry",
                    path
                )
            }))
        }
    }
}

/// Re-run a failed or cancelled import from its original source and options,
/// in place (same import id and directory), against the currently configured
/// dissect server.
#[tauri::command]
pub async fn dissect_retry(app: AppHandle, import_id: String) -> Result<DissectImport> {
    retry(&http(&app), &dissect_url(&app)?, &app_projects_dir(&app)?, &import_id).await
}

pub async fn retry(
    http: &reqwest::Client,
    base: &str,
    projects_dir: &Path,
    import_id: &str,
) -> Result<DissectImport> {
    let dir = import_dir(projects_dir, import_id)?;
    let path = dir.join(IMPORT_FILE);
    let mut import: DissectImport = read_json(&path)?;
    if !matches!(import.status.as_str(), "failed" | "cancelled") {
        return Err(Error::Other(format!("only failed or cancelled imports can be retried (this one is {})", import.status)));
    }
    source_readable(&import.source_path)?;
    let base = base.trim_end_matches('/').to_string();
    let (job_id, remote) = start_job(http, &base, &dir, &import.source_path, &import.options).await?;
    import.job_id = job_id;
    import.remote = remote;
    import.server_url = base;
    import.status = "running".into();
    import.error = None;
    import.unreachable_since = None;
    write_json(&path, &import)?;
    Ok(import)
}

/// Poll an import. On completion against a remote server, downloads and
/// unpacks the result bundle before reporting "complete".
#[tauri::command]
pub async fn dissect_status(app: AppHandle, import_id: String) -> Result<DissectStatus> {
    let projects_dir = app_projects_dir(&app)?;
    poll(&http(&app), &projects_dir, &import_id).await
}

/// Shared by the Tauri command and `pharaoh dissect status|run --wait`. The
/// server URL comes from `import.json`, so an import finishes against the
/// server it started on even if settings changed meanwhile.
pub async fn poll(http: &reqwest::Client, projects_dir: &Path, import_id: &str) -> Result<DissectStatus> {
    let dir = import_dir(projects_dir, import_id)?;
    let import_path = dir.join(IMPORT_FILE);
    let mut import: DissectImport = read_json(&import_path)?;

    let status = |import: &DissectImport, progress: f32, message: Option<String>, manifest| {
        DissectStatus {
            import_id: import.import_id.clone(),
            status: import.status.clone(),
            progress,
            message,
            error: import.error.clone(),
            import_dir: dir.to_string_lossy().into_owned(),
            manifest,
        }
    };

    match import.status.as_str() {
        "complete" => return Ok(status(&import, 1.0, None, read_manifest(&dir)?)),
        "failed" | "cancelled" => return Ok(status(&import, 0.0, None, None)),
        _ => {}
    }

    let job: Value = match http
        .get(format!("{}/jobs/{}", import.server_url, import.job_id))
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) if r.status().as_u16() == 404 => {
            // The server forgot the job (restart). A local run may still have
            // finished writing; otherwise the import is lost.
            if let Some(m) = read_manifest(&dir)? {
                import.status = "complete".into();
                write_json(&import_path, &import)?;
                return Ok(status(&import, 1.0, None, Some(m)));
            }
            import.status = "failed".into();
            import.error = Some("dissect server no longer knows this job (was it restarted?)".into());
            write_json(&import_path, &import)?;
            return Ok(status(&import, 0.0, None, None));
        }
        Ok(r) => r
            .json()
            .await
            .map_err(|e| Error::Other(format!("dissect job response: {}", e)))?,
        // Unreachable: keep polling through a short blip, then give up with a
        // message that says what probably happened and what to do.
        Err(_) => {
            let now = Utc::now();
            let since = import
                .unreachable_since
                .as_deref()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&Utc))
                .unwrap_or(now);
            let waited = (now - since).num_seconds();
            if waited >= UNREACHABLE_GRACE_SECS {
                import.status = "failed".into();
                import.unreachable_since = None;
                import.error = Some(format!(
                    "Lost contact with the dissect server at {} for {} minutes. It may have run out \
                     of memory, crashed, or been restarted (a restart loses running jobs). Start it \
                     again with ./inference/start_servers.sh, then Retry.",
                    import.server_url,
                    UNREACHABLE_GRACE_SECS / 60
                ));
                write_json(&import_path, &import)?;
                return Ok(status(&import, 0.0, None, None));
            }
            if import.unreachable_since.is_none() {
                import.unreachable_since = Some(now.to_rfc3339());
                write_json(&import_path, &import)?;
            }
            return Ok(status(
                &import,
                0.0,
                Some(format!(
                    "Can't reach the dissect server at {} — retrying ({}s of {}s)",
                    import.server_url, waited, UNREACHABLE_GRACE_SECS
                )),
                None,
            ));
        }
    };
    if import.unreachable_since.take().is_some() {
        write_json(&import_path, &import)?;
    }

    let progress = job["progress"].as_f64().unwrap_or(0.0) as f32;
    let message = job["message"].as_str().map(str::to_string);
    match job["status"].as_str().unwrap_or("pending") {
        "complete" => {
            if import.remote && read_manifest(&dir)?.is_none() {
                // Results come down in the background (a long book is tens of
                // GB); polls report progress instead of blocking for minutes.
                return Ok(match download_state(&import.import_id) {
                    Some(DownloadState::Running { done, total }) => status(
                        &import,
                        0.99,
                        Some(format!("Downloading results · {}", fmt_bytes_progress(done, total))),
                        None,
                    ),
                    Some(DownloadState::Failed(err)) => {
                        clear_download(&import.import_id);
                        import.status = "failed".into();
                        import.error = Some(err);
                        write_json(&import_path, &import)?;
                        status(&import, 0.0, None, None)
                    }
                    None => {
                        start_download(http.clone(), import.clone(), dir.clone());
                        status(&import, 0.99, Some("Downloading results…".into()), None)
                    }
                });
            }
            let manifest = read_manifest(&dir)?
                .ok_or_else(|| Error::Other("dissect finished but manifest.json is missing".into()))?;
            import.status = "complete".into();
            write_json(&import_path, &import)?;
            Ok(status(&import, 1.0, message, Some(manifest)))
        }
        "cancelled" => {
            import.status = "cancelled".into();
            write_json(&import_path, &import)?;
            Ok(status(&import, progress, message, None))
        }
        "failed" => {
            import.status = "failed".into();
            import.error = Some(
                job["error"]
                    .as_str()
                    .unwrap_or("dissect failed")
                    .to_string(),
            );
            write_json(&import_path, &import)?;
            Ok(status(&import, progress, message, None))
        }
        _ => Ok(status(&import, progress, message, None)),
    }
}

/// Every import on disk, newest first.
#[tauri::command]
pub fn list_dissect_imports(app: AppHandle) -> Result<Vec<DissectImportSummary>> {
    list_imports(&app_projects_dir(&app)?)
}

pub fn list_imports(projects_dir: &Path) -> Result<Vec<DissectImportSummary>> {
    let root = imports_root(projects_dir);
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(import) = read_json::<DissectImport>(&dir.join(IMPORT_FILE)) else {
            continue;
        };
        let manifest = read_manifest(&dir).ok().flatten();
        out.push(DissectImportSummary {
            speaker_count: manifest
                .as_ref()
                .and_then(|m| m["speakers"].as_array().map(Vec::len)),
            duration_s: manifest.as_ref().and_then(|m| m["duration_s"].as_f64()),
            import_id: import.import_id,
            source_name: import.source_name,
            status: import.status,
            created_at: import.created_at,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// Delete an import directory (stems, candidates, manifest). Characters that
/// already took clips from it keep their own copies.
#[tauri::command]
pub fn delete_dissect_import(app: AppHandle, import_id: String) -> Result<()> {
    delete_import(&app_projects_dir(&app)?, &import_id)
}

pub fn delete_import(projects_dir: &Path, import_id: &str) -> Result<()> {
    let dir = import_dir(projects_dir, import_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// Copy a speaker's chosen clips into a Library character (new or existing)
/// as clone-reference sources. Requires the rights confirmation.
#[tauri::command]
pub fn dissect_assign_speaker(app: AppHandle, request: AssignSpeakerRequest) -> Result<Character> {
    let projects_dir = app_projects_dir(&app)?;
    assign_speaker(&projects_dir, request)
}

pub fn assign_speaker(projects_dir: &Path, req: AssignSpeakerRequest) -> Result<Character> {
    if !req.rights_confirmed {
        return Err(Error::Other(
            "confirm you have the rights to clone this voice before importing it".into(),
        ));
    }
    if req.candidate_ids.is_empty() {
        return Err(Error::Other("pick at least one clip".into()));
    }
    let dir = import_dir(projects_dir, &req.import_id)?;
    let import: DissectImport = read_json(&dir.join(IMPORT_FILE))?;
    let manifest = read_manifest(&dir)?
        .ok_or_else(|| Error::Other("this import has not finished yet".into()))?;

    let speaker = manifest["speakers"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == req.speaker_id.as_str()))
        .ok_or_else(|| Error::Other(format!("speaker {} not in import", req.speaker_id)))?;
    let candidates = speaker["candidates"].as_array().cloned().unwrap_or_default();
    let find = |id: &str| candidates.iter().find(|c| c["id"] == id).cloned();

    // Resolve the target character.
    let (library_id, mut character) = match (&req.library_id, &req.new_name) {
        (Some(id), _) if !id.is_empty() => {
            let bundle = library_character_dir(projects_dir, id);
            let mut c: Character = read_json(&bundle.join(LIBRARY_BUNDLE_FILE))
                .map_err(|_| Error::Other(format!("library character {} not found", id)))?;
            absolutize_voice_paths(&mut c.voice_assignment, &bundle);
            (id.clone(), c)
        }
        (_, Some(name)) if !name.trim().is_empty() => {
            let id = Uuid::new_v4().to_string();
            (id.clone(), new_character(&id, name.trim(), &import.source_name, &req.speaker_id))
        }
        _ => return Err(Error::Other("choose an existing character or give a new name".into())),
    };
    let bundle = library_character_dir(projects_dir, &library_id);
    let slot = bundle.join("imports");
    std::fs::create_dir_all(&slot)?;

    let short = &req.import_id[..8];
    let mut copied: Vec<(String, PathBuf, String)> = Vec::new(); // (cand id, dest, transcript)
    for cid in &req.candidate_ids {
        let c = find(cid).ok_or_else(|| Error::Other(format!("clip {} not in speaker", cid)))?;
        let rel = c["path"]
            .as_str()
            .ok_or_else(|| Error::Other(format!("clip {} has no path", cid)))?;
        let src = dir.join(rel);
        if !src.starts_with(&dir) || !src.is_file() {
            return Err(Error::Other(format!("clip file missing: {}", src.display())));
        }
        let dest = slot.join(format!("dissect_{}_{}.wav", short, cid));
        std::fs::copy(&src, &dest)?;
        copied.push((
            cid.clone(),
            dest,
            c["transcript"].as_str().unwrap_or("").to_string(),
        ));
    }

    let va = &mut character.voice_assignment;
    for (_, dest, _) in &copied {
        let p = dest.to_string_lossy().into_owned();
        if !va.ref_audio_sources.contains(&p) {
            va.ref_audio_sources.push(p);
        }
    }
    let gold = req
        .gold_candidate_id
        .as_deref()
        .and_then(|g| copied.iter().find(|(cid, _, _)| cid == g))
        .or_else(|| {
            if va.ref_audio_path.is_none() {
                copied.first()
            } else {
                None
            }
        });
    if let Some((_, dest, transcript)) = gold {
        va.ref_audio_path = Some(dest.to_string_lossy().into_owned());
        va.ref_transcript = if transcript.is_empty() { None } else { Some(transcript.clone()) };
    }

    character.voice_provenance.push(VoiceProvenance {
        kind: "dissect".into(),
        source_name: import.source_name.clone(),
        import_id: req.import_id.clone(),
        speaker_id: req.speaker_id.clone(),
        clips: copied
            .iter()
            .map(|(_, d, _)| format!("imports/{}", d.file_name().unwrap().to_string_lossy()))
            .collect(),
        performer: req
            .performer
            .clone()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty()),
        rights_statement: req
            .rights_statement
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_RIGHTS_STATEMENT.to_string()),
        rights_confirmed_at: Utc::now().to_rfc3339(),
    });

    // Persist exactly like save_library_character: relative on disk.
    let now = Utc::now().to_rfc3339();
    character.id = library_id.clone();
    character.library_id = Some(library_id.clone());
    character.library_version = Some(now);
    character.schema_version = CURRENT_CHARACTER_SCHEMA;
    relativize_voice_paths(&mut character.voice_assignment, &bundle);
    write_json(&bundle.join(LIBRARY_BUNDLE_FILE), &character)?;
    absolutize_voice_paths(&mut character.voice_assignment, &bundle);
    Ok(character)
}

fn new_character(library_id: &str, name: &str, source_name: &str, speaker_id: &str) -> Character {
    Character {
        id: library_id.to_string(),
        name: name.to_string(),
        description: format!("Voice imported from {} ({}).", source_name, speaker_id),
        voice_assignment: VoiceAssignment {
            model: "Chatterbox".into(),
            speaker: None,
            instruct_default: None,
            ref_audio_path: None,
            ref_audio_sources: vec![],
            ref_transcript: None,
            base_voice_description: String::new(),
            emotional_palette: vec![],
            production_pipeline: "chatterbox".into(),
            rvc: None,
            rvc_model_path: None,
            rvc_index_path: None,
            rvc_pitch_shift: 0,
            rvc_index_rate: 0.5,
            rvc_protect: 0.33,
            rvc_enabled: false,
        },
        schema_version: CURRENT_CHARACTER_SCHEMA,
        library_id: Some(library_id.to_string()),
        library_version: None,
        voice_provenance: vec![],
    }
}

// ── Sounds: audition and extraction ───────────────────────────────────────

const STEMS: &[&str] = &["dialogue", "music", "effects"];

fn stem_file(dir: &Path, stem: &str) -> Result<PathBuf> {
    if !STEMS.contains(&stem) {
        return Err(Error::Other(format!("unknown stem '{}'", stem)));
    }
    for ext in ["flac", "wav"] {
        let p = dir.join("stems").join(format!("{}.{}", stem, ext));
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(Error::Other(format!("this import has no {} stem", stem)))
}

fn check_span(start: f64, end: f64) -> Result<()> {
    if !(start >= 0.0 && end > start && end - start <= 900.0) {
        return Err(Error::Other("span must be 0 ≤ start < end, at most 15 minutes".into()));
    }
    Ok(())
}

/// Cut `[start, end]` of a stem to 48 kHz / 24-bit stereo WAV with short fades.
fn cut(src: &Path, start: f64, end: f64, fade_s: f64, out: &Path) -> Result<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dur = end - start;
    let fade = fade_s.min(dur / 4.0);
    let filter = format!(
        "afade=t=in:st=0:d={f:.3},afade=t=out:st={o:.3}:d={f:.3}",
        f = fade,
        o = (dur - fade).max(0.0)
    );
    let res = std::process::Command::new("ffmpeg")
        .args(["-nostdin", "-loglevel", "error", "-y", "-ss", &format!("{:.3}", start), "-t", &format!("{:.3}", dur), "-i"])
        .arg(src)
        .args(["-af", &filter, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le"])
        .arg(out)
        .output()
        .map_err(|e| Error::Other(format!("could not run ffmpeg: {}", e)))?;
    if !res.status.success() {
        let err = String::from_utf8_lossy(&res.stderr);
        return Err(Error::Other(format!("clip cut failed: {}", &err[..err.len().min(500)])));
    }
    Ok(())
}

/// Audition file for a span of a stem, cached under the import's `clips/`.
#[tauri::command]
pub async fn dissect_clip(app: AppHandle, import_id: String, stem: String, start: f64, end: f64) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    tokio::task::spawn_blocking(move || clip_for(&projects_dir, &import_id, &stem, start, end))
        .await
        .map_err(|e| Error::Other(format!("clip task: {}", e)))?
}

pub fn clip_for(projects_dir: &Path, import_id: &str, stem: &str, start: f64, end: f64) -> Result<String> {
    check_span(start, end)?;
    let dir = import_dir(projects_dir, import_id)?;
    let src = stem_file(&dir, stem)?;
    let out = dir
        .join("clips")
        .join(format!("{}_{}_{}.wav", stem, (start * 1000.0) as i64, (end * 1000.0) as i64));
    if !out.is_file() {
        cut(&src, start, end, 0.01, &out)?;
    }
    Ok(out.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractSoundRequest {
    pub import_id: String,
    /// "effects" | "music" | "dialogue"
    pub stem: String,
    pub start: f64,
    pub end: f64,
    /// Human name, e.g. "Door · Knock" — becomes the file name and prompt.
    pub name: String,
    /// "sfx" | "ambience" | "music" | "vocal" — sets the asset kind.
    pub kind: String,
    pub project_id: String,
    pub scene_slug: String,
    /// AudioSet labels, recorded in the sidecar.
    #[serde(default)]
    pub labels: Vec<String>,
}

/// Copy a found sound into a scene's assets as a sidecar-indexed WAV.
#[tauri::command]
pub async fn dissect_extract_sound(app: AppHandle, request: ExtractSoundRequest) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    tokio::task::spawn_blocking(move || extract_sound(&projects_dir, request))
        .await
        .map_err(|e| Error::Other(format!("extract task: {}", e)))?
}

pub fn extract_sound(projects_dir: &Path, req: ExtractSoundRequest) -> Result<String> {
    check_span(req.start, req.end)?;
    let slug = req.scene_slug.trim();
    if slug.is_empty() || slug.contains('/') || slug.contains('\\') || slug.contains("..") {
        return Err(Error::Other(format!("invalid scene '{}'", req.scene_slug)));
    }
    let dir = import_dir(projects_dir, &req.import_id)?;
    let import: DissectImport = read_json(&dir.join(IMPORT_FILE))?;
    let src = stem_file(&dir, &req.stem)?;
    let (model, fade) = match req.kind.as_str() {
        "sfx" => ("dissect-sfx", 0.01),
        "vocal" => ("dissect-sfx-vocal", 0.01),
        "ambience" => ("dissect-ambience", 0.3),
        "music" => ("dissect-music", 0.3),
        other => return Err(Error::Other(format!("unknown sound kind '{}'", other))),
    };
    let safe: String = req
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let assets = crate::app_support::scene_dir(projects_dir, &req.project_id, slug).join("assets");
    let out = assets.join(format!(
        "{}.dissect.{}.wav",
        if safe.is_empty() { req.kind.clone() } else { safe },
        Utc::now().format("%Y%m%d%H%M%S%3f")
    ));
    cut(&src, req.start, req.end, fade, &out)?;

    let out_s = out.to_string_lossy().into_owned();
    let dur_ms = ((req.end - req.start) * 1000.0).round() as u64;
    let meta = crate::models::SidecarMeta {
        model: model.into(),
        model_variant: Some(format!("{} stem", req.stem)),
        prompt: req.name.clone(),
        instruct: if req.labels.is_empty() { None } else { Some(req.labels.join(", ")) },
        speaker: None,
        language: None,
        seed: 0,
        temperature: None,
        top_p: None,
        duration_target_ms: Some(dur_ms),
        duration_actual_ms: Some(dur_ms),
        sample_rate: 48000,
        generated_at: Utc::now(),
        parent: Some(format!("{} @ {:.2}–{:.2}s", import.source_name, req.start, req.end)),
        take_index: 0,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };
    crate::commands::sidecar::write_sidecar(out_s.clone(), meta)?;
    Ok(out_s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> String {
        let import_id = Uuid::new_v4().to_string();
        let dir = imports_root(root).join(&import_id);
        std::fs::create_dir_all(dir.join("candidates")).unwrap();
        std::fs::write(dir.join("candidates/S1_c1.wav"), b"RIFFfake").unwrap();
        std::fs::write(dir.join("candidates/S1_c2.wav"), b"RIFFfake2").unwrap();
        write_json(
            &dir.join(IMPORT_FILE),
            &DissectImport {
                import_id: import_id.clone(),
                job_id: "j".into(),
                source_path: "/x/ep1.mp3".into(),
                source_name: "ep1.mp3".into(),
                server_url: "http://127.0.0.1:18007".into(),
                remote: false,
                status: "complete".into(),
                error: None,
                created_at: Utc::now().to_rfc3339(),
                options: DissectOptions::default(),
                unreachable_since: None,
            },
        )
        .unwrap();
        let manifest = serde_json::json!({
            "speakers": [{ "id": "S1", "candidates": [
                { "id": "S1_c1", "path": "candidates/S1_c1.wav", "transcript": "Hello there." },
                { "id": "S1_c2", "path": "candidates/S1_c2.wav", "transcript": "Second." }
            ]}]
        });
        write_json(&dir.join(MANIFEST_FILE), &manifest).unwrap();
        import_id
    }

    fn req(import_id: &str) -> AssignSpeakerRequest {
        AssignSpeakerRequest {
            import_id: import_id.into(),
            speaker_id: "S1".into(),
            candidate_ids: vec!["S1_c1".into(), "S1_c2".into()],
            gold_candidate_id: Some("S1_c2".into()),
            library_id: None,
            new_name: Some("Matthew".into()),
            rights_confirmed: true,
            rights_statement: None,
            performer: Some("Bruce Perry".into()),
        }
    }

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("pharaoh-dissect-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn assign_requires_rights_confirmation() {
        let root = tmp();
        let id = fixture(&root);
        let mut r = req(&id);
        r.rights_confirmed = false;
        let err = assign_speaker(&root, r).unwrap_err().to_string();
        assert!(err.contains("rights"), "{}", err);
        assert!(!library_character_dir(&root, "x").parent().unwrap().exists());
    }

    #[test]
    fn assign_creates_character_with_provenance_and_gold() {
        let root = tmp();
        let id = fixture(&root);
        let c = assign_speaker(&root, req(&id)).unwrap();
        assert_eq!(c.name, "Matthew");
        assert_eq!(c.voice_assignment.ref_audio_sources.len(), 2);
        let gold = c.voice_assignment.ref_audio_path.clone().unwrap();
        assert!(gold.ends_with("_S1_c2.wav"), "{}", gold);
        assert!(Path::new(&gold).is_file());
        assert_eq!(c.voice_assignment.ref_transcript.as_deref(), Some("Second."));
        assert_eq!(c.voice_provenance.len(), 1);
        assert_eq!(c.voice_provenance[0].source_name, "ep1.mp3");
        assert_eq!(c.voice_provenance[0].rights_statement, DEFAULT_RIGHTS_STATEMENT);
        assert_eq!(c.voice_provenance[0].performer.as_deref(), Some("Bruce Perry"));

        // On disk, paths are bundle-relative like every other library entry.
        let bundle = library_character_dir(&root, c.library_id.as_ref().unwrap());
        let raw: Character = read_json(&bundle.join(LIBRARY_BUNDLE_FILE)).unwrap();
        assert!(raw.voice_assignment.ref_audio_path.unwrap().starts_with("imports/"));

        // A second assignment onto the same character appends, keeps the gold.
        let mut r = req(&id);
        r.new_name = None;
        r.library_id = c.library_id.clone();
        r.candidate_ids = vec!["S1_c1".into()];
        r.gold_candidate_id = None;
        let c2 = assign_speaker(&root, r).unwrap();
        assert_eq!(c2.voice_assignment.ref_audio_sources.len(), 2);
        assert_eq!(c2.voice_assignment.ref_audio_path.unwrap(), gold);
        assert_eq!(c2.voice_provenance.len(), 2);
    }

    fn set_status(root: &Path, id: &str, status: &str, source: &str) {
        let path = imports_root(root).join(id).join(IMPORT_FILE);
        let mut imp: DissectImport = read_json(&path).unwrap();
        imp.status = status.into();
        imp.source_path = source.into();
        // Port 9 (discard) refuses fast: a stand-in for a dead server.
        imp.server_url = "http://127.0.0.1:9".into();
        write_json(&path, &imp).unwrap();
    }

    #[tokio::test]
    async fn cancel_marks_cancelled_even_if_server_is_unreachable() {
        let root = tmp();
        let id = fixture(&root);
        set_status(&root, &id, "running", "/nope.mp3");
        let http = reqwest::Client::new();
        let imp = cancel(&http, &root, &id).await.unwrap();
        assert_eq!(imp.status, "cancelled");
        // Terminal from then on: poll doesn't contact the server.
        let s = poll(&http, &root, &id).await.unwrap();
        assert_eq!(s.status, "cancelled");
        // And a second cancel is refused.
        assert!(cancel(&http, &root, &id).await.is_err());
    }

    #[tokio::test]
    async fn retry_only_from_failed_or_cancelled_with_source_present() {
        let root = tmp();
        let id = fixture(&root);
        let http = reqwest::Client::new();
        set_status(&root, &id, "running", "/nope.mp3");
        let e = retry(&http, "http://127.0.0.1:9", &root, &id).await.unwrap_err().to_string();
        assert!(e.contains("only failed or cancelled"), "{}", e);

        set_status(&root, &id, "failed", "/definitely/not/here.m4b");
        let e = retry(&http, "http://127.0.0.1:9", &root, &id).await.unwrap_err().to_string();
        assert!(e.contains("can't reach"), "missing folder reads as unreachable: {}", e);

        let gone = root.join("ep_moved.wav");
        set_status(&root, &id, "failed", &gone.to_string_lossy());
        let e = retry(&http, "http://127.0.0.1:9", &root, &id).await.unwrap_err().to_string();
        assert!(e.contains("no longer at"), "folder present, file gone: {}", e);

        // Source present but server down: error, and the import stays failed.
        let src = root.join("ep.wav");
        std::fs::write(&src, b"RIFF").unwrap();
        set_status(&root, &id, "failed", &src.to_string_lossy());
        assert!(retry(&http, "http://127.0.0.1:9", &root, &id).await.is_err());
        let imp: DissectImport = read_json(&imports_root(&root).join(&id).join(IMPORT_FILE)).unwrap();
        assert_eq!(imp.status, "failed");
    }

    #[tokio::test]
    async fn unreachable_server_gets_a_grace_period_then_fails_with_a_reason() {
        let root = tmp();
        let id = fixture(&root);
        set_status(&root, &id, "running", "/nope.mp3");
        let http = reqwest::Client::new();

        let s = poll(&http, &root, &id).await.unwrap();
        assert_eq!(s.status, "running");
        assert!(s.message.unwrap().contains("Can't reach the dissect server"));

        // Backdate the first failure past the grace period.
        let path = imports_root(&root).join(&id).join(IMPORT_FILE);
        let mut imp: DissectImport = read_json(&path).unwrap();
        imp.unreachable_since = Some((Utc::now() - chrono::Duration::seconds(UNREACHABLE_GRACE_SECS + 5)).to_rfc3339());
        write_json(&path, &imp).unwrap();

        let s = poll(&http, &root, &id).await.unwrap();
        assert_eq!(s.status, "failed");
        assert!(s.error.unwrap().contains("Lost contact"));
    }

    fn with_stem(root: &Path, id: &str) {
        let stems = imports_root(root).join(id).join("stems");
        std::fs::create_dir_all(&stems).unwrap();
        let st = std::process::Command::new("ffmpeg")
            .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=6", "-ac", "2", "-ar", "44100"])
            .arg(stems.join("effects.flac"))
            .status()
            .unwrap();
        assert!(st.success());
    }

    #[test]
    fn clip_is_cut_and_cached() {
        let root = tmp();
        let id = fixture(&root);
        with_stem(&root, &id);
        let a = clip_for(&root, &id, "effects", 1.0, 2.5).unwrap();
        let info = crate::app_support::wav_info(&a).unwrap();
        assert_eq!(info.sample_rate, 48000);
        assert!((info.duration_ms().unwrap() as i64 - 1500).abs() < 30);
        assert_eq!(clip_for(&root, &id, "effects", 1.0, 2.5).unwrap(), a);
        assert!(clip_for(&root, &id, "music", 1.0, 2.5).is_err(), "no music stem");
        assert!(clip_for(&root, &id, "../x", 1.0, 2.5).is_err());
        assert!(clip_for(&root, &id, "effects", 2.0, 1.0).is_err());
    }

    #[test]
    fn extract_writes_scene_asset_with_sidecar() {
        let root = tmp();
        let id = fixture(&root);
        with_stem(&root, &id);
        let req = |kind: &str, slug: &str| ExtractSoundRequest {
            import_id: id.clone(),
            stem: "effects".into(),
            start: 0.5,
            end: 1.25,
            name: "Door · Knock".into(),
            kind: kind.into(),
            project_id: "p".into(),
            scene_slug: slug.into(),
            labels: vec!["Door".into(), "Knock".into()],
        };
        let out = extract_sound(&root, req("sfx", "01_bright_river")).unwrap();
        assert!(out.contains("/scenes/01_bright_river/assets/door_knock.dissect."), "{}", out);
        let meta: serde_json::Value = read_json(Path::new(&format!("{}.meta.json", out))).unwrap();
        assert_eq!(meta["model"], "dissect-sfx");
        assert_eq!(crate::app_support::asset_kind_from_model("dissect-sfx"), "sfx");
        assert_eq!(crate::app_support::asset_kind_from_model("dissect-music"), "music");
        assert!(meta["parent"].as_str().unwrap().starts_with("ep1.mp3 @ 0.50"));
        assert!(extract_sound(&root, req("sfx", "../../etc")).is_err());
        assert!(extract_sound(&root, req("laser", "s")).is_err());
    }

    #[test]
    fn rejects_non_uuid_import_ids() {
        let root = tmp();
        let mut r = req("../../etc");
        r.import_id = "../../etc".into();
        assert!(assign_speaker(&root, r).is_err());
    }
}
