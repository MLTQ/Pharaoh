//! Emotion tags for dissected dialogue → real per-emotion palette references.
//!
//! The dissect server scores every utterance (same-speaker turns joined up to
//! ~12 s) with emotion2vec and the import keeps the result as `emotions.json`.
//! New dissects write it themselves; `dissect_tag_emotions` tags an import
//! made before that existed: it renders the dialogue stem to 16 kHz mono
//! FLAC, uploads it (remote server), runs `/generate/emotions` and saves the
//! result next to the manifest.
//!
//! `dissect_emotion_clips` then ranks a character's own utterances for a
//! palette emotion, so the palette can offer real angry / afraid / happy
//! moments from the recording as clone references — Chatterbox copies a
//! reference's delivery as much as its voice.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_support::{app_projects_dir, read_json, write_json};
use crate::commands::dissect::{dissect_url, http, import_dir, read_manifest, stem_file, upload_source, UploadProgress};
use crate::commands::inference::is_remote_url;
use crate::error::{Error, Result};

const EMOTIONS_FILE: &str = "emotions.json";

/// Shortest utterance offered as a clone reference.
const MIN_REF_S: f64 = 2.5;

// ── Palette emotion → emotion2vec class ───────────────────────────────────

/// The emotion2vec class a palette emotion corresponds to, if any. Classes:
/// angry, disgusted, fearful, happy, neutral, sad, surprised.
pub fn class_for(emotion: &str) -> Option<&'static str> {
    let e = emotion.trim().to_ascii_lowercase();
    Some(match e.as_str() {
        "neutral" | "calm" | "plain" | "default" => "neutral",
        "happy" | "joyful" | "cheerful" | "glad" | "amused" | "warm" => "happy",
        "sad" | "sorrowful" | "melancholy" | "grief" | "grieving" | "upset" => "sad",
        "angry" | "furious" | "irate" | "annoyed" | "frustrated" | "rage" => "angry",
        "afraid" | "fearful" | "scared" | "frightened" | "terrified" | "anxious" | "nervous" | "tense" => "fearful",
        "surprised" | "excited" | "shocked" | "astonished" | "amazed" => "surprised",
        "disgusted" | "sardonic" | "contemptuous" | "disdainful" | "sneering" | "scornful" => "disgusted",
        _ => return None,
    })
}

// ── Clip ranking ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionClip {
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// Score of the requested class (0–1).
    pub score: f64,
    /// The utterance's own top class.
    pub top: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionClips {
    /// False until the import has `emotions.json`.
    pub tagged: bool,
    /// The emotion2vec class used, or None when the palette emotion has no
    /// counterpart (e.g. "whisper").
    pub class: Option<String>,
    pub clips: Vec<EmotionClip>,
    /// How many of this character's utterances were tagged.
    pub utterances: usize,
}

