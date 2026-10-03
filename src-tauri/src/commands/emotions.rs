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
//! palette emotion's *recipe* — weights over the seven classes plus delivery
//! targets (loud, pace, pitch, movement, breathy) against that character's
//! own average — so the palette can offer real tender / furious / weary
//! moments from the recording as clone references. Chatterbox copies a
//! reference's delivery as much as its voice. `dissect_similar_clips` finds
//! the clips nearest one clip in emotion2vec's embedding space, for moods no
//! recipe names.

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
use crate::models::EmotionRecipe;

const EMOTIONS_FILE: &str = "emotions.json";

/// Shortest utterance offered as a clone reference.
const MIN_REF_S: f64 = 2.5;

// ── Recipes ───────────────────────────────────────────────────────────────

fn r(classes: &[(&str, f32)], loud: f32, pace: f32, pitch: f32, movement: f32, breathy: f32) -> EmotionRecipe {
    EmotionRecipe {
        classes: classes.iter().map(|(k, w)| (k.to_string(), *w)).collect(),
        loud,
        pace,
        pitch,
        movement,
        breathy,
    }
}

/// The built-in recipe for a palette emotion's name. Classes: angry,
/// disgusted, fearful, happy, neutral, sad, surprised. Delivery targets are
/// relative to the character's own average (-1..1).
pub fn default_recipe(emotion: &str) -> Option<EmotionRecipe> {
    let e = emotion.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    Some(match e.as_str() {
        "neutral" | "calm" | "plain" | "default" => r(&[("neutral", 1.0)], 0.0, 0.0, 0.0, -0.2, 0.0),
        "happy" | "joyful" | "cheerful" | "glad" | "warm" => r(&[("happy", 1.0)], 0.1, 0.1, 0.2, 0.2, 0.0),
        "amused" => r(&[("happy", 0.8), ("surprised", 0.2)], 0.0, 0.0, 0.2, 0.4, 0.0),
        "excited" | "thrilled" | "eager" => r(&[("happy", 0.6), ("surprised", 0.6)], 0.5, 0.6, 0.4, 0.6, 0.0),
        "tender" | "gentle" | "loving" | "soothing" => r(&[("happy", 0.5), ("neutral", 0.5), ("angry", -0.5)], -0.6, -0.4, -0.1, 0.0, 0.3),
        "sad" | "sorrowful" | "melancholy" | "grieving" => r(&[("sad", 1.0)], -0.3, -0.3, -0.2, -0.1, 0.0),
        "angry" | "cross" => r(&[("angry", 1.0)], 0.3, 0.1, 0.1, 0.2, 0.0),
        "furious" | "rage" | "livid" => r(&[("angry", 1.0)], 0.9, 0.4, 0.4, 0.5, 0.0),
        "annoyed" | "irritated" => r(&[("angry", 0.6), ("disgusted", 0.4)], -0.2, 0.0, 0.0, -0.1, 0.0),
        "afraid" | "fearful" | "scared" | "frightened" | "terrified" => r(&[("fearful", 1.0)], 0.0, 0.3, 0.3, 0.2, 0.2),
        "anxious" | "nervous" | "tense" | "worried" => r(&[("fearful", 0.7), ("neutral", 0.3), ("surprised", -0.3)], -0.2, 0.3, 0.1, 0.0, 0.1),
        "surprised" | "shocked" | "astonished" => r(&[("surprised", 1.0)], 0.3, 0.2, 0.5, 0.6, 0.0),
        "disgusted" | "contemptuous" | "scornful" => r(&[("disgusted", 1.0)], 0.0, 0.0, -0.1, 0.0, 0.0),
        "sardonic" | "sarcastic" | "dry" | "wry" => r(&[("disgusted", 0.5), ("neutral", 0.4), ("happy", 0.2)], -0.1, -0.1, -0.2, -0.4, 0.0),
        "smug" => r(&[("happy", 0.5), ("disgusted", 0.5)], 0.0, -0.2, -0.1, 0.0, 0.0),
        "bittersweet" | "wistful" | "nostalgic" => r(&[("happy", 0.6), ("sad", 0.6)], -0.3, -0.3, 0.0, 0.0, 0.1),
        "exasperated" => r(&[("angry", 0.6), ("disgusted", 0.6)], 0.2, 0.2, 0.2, 0.3, 0.1),
        "indignant" | "outraged" => r(&[("angry", 0.7), ("surprised", 0.5)], 0.5, 0.2, 0.4, 0.5, 0.0),
        "grim" | "bleak" => r(&[("sad", 0.6), ("angry", 0.5)], -0.2, -0.3, -0.4, -0.5, 0.0),
        "weary" | "tired" | "exhausted" => r(&[("sad", 0.5), ("neutral", 0.5)], -0.4, -0.6, -0.3, -0.5, 0.3),
        "pleading" | "begging" => r(&[("sad", 0.6), ("fearful", 0.4)], 0.1, 0.1, 0.4, 0.4, 0.2),
        "determined" | "resolute" => r(&[("neutral", 0.5), ("angry", 0.4)], 0.3, 0.0, -0.1, -0.2, -0.2),
        "whisper" | "whispered" | "hushed" => r(&[("neutral", 0.3)], -1.0, 0.0, 0.0, -0.3, 1.0),
        _ => return None,
    })
}

