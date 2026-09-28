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
    /// "running" | "complete" | "failed"
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: String,
}

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
    let filename = Path::new(local_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("source.wav")
        .to_string();
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
fn unpack_bundle(bytes: &[u8], dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
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
    let remote = is_remote_url(&base);

    let (input_path, output_path) = if remote {
        (upload_source(http, &base, &source_path).await?, String::new())
    } else {
        (source_path.clone(), dir.to_string_lossy().into_owned())
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
    };
    write_json(&dir.join(IMPORT_FILE), &import)?;
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
        "failed" => return Ok(status(&import, 0.0, None, None)),
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
        // Transient: keep reporting running so the UI keeps polling.
        Err(e) => {
            return Ok(status(&import, 0.0, Some(format!("Waiting for server: {}", e)), None))
        }
    };

    let progress = job["progress"].as_f64().unwrap_or(0.0) as f32;
    let message = job["message"].as_str().map(str::to_string);
    match job["status"].as_str().unwrap_or("pending") {
        "complete" => {
            if import.remote {
                let bytes = http
                    .get(format!("{}/files/{}", import.server_url, import.job_id))
                    .timeout(Duration::from_secs(30 * 60))
                    .send()
                    .await
                    .map_err(|e| Error::Other(format!("download dissect bundle: {}", e)))?
                    .error_for_status()
                    .map_err(|e| Error::Other(format!("download dissect bundle: {}", e)))?
                    .bytes()
                    .await
                    .map_err(|e| Error::Other(format!("download dissect bundle: {}", e)))?;
                let dest = dir.clone();
                tokio::task::spawn_blocking(move || unpack_bundle(&bytes, &dest))
                    .await
                    .map_err(|e| Error::Other(format!("unpack task: {}", e)))??;
            }
            let manifest = read_manifest(&dir)?
                .ok_or_else(|| Error::Other("dissect finished but manifest.json is missing".into()))?;
            import.status = "complete".into();
            write_json(&import_path, &import)?;
            Ok(status(&import, 1.0, message, Some(manifest)))
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

    #[test]
    fn rejects_non_uuid_import_ids() {
        let root = tmp();
        let mut r = req("../../etc");
        r.import_id = "../../etc".into();
        assert!(assign_speaker(&root, r).is_err());
    }
}