fn rank(data: &Value, speakers: &[String], class: &str, limit: usize) -> (Vec<EmotionClip>, usize) {
    let utts = data["utterances"].as_array().cloned().unwrap_or_default();
    let mut total = 0usize;
    let mut out: Vec<EmotionClip> = utts
        .iter()
        .filter(|u| speakers.iter().any(|s| u["speaker"].as_str() == Some(s.as_str())))
        .inspect(|_| total += 1)
        .filter(|u| !u["overlap"].as_bool().unwrap_or(false))
        .filter_map(|u| {
            let (a, b) = (u["start"].as_f64()?, u["end"].as_f64()?);
            if b - a < MIN_REF_S {
                return None;
            }
            Some(EmotionClip {
                speaker: u["speaker"].as_str()?.to_string(),
                start: a,
                end: b,
                text: u["text"].as_str().unwrap_or("").to_string(),
                score: u["scores"][class].as_f64().unwrap_or(0.0),
                top: u["emotion"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect();
    // Clear wins first: the class must be the utterance's top emotion, then by score.
    out.sort_by(|x, y| {
        (y.top == class).cmp(&(x.top == class)).then(y.score.partial_cmp(&x.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    out.truncate(limit);
    (out, total)
}

pub fn clips_for(projects_dir: &Path, import_id: &str, speaker_ids: &[String], emotion: &str, limit: usize) -> Result<EmotionClips> {
    let dir = import_dir(projects_dir, import_id)?;
    let path = dir.join(EMOTIONS_FILE);
    if !path.is_file() {
        return Ok(EmotionClips { tagged: false, class: class_for(emotion).map(str::to_string), clips: vec![], utterances: 0 });
    }
    let data: Value = read_json(&path)?;
    let Some(class) = class_for(emotion) else {
        return Ok(EmotionClips { tagged: true, class: None, clips: vec![], utterances: 0 });
    };
    let (clips, utterances) = rank(&data, speaker_ids, class, limit.clamp(1, 50));
    Ok(EmotionClips { tagged: true, class: Some(class.to_string()), clips, utterances })
}

#[tauri::command]
pub fn dissect_emotion_clips(app: AppHandle, import_id: String, speaker_ids: Vec<String>, emotion: String, limit: Option<usize>) -> Result<EmotionClips> {
    clips_for(&app_projects_dir(&app)?, &import_id, &speaker_ids, &emotion, limit.unwrap_or(8))
}

// ── Tagging an existing import ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EmotionJobStatus {
    pub import_id: String,
    pub done: bool,
    pub progress: f32,
    pub message: String,
    pub error: Option<String>,
}

fn jobs() -> &'static Mutex<HashMap<String, EmotionJobStatus>> {
    static J: OnceLock<Mutex<HashMap<String, EmotionJobStatus>>> = OnceLock::new();
    J.get_or_init(Default::default)
}

fn set(id: &str, f: impl FnOnce(&mut EmotionJobStatus)) {
    if let Ok(mut m) = jobs().lock() {
        if let Some(s) = m.get_mut(id) {
            f(s);
        }
    }
}

#[tauri::command]
pub fn dissect_emotion_status(job_id: String) -> Result<EmotionJobStatus> {
    jobs()
        .lock()
        .ok()
        .and_then(|m| m.get(&job_id).cloned())
        .ok_or_else(|| Error::Other(format!("no emotion job {}", job_id)))
}

/// Start tagging an import's dialogue. Returns a job id for `dissect_emotion_status`.
#[tauri::command]
pub async fn dissect_tag_emotions(app: AppHandle, import_id: String) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    let base = dissect_url(&app)?;
    let (job_id, fut) = start(http(&app), base, projects_dir, import_id)?;
    tauri::async_runtime::spawn(fut);
    Ok(job_id)
}

/// Validate, register the job, and return the work to run (the app spawns
/// it; the CLI awaits it while printing `dissect_emotion_status`).
pub fn start(
    http: reqwest::Client,
    base: String,
    projects_dir: PathBuf,
    import_id: String,
) -> Result<(String, impl std::future::Future<Output = ()> + Send + 'static)> {
    let dir = import_dir(&projects_dir, &import_id)?;
    let manifest = read_manifest(&dir)?.ok_or_else(|| Error::Other("this import hasn't finished dissecting".into()))?;
    let turns = manifest["turns"].as_array().cloned().unwrap_or_default();
    if turns.is_empty() {
        return Err(Error::Other("this import has no transcribed dialogue to tag".into()));
    }
    let stem = stem_file(&dir, "dialogue")?;
    let base = base.trim_end_matches('/').to_string();
    let job_id = Uuid::new_v4().to_string();
    jobs().lock().map_err(|_| Error::Other("lock poisoned".into()))?.insert(
        job_id.clone(),
        EmotionJobStatus { import_id: import_id.clone(), message: "Preparing the dialogue".into(), ..Default::default() },
    );
    let id = job_id.clone();
    let fut = async move {
        let res = run(&http, &base, &dir, &stem, turns, &id).await;
        set(&id, |s| {
            s.done = true;
            match res {
                Ok(n) => {
                    s.progress = 1.0;
                    s.message = format!("{} lines tagged", n);
                }
                Err(e) => s.error = Some(e.to_string()),
            }
        });
    };
    Ok((job_id, fut))
}

async fn run(http: &reqwest::Client, base: &str, dir: &Path, stem: &Path, turns: Vec<Value>, id: &str) -> Result<usize> {
    // 1. 16 kHz mono FLAC of the dialogue — what emotion2vec reads, and ~10× smaller to send.
    let tmp: PathBuf = dir.join(".emotion-16k.flac");
    let (src, dst) = (stem.to_path_buf(), tmp.clone());
    let ok = tokio::task::spawn_blocking(move || {
        Command::new("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-y", "-i"])
            .arg(&src)
            .args(["-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-c:a", "flac"])
            .arg(&dst)
            .status()
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))?
    .map_err(|e| Error::Other(format!("could not run ffmpeg: {}", e)))?;
    if !ok.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Other("ffmpeg could not read the dialogue stem".into()));
    }
    let result = submit_and_wait(http, base, &tmp, turns, id).await;
    let _ = std::fs::remove_file(&tmp);
    let data = result?;
    let n = data["utterances"].as_array().map(|a| a.len()).unwrap_or(0);
    write_json(&dir.join(EMOTIONS_FILE), &data)?;
    Ok(n)
}

async fn submit_and_wait(http: &reqwest::Client, base: &str, audio: &Path, turns: Vec<Value>, id: &str) -> Result<Value> {
    // 2. Upload (remote) with progress, or hand over the path (same machine).
    let input_path = if is_remote_url(base) {
        let total = std::fs::metadata(audio).map(|m| m.len()).unwrap_or(0);
        let p = Arc::new(UploadProgress { done: AtomicU64::new(0), total, cancelled: AtomicBool::new(false) });
        let watch = p.clone();
        let wid = id.to_string();
        let ticker = tokio::spawn(async move {
            loop {
                let d = watch.done.load(Ordering::Relaxed);
                set(&wid, |s| {
                    s.progress = 0.1 * d as f32 / watch.total.max(1) as f32;
                    s.message = format!("Uploading the dialogue · {} of {} MB", d / 1_000_000, watch.total / 1_000_000);
                });
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
        let r = upload_source(http, base, &audio.to_string_lossy(), Some(p)).await;
        ticker.abort();
        r?
    } else {
        audio.to_string_lossy().into_owned()
    };

    // 3. Run the tagging job.
    let resp: Value = http
        .post(format!("{}/generate/emotions", base))
        .json(&serde_json::json!({ "input_path": input_path, "turns": turns }))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| Error::Other(format!("dissect server unreachable at {} ({})", base, e)))?
        .error_for_status()
        .map_err(|e| Error::Other(format!("emotion tagging rejected (is the dissect server up to date?): {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("emotion submit response: {}", e)))?;
    let job = resp["job_id"].as_str().ok_or_else(|| Error::Other("no job_id from the dissect server".into()))?.to_string();

    // 4. Poll.
    let mut misses = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let j: Value = match http.get(format!("{}/jobs/{}", base, job)).timeout(Duration::from_secs(10)).send().await {
            Ok(r) => r.json().await.unwrap_or(Value::Null),
            Err(e) => {
                misses += 1;
                if misses > 60 {
                    return Err(Error::Other(format!("lost contact with the dissect server: {}", e)));
                }
                continue;
            }
        };
        misses = 0;
        let p = j["progress"].as_f64().unwrap_or(0.0) as f32;
        let msg = j["message"].as_str().unwrap_or("").to_string();
        set(id, |s| {
            s.progress = 0.1 + 0.9 * p;
            if !msg.is_empty() {
                s.message = msg.clone();
            }
        });
        match j["status"].as_str() {
            Some("complete") => break,
            Some("failed") => return Err(Error::Other(j["error"].as_str().unwrap_or("emotion tagging failed").to_string())),
            Some("cancelled") => return Err(Error::Other("emotion tagging was cancelled".into())),
            _ => {}
        }
    }

    // 5. Collect the result.
    http.get(format!("{}/emotions/{}", base, job))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| Error::Other(format!("fetch emotions: {}", e)))?
        .error_for_status()
        .map_err(|e| Error::Other(format!("fetch emotions: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("emotions response: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_emotions_map_to_tagger_classes() {
        assert_eq!(class_for("Angry"), Some("angry"));
        assert_eq!(class_for("afraid"), Some("fearful"));
        assert_eq!(class_for("sardonic"), Some("disgusted"));
        assert_eq!(class_for("excited"), Some("surprised"));
        assert_eq!(class_for("whisper"), None);
    }

    #[test]
    fn ranks_own_clean_long_utterances_clear_wins_first() {
        let u = |spk: &str, a: f64, b: f64, angry: f64, top: &str, overlap: bool| serde_json::json!({
            "speaker": spk, "start": a, "end": b, "text": "", "overlap": overlap,
            "emotion": top, "scores": { "angry": angry, "neutral": 1.0 - angry }
        });
        let data = serde_json::json!({ "utterances": [
            u("S1", 0.0, 5.0, 0.6, "angry", false),
            u("S1", 10.0, 15.0, 0.45, "neutral", false), // higher-scoring neutral loses to a clear win
            u("S1", 20.0, 25.0, 0.95, "angry", true),    // cross-talk: excluded
            u("S1", 30.0, 31.0, 0.99, "angry", false),   // too short: excluded
            u("S2", 40.0, 45.0, 0.99, "angry", false),   // someone else
            u("S1", 50.0, 55.0, 0.8, "angry", false),
        ]});
        let (clips, total) = rank(&data, &["S1".into()], "angry", 10);
        assert_eq!(total, 5);
        let starts: Vec<f64> = clips.iter().map(|c| c.start).collect();
        assert_eq!(starts, vec![50.0, 0.0, 10.0]);
    }
}