// ── Clip ranking ──────────────────────────────────────────────────────────

const CLASSES: [&str; 7] = ["angry", "disgusted", "fearful", "happy", "neutral", "sad", "surprised"];
/// Delivery features: (utterance field, recipe target accessor). pitch_var
/// carries "movement"; flatness carries "breathy".
const FEATURES: [&str; 5] = ["loud_db", "rate", "f0_hz", "f0_var", "flat"];
/// Weight of a fully-met delivery target relative to the class blend.
const DELIVERY_W: f64 = 0.35;

fn targets(r: &EmotionRecipe) -> [f64; 5] {
    [r.loud as f64, r.pace as f64, r.pitch as f64, r.movement as f64, r.breathy as f64]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionClip {
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// How well the clip fits (recipe score, or cosine similarity for "more like this").
    pub fit: f64,
    /// The utterance's own top class and its score.
    pub top: String,
    pub top_score: f64,
    /// The utterance's class scores.
    pub scores: HashMap<String, f64>,
    /// How much of emotion2vec's belief landed on the seven classes (the rest
    /// is "other/unknown"); low = the reader couldn't tell.
    pub clarity: f64,
    /// Plain words for its delivery against the character's average: "loud", "slow", "breathy"…
    pub traits: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionClips {
    /// False until the import has `emotions.json`.
    pub tagged: bool,
    /// Tagged before delivery features and embeddings existed: recipes use
    /// classes only and "more like this" is unavailable until re-read.
    pub needs_update: bool,
    /// The recipe used (the entry's own, else the built-in one for its name).
    pub recipe: Option<EmotionRecipe>,
    pub clips: Vec<EmotionClip>,
    /// How many of this character's utterances were tagged.
    pub utterances: usize,
}

/// Mean and std of each delivery feature over these utterances.
/// A feature on the scale it's compared on: spectral flatness is heavily
/// skewed (a few breathy lines dwarf the rest), so it's compared in log.
fn feature(u: &Value, k: usize) -> Option<f64> {
    let x = u[FEATURES[k]].as_f64()?;
    Some(if FEATURES[k] == "flat" { (x.max(1e-5)).ln() } else { x })
}

fn feature_stats(utts: &[&Value]) -> [(f64, f64); 5] {
    let mut out = [(0.0, 1.0); 5];
    for k in 0..FEATURES.len() {
        let xs: Vec<f64> = utts.iter().filter_map(|u| feature(u, k)).collect();
        if xs.len() >= 5 {
            let m = xs.iter().sum::<f64>() / xs.len() as f64;
            let sd = (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / xs.len() as f64).sqrt();
            out[k] = (m, sd.max(1e-6));
        }
    }
    out
}

fn zs(u: &Value, stats: &[(f64, f64); 5]) -> [Option<f64>; 5] {
    let mut z = [None; 5];
    for (k, zk) in z.iter_mut().enumerate() {
        *zk = feature(u, k).map(|x| (x - stats[k].0) / stats[k].1);
    }
    z
}

fn traits(z: &[Option<f64>; 5]) -> Vec<String> {
    const WORDS: [(&str, &str); 5] = [("loud", "soft"), ("fast", "slow"), ("high", "low"), ("animated", "flat"), ("breathy", "clear")];
    let mut t = Vec::new();
    for (k, (hi, lo)) in WORDS.iter().enumerate() {
        match z[k] {
            Some(v) if v > 0.9 => t.push(hi.to_string()),
            Some(v) if v < -0.9 => t.push(lo.to_string()),
            _ => {}
        }
    }
    t
}

fn recipe_score(u: &Value, z: &[Option<f64>; 5], recipe: &EmotionRecipe) -> f64 {
    // Weights summing past 1 are scaled down; smaller ones keep their size, so
    // "neutral 0.3" in a whisper recipe stays a nudge next to the delivery targets.
    let norm: f64 = recipe.classes.values().map(|w| w.abs() as f64).sum::<f64>().max(1.0);
    let blend: f64 = recipe
        .classes
        .iter()
        .map(|(c, w)| *w as f64 * u["scores"][c.as_str()].as_f64().unwrap_or(0.0))
        .sum::<f64>()
        / norm;
    let t = targets(recipe);
    let delivery: f64 = (0..5).filter_map(|k| z[k].map(|v| t[k] * (v / 1.5).tanh())).sum();
    blend + DELIVERY_W * delivery
}

fn clip(u: &Value, z: &[Option<f64>; 5], fit: f64) -> Option<EmotionClip> {
    let scores: HashMap<String, f64> = CLASSES.iter().map(|c| (c.to_string(), u["scores"][*c].as_f64().unwrap_or(0.0))).collect();
    let top = u["emotion"].as_str().unwrap_or("").to_string();
    Some(EmotionClip {
        speaker: u["speaker"].as_str()?.to_string(),
        start: u["start"].as_f64()?,
        end: u["end"].as_f64()?,
        text: u["text"].as_str().unwrap_or("").to_string(),
        fit,
        top_score: scores.get(&top).copied().unwrap_or(0.0),
        clarity: scores.values().sum(),
        top,
        scores,
        traits: traits(z),
    })
}

/// Indices of the character's utterances, and of those usable as references
/// (no cross-talk, at least MIN_REF_S long).
fn usable(utts: &[Value], speakers: &[String]) -> (Vec<usize>, Vec<usize>) {
    let mine: Vec<usize> = (0..utts.len())
        .filter(|&i| speakers.iter().any(|s| utts[i]["speaker"].as_str() == Some(s.as_str())))
        .collect();
    let refs = mine
        .iter()
        .copied()
        .filter(|&i| {
            let u = &utts[i];
            !u["overlap"].as_bool().unwrap_or(false)
                && u["end"].as_f64().unwrap_or(0.0) - u["start"].as_f64().unwrap_or(0.0) >= MIN_REF_S
        })
        .collect();
    (mine, refs)
}

fn rank(utts: &[Value], speakers: &[String], recipe: &EmotionRecipe, limit: usize) -> (Vec<EmotionClip>, usize) {
    let (mine, refs) = usable(utts, speakers);
    let all: Vec<&Value> = mine.iter().map(|&i| &utts[i]).collect();
    let stats = feature_stats(&all);
    let mut out: Vec<EmotionClip> = refs
        .iter()
        .filter_map(|&i| {
            let z = zs(&utts[i], &stats);
            clip(&utts[i], &z, recipe_score(&utts[i], &z, recipe))
        })
        .collect();
    out.sort_by(|a, b| b.fit.partial_cmp(&a.fit).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    (out, mine.len())
}

fn load(projects_dir: &Path, import_id: &str) -> Result<Option<(PathBuf, Value)>> {
    let dir = import_dir(projects_dir, import_id)?;
    let path = dir.join(EMOTIONS_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some((dir, read_json(&path)?)))
}

fn version(data: &Value) -> u64 {
    data["version"].as_u64().unwrap_or(1)
}

pub fn clips_for(
    projects_dir: &Path,
    import_id: &str,
    speaker_ids: &[String],
    emotion: &str,
    recipe: Option<EmotionRecipe>,
    limit: usize,
) -> Result<EmotionClips> {
    let recipe = recipe.or_else(|| default_recipe(emotion));
    let Some((_, data)) = load(projects_dir, import_id)? else {
        return Ok(EmotionClips { tagged: false, needs_update: false, recipe, clips: vec![], utterances: 0 });
    };
    let needs_update = version(&data) < 2;
    let Some(rec) = recipe.clone().filter(|r| !r.classes.is_empty() || targets(r).iter().any(|t| *t != 0.0)) else {
        return Ok(EmotionClips { tagged: true, needs_update, recipe: None, clips: vec![], utterances: 0 });
    };
    let utts = data["utterances"].as_array().cloned().unwrap_or_default();
    let (clips, utterances) = rank(&utts, speaker_ids, &rec, limit.clamp(1, 50));
    Ok(EmotionClips { tagged: true, needs_update, recipe, clips, utterances })
}

#[tauri::command]
pub fn dissect_emotion_clips(
    app: AppHandle,
    import_id: String,
    speaker_ids: Vec<String>,
    emotion: String,
    recipe: Option<EmotionRecipe>,
    limit: Option<usize>,
) -> Result<EmotionClips> {
    clips_for(&app_projects_dir(&app)?, &import_id, &speaker_ids, &emotion, recipe, limit.unwrap_or(8))
}

// ── More like this ────────────────────────────────────────────────────────

fn f16_to_f32(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((h >> 10) & 0x1f) as i32;
    let man = (h & 0x3ff) as f32;
    sign * match exp {
        0 => man * 2f32.powi(-24),
        31 => f32::INFINITY,
        _ => (1.0 + man / 1024.0) * 2f32.powi(exp - 15),
    }
}

fn vector(bytes: &[u8], dim: usize, i: usize) -> Option<Vec<f32>> {
    let row = bytes.get(i * dim * 2..(i + 1) * dim * 2)?;
    Some(row.chunks_exact(2).map(|b| f16_to_f32(u16::from_le_bytes([b[0], b[1]]))).collect())
}

fn similar(utts: &[Value], bytes: &[u8], dim: usize, speakers: &[String], start: f64, limit: usize) -> Result<Vec<EmotionClip>> {
    // The utterance starting at `start`, else the one containing it.
    let at = |u: &Value| (u["start"].as_f64().unwrap_or(-1.0), u["end"].as_f64().unwrap_or(-1.0));
    let seed = utts
        .iter()
        .position(|u| (at(u).0 - start).abs() < 0.05)
        .or_else(|| utts.iter().position(|u| at(u).0 <= start && start < at(u).1))
        .ok_or_else(|| Error::Other("that clip isn't in this import's emotion tags".into()))?;
    let q = vector(bytes, dim, seed).ok_or_else(|| Error::Other("emotion vectors are missing — re-read emotions".into()))?;
    let (mine, refs) = usable(utts, speakers);
    let all: Vec<&Value> = mine.iter().map(|&i| &utts[i]).collect();
    let stats = feature_stats(&all);
    let mut out: Vec<EmotionClip> = refs
        .iter()
        .filter(|&&i| i != seed)
        .filter_map(|&i| {
            let v = vector(bytes, dim, i)?;
            let cos: f32 = q.iter().zip(&v).map(|(a, b)| a * b).sum();
            clip(&utts[i], &zs(&utts[i], &stats), cos as f64)
        })
        .collect();
    out.sort_by(|a, b| b.fit.partial_cmp(&a.fit).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    Ok(out)
}

/// The character's clips whose delivery is most like the clip at `start`
/// (cosine over emotion2vec embeddings) — for moods no recipe names.
#[tauri::command]
pub fn dissect_similar_clips(app: AppHandle, import_id: String, speaker_ids: Vec<String>, start: f64, limit: Option<usize>) -> Result<Vec<EmotionClip>> {
    similar_for(&app_projects_dir(&app)?, &import_id, &speaker_ids, start, limit.unwrap_or(8))
}

pub fn similar_for(projects_dir: &Path, import_id: &str, speaker_ids: &[String], start: f64, limit: usize) -> Result<Vec<EmotionClip>> {
    let (dir, data) = load(projects_dir, import_id)?.ok_or_else(|| Error::Other("this import's emotions haven't been read".into()))?;
    let file = data["vectors"].as_str().ok_or_else(|| Error::Other("tagged before 'more like this' existed — re-read emotions".into()))?;
    let bytes = std::fs::read(dir.join(file)).map_err(|e| Error::Other(format!("emotion vectors: {}", e)))?;
    let dim = data["embedding_dim"].as_u64().unwrap_or(1024) as usize;
    let utts = data["utterances"].as_array().cloned().unwrap_or_default();
    similar(&utts, &bytes, dim, speaker_ids, start, limit.clamp(1, 50))
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
    let mut turns = manifest["turns"].as_array().cloned().unwrap_or_default();
    if turns.is_empty() {
        return Err(Error::Other("this import has no transcribed dialogue to tag".into()));
    }
    // Word timings (for speaking rate) live in transcript.json, row for row.
    if let Ok(Value::Array(words)) = read_json::<Value>(&dir.join("transcript.json")) {
        if words.len() == turns.len() {
            for (t, w) in turns.iter_mut().zip(words) {
                t["words"] = w["words"].clone();
            }
        }
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
    let (data, vecs) = result?;
    std::fs::write(dir.join(data["vectors"].as_str().unwrap_or("emotion_vecs.f16")), vecs)?;
    let n = data["utterances"].as_array().map(|a| a.len()).unwrap_or(0);
    write_json(&dir.join(EMOTIONS_FILE), &data)?;
    Ok(n)
}

async fn submit_and_wait(http: &reqwest::Client, base: &str, audio: &Path, turns: Vec<Value>, id: &str) -> Result<(Value, Vec<u8>)> {
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

    // 5. Collect the result: vectors first (fetching the JSON deletes both).
    let vecs = http
        .get(format!("{}/emotions/{}/vectors", base, job))
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| Error::Other(format!("fetch emotion vectors: {}", e)))?
        .error_for_status()
        .map_err(|e| Error::Other(format!("fetch emotion vectors: {}", e)))?
        .bytes()
        .await
        .map_err(|e| Error::Other(format!("emotion vectors: {}", e)))?
        .to_vec();
    let data: Value = http
        .get(format!("{}/emotions/{}", base, job))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| Error::Other(format!("fetch emotions: {}", e)))?
        .error_for_status()
        .map_err(|e| Error::Other(format!("fetch emotions: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("emotions response: {}", e)))?;
    Ok((data, vecs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(spk: &str, a: f64, b: f64, top: &str, scores: &[(&str, f64)], loud: f64, rate: f64, overlap: bool) -> Value {
        let mut sc = serde_json::Map::new();
        for c in CLASSES {
            sc.insert(c.into(), serde_json::json!(scores.iter().find(|(k, _)| *k == c).map(|(_, v)| *v).unwrap_or(0.0)));
        }
        serde_json::json!({
            "speaker": spk, "start": a, "end": b, "text": "", "overlap": overlap, "emotion": top, "scores": sc,
            "loud_db": loud, "rate": rate, "f0_hz": 200.0, "f0_var": 2.0, "flat": 0.05,
        })
    }

    #[test]
    fn built_in_recipes_cover_the_baseline_and_blends() {
        for e in ["neutral", "happy", "excited", "tender", "sad", "angry", "afraid", "sardonic", "whisper",
                  "bittersweet", "weary", "furious", "anxious", "Smug", "pleading"] {
            assert!(default_recipe(e).is_some(), "{} has no recipe", e);
        }
        assert!(default_recipe("zxq").is_none());
        let w = default_recipe("whisper").unwrap();
        assert!(w.loud < 0.0 && w.breathy > 0.0);
    }

    #[test]
    fn recipes_blend_classes_and_delivery() {
        let utts = vec![
            u("S1", 0.0, 5.0, "happy", &[("happy", 0.9)], -20.0, 3.0, false),          // happy, loud
            u("S1", 10.0, 15.0, "happy", &[("happy", 0.8)], -40.0, 1.5, false),        // happy, soft and slow
            u("S1", 20.0, 25.0, "sad", &[("sad", 0.6), ("happy", 0.5)], -30.0, 2.0, false), // bittersweet
            u("S1", 30.0, 35.0, "angry", &[("angry", 0.9)], -30.0, 2.5, true),         // cross-talk: excluded
            u("S1", 40.0, 41.0, "happy", &[("happy", 1.0)], -30.0, 2.0, false),        // too short
            u("S2", 50.0, 55.0, "happy", &[("happy", 1.0)], -30.0, 2.0, false),        // someone else
        ];
        let me = vec!["S1".to_string()];
        let (tender, total) = rank(&utts, &me, &default_recipe("tender").unwrap(), 10);
        assert_eq!(total, 5);
        assert_eq!(tender[0].start, 10.0, "tender prefers the soft, slow happy line");
        assert!(tender[0].traits.contains(&"soft".to_string()));
        let (excited, _) = rank(&utts, &me, &default_recipe("excited").unwrap(), 10);
        assert_eq!(excited[0].start, 0.0, "excited prefers the loud, quick one");
        let (bs, _) = rank(&utts, &me, &default_recipe("bittersweet").unwrap(), 10);
        assert_eq!(bs[0].start, 20.0, "bittersweet wants happy and sad together");
        assert_eq!(bs.len(), 3);
    }

    #[test]
    fn more_like_this_ranks_by_embedding_similarity() {
        let utts: Vec<Value> = (0..4).map(|i| u("S1", i as f64 * 10.0, i as f64 * 10.0 + 4.0, "neutral", &[("neutral", 1.0)], -30.0, 2.0, false)).collect();
        // dim 2: seed (1,0); near (0.8,0.6); far (0,1); opposite (-1,0)
        let rows: [[f32; 2]; 4] = [[1.0, 0.0], [0.0, 1.0], [0.8, 0.6], [-1.0, 0.0]];
        let mut bytes = Vec::new();
        for r in rows {
            for x in r {
                let h: u16 = match x { 1.0 => 0x3c00, -1.0 => 0xbc00, 0.0 => 0, 0.8 => 0x3a66, 0.6 => 0x38cd, _ => unreachable!() };
                bytes.extend_from_slice(&h.to_le_bytes());
            }
        }
        let sim = similar(&utts, &bytes, 2, &["S1".to_string()], 0.0, 10).unwrap();
        let starts: Vec<f64> = sim.iter().map(|c| c.start).collect();
        assert_eq!(starts, vec![20.0, 10.0, 30.0]);
        assert!((sim[0].fit - 0.8).abs() < 0.01);
    }

    #[test]
    fn f16_decodes() {
        assert_eq!(f16_to_f32(0x3c00), 1.0);
        assert_eq!(f16_to_f32(0xc000), -2.0);
        assert!((f16_to_f32(0x3555) - 0.3333).abs() < 1e-3);
    }
}
