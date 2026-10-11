//! Speaker corrections for a finished dissect import.
//!
//! Diarization confuses voices, most often when one actor plays several
//! parts. These edits move lines (turns) and clips (candidates) to another
//! speaker or a new one, or merge a whole speaker into another. They are
//! applied to `manifest.json` itself, so the review, voice assignment,
//! rebuild and the CLI all read the corrected speakers with no other changes.
//! The server's manifest is kept once as `manifest.server.json`; reset puts
//! it back.

use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::app_support::{app_projects_dir, read_json, write_json};
use crate::commands::dissect::import_dir;
use crate::error::{Error, Result};

const MANIFEST: &str = "manifest.json";
const ORIGINAL: &str = "manifest.server.json";

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct ReassignRequest {
    pub import_id: String,
    /// Speaker the lines and clips are on now.
    pub from: String,
    /// Speaker to move them to; `None` creates a new speaker.
    pub to: Option<String>,
    /// Label for a new speaker (default "Speaker N").
    pub new_label: Option<String>,
    /// Turns to move, by start time (seconds).
    pub turn_starts: Vec<f64>,
    /// Candidate clips to move, by id.
    pub candidate_ids: Vec<String>,
    /// Move everything: merge `from` into `to`.
    pub all: bool,
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn overlaps(a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    a0 < b1 && b0 < a1
}

fn speaker_index(m: &Value, id: &str) -> Option<usize> {
    m["speakers"].as_array()?.iter().position(|s| s["id"] == id)
}

/// Next free "S{n}".
fn new_speaker_id(m: &Value) -> (String, u64) {
    let max = m["speakers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["id"].as_str()?.strip_prefix('S')?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    (format!("S{}", max + 1), max + 1)
}

/// Apply a reassignment to a manifest in memory. Returns how many turns and
/// candidates moved.
pub fn apply(m: &mut Value, req: &ReassignRequest) -> Result<(usize, usize)> {
    let from_i = speaker_index(m, &req.from).ok_or_else(|| Error::Other(format!("speaker {} not in import", req.from)))?;
    if req.all && req.to.is_none() {
        return Err(Error::Other("merging needs a target speaker".into()));
    }
    if req.to.as_deref() == Some(req.from.as_str()) {
        return Err(Error::Other("source and target are the same speaker".into()));
    }

    // Target, created if new.
    let to_id = match req.to.as_deref() {
        Some(id) => {
            speaker_index(m, id).ok_or_else(|| Error::Other(format!("speaker {id} not in import")))?;
            id.to_string()
        }
        None => {
            let (id, n) = new_speaker_id(m);
            let label = req.new_label.clone().filter(|l| !l.trim().is_empty()).unwrap_or_else(|| format!("Speaker {n}"));
            m["speakers"].as_array_mut().unwrap().push(json!({
                "id": id, "label": label.trim(), "total_speech_s": 0.0, "turn_count": 0,
                "first_heard_s": 0.0, "sample_text": "", "chapters": [], "credits": [], "candidates": [],
                // Made by hand: the review always shows it, however little speech.
                "split": true,
            }));
            id
        }
    };

    // Which candidate clips move.
    let from_cands: Vec<Value> = m["speakers"][from_i]["candidates"].as_array().cloned().unwrap_or_default();
    let mut moving_c: Vec<String> = if req.all {
        from_cands.iter().filter_map(|c| c["id"].as_str().map(String::from)).collect()
    } else {
        req.candidate_ids.clone()
    };
    for id in &moving_c {
        if !from_cands.iter().any(|c| c["id"] == id.as_str()) {
            return Err(Error::Other(format!("clip {id} is not on {}", req.from)));
        }
    }

    // Which turns move: those named, plus any a moving clip was cut from.
    let clip_spans: Vec<(f64, f64)> = from_cands
        .iter()
        .filter(|c| moving_c.iter().any(|id| c["id"] == id.as_str()))
        .map(|c| (f(&c["start"]), f(&c["end"])))
        .collect();
    let mut turn_spans: Vec<(f64, f64)> = vec![];
    let mut moved_t = 0usize;
    let mut moved_s = 0.0f64;
    if let Some(turns) = m["turns"].as_array_mut() {
        for t in turns.iter_mut().filter(|t| t["speaker"] == req.from.as_str()) {
            let (s, e) = (f(&t["start"]), f(&t["end"]));
            let named = req.turn_starts.iter().any(|x| (x - s).abs() < 0.01);
            let under_clip = clip_spans.iter().any(|&(a, b)| overlaps(a, b, s, e));
            if req.all || named || under_clip {
                t["speaker"] = json!(to_id);
                turn_spans.push((s, e));
                moved_t += 1;
                moved_s += (e - s).max(0.0);
            }
        }
    }
    if !req.all {
        let missing: Vec<&f64> = req.turn_starts.iter().filter(|x| !turn_spans.iter().any(|(s, _)| (*x - s).abs() < 0.01)).collect();
        if let Some(x) = missing.first() {
            return Err(Error::Other(format!("no line by {} starts at {x:.2}s", req.from)));
        }
        // Clips cut from a moving line go with it.
        for c in &from_cands {
            let (s, e) = (f(&c["start"]), f(&c["end"]));
            if let Some(id) = c["id"].as_str() {
                if !moving_c.iter().any(|x| x == id) && turn_spans.iter().any(|&(a, b)| overlaps(a, b, s, e)) {
                    moving_c.push(id.to_string());
                }
            }
        }
    }

    // Move the clips. Their voice-match score was against the old speaker.
    let to_i = speaker_index(m, &to_id).unwrap();
    let mut moved: Vec<Value> = vec![];
    if let Some(cs) = m["speakers"][from_i]["candidates"].as_array_mut() {
        cs.retain(|c| {
            if moving_c.iter().any(|id| c["id"] == id.as_str()) {
                let mut c = c.clone();
                c["similarity"] = Value::Null;
                moved.push(c);
                false
            } else {
                true
            }
        });
    }
    let moved_c = moved.len();
    if let Some(cs) = m["speakers"][to_i]["candidates"].as_array_mut() {
        cs.extend(moved);
        cs.sort_by(|a, b| f(&b["score"]).partial_cmp(&f(&a["score"])).unwrap_or(std::cmp::Ordering::Equal));
    }
    if req.all {
        let credits = m["speakers"][from_i]["credits"].as_array().cloned().unwrap_or_default();
        if let Some(c) = m["speakers"][to_i]["credits"].as_array_mut() {
            c.extend(credits);
        } else {
            m["speakers"][to_i]["credits"] = json!(credits);
        }
    }

    // Stats move by what moved, keeping the pipeline's own measure.
    for (i, sign) in [(from_i, -1.0), (to_i, 1.0)] {
        let sp = &mut m["speakers"][i];
        sp["total_speech_s"] = json!((f(&sp["total_speech_s"]) + sign * moved_s).max(0.0));
        let tc = sp["turn_count"].as_i64().unwrap_or(0) + if sign > 0.0 { moved_t as i64 } else { -(moved_t as i64) };
        sp["turn_count"] = json!(tc.max(0));
    }
    for id in [req.from.as_str(), to_id.as_str()] {
        refresh_speaker(m, id);
    }

    // A speaker left with nothing is gone.
    let empty_from = m["speakers"][from_i]["turn_count"].as_i64() == Some(0)
        && m["speakers"][from_i]["candidates"].as_array().is_none_or(|c| c.is_empty());
    if empty_from {
        m["speakers"].as_array_mut().unwrap().remove(from_i);
    }
    // Most speech first, as the pipeline orders them.
    if let Some(sps) = m["speakers"].as_array_mut() {
        sps.sort_by(|a, b| f(&b["total_speech_s"]).partial_cmp(&f(&a["total_speech_s"])).unwrap_or(std::cmp::Ordering::Equal));
    }
    m["corrections"] = json!(m["corrections"].as_u64().unwrap_or(0) + 1);
    Ok((moved_t, moved_c))
}

/// First heard, chapters and the sample line, from the speaker's turns.
fn refresh_speaker(m: &mut Value, id: &str) {
    let Some(i) = speaker_index(m, id) else { return };
    let turns: Vec<&Value> = m["turns"].as_array().into_iter().flatten().filter(|t| t["speaker"] == id).collect();
    let first = turns.iter().map(|t| f(&t["start"])).fold(f64::INFINITY, f64::min);
    let mut chapters: Vec<i64> = turns.iter().filter_map(|t| t["chapter"].as_i64()).collect();
    chapters.sort_unstable();
    chapters.dedup();
    let sample = m["speakers"][i]["sample_text"].as_str().unwrap_or("").to_string();
    let still_theirs = !sample.is_empty() && turns.iter().any(|t| t["text"].as_str().is_some_and(|x| x.contains(sample.trim_matches('…'))));
    let new_sample = if still_theirs {
        sample
    } else {
        turns
            .iter()
            .filter_map(|t| t["text"].as_str())
            .max_by_key(|x| x.len().min(160))
            .map(|x| x.chars().take(160).collect())
            .unwrap_or_default()
    };
    let sp = &mut m["speakers"][i];
    sp["first_heard_s"] = json!(if first.is_finite() { first } else { 0.0 });
    sp["chapters"] = json!(chapters);
    sp["sample_text"] = json!(new_sample);
}

pub fn reassign_in(dir: &Path, req: &ReassignRequest) -> Result<Value> {
    let path = dir.join(MANIFEST);
    if !path.is_file() {
        return Err(Error::Other("this import has no manifest yet".into()));
    }
    let original = dir.join(ORIGINAL);
    if !original.exists() {
        std::fs::copy(&path, &original)?;
    }
    let mut m: Value = read_json(&path)?;
    apply(&mut m, req)?;
    write_json(&path, &m)?;
    Ok(m)
}

pub fn reset_in(dir: &Path) -> Result<Value> {
    let original = dir.join(ORIGINAL);
    if !original.is_file() {
        return read_json(&dir.join(MANIFEST));
    }
    std::fs::copy(&original, dir.join(MANIFEST))?;
    std::fs::remove_file(&original)?;
    read_json(&dir.join(MANIFEST))
}

/// Drop a saved original: a re-run's manifest supersedes it.
pub fn forget_original(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(ORIGINAL));
}

#[tauri::command]
pub fn dissect_reassign(app: AppHandle, request: ReassignRequest) -> Result<Value> {
    let dir = import_dir(&app_projects_dir(&app)?, &request.import_id)?;
    reassign_in(&dir, &request)
}

#[tauri::command]
pub fn dissect_reset_speakers(app: AppHandle, import_id: String) -> Result<Value> {
    let dir = import_dir(&app_projects_dir(&app)?, &import_id)?;
    reset_in(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Value {
        json!({
            "speakers": [
                { "id": "S1", "label": "Speaker 1", "total_speech_s": 30.0, "turn_count": 3, "first_heard_s": 0.0,
                  "sample_text": "I am the narrator.", "chapters": [0, 1], "credits": [{ "character": "Anne", "performer": "X", "at": 1.0 }],
                  "candidates": [
                    { "id": "S1_c1", "start": 0.5, "end": 8.0, "score": 0.9, "similarity": 0.8 },
                    { "id": "S1_c2", "start": 21.0, "end": 28.0, "score": 0.7, "similarity": 0.6 }
                  ] },
                { "id": "S2", "label": "Speaker 2", "total_speech_s": 5.0, "turn_count": 1, "first_heard_s": 12.0,
                  "sample_text": "Hello.", "chapters": [0], "candidates": [] }
            ],
            "turns": [
                { "speaker": "S1", "start": 0.0, "end": 10.0, "text": "I am the narrator.", "chapter": 0 },
                { "speaker": "S2", "start": 12.0, "end": 17.0, "text": "Hello.", "chapter": 0 },
                { "speaker": "S1", "start": 20.0, "end": 30.0, "text": "Gruff old man voice here.", "chapter": 1 },
                { "speaker": "S1", "start": 40.0, "end": 50.0, "text": "More narration.", "chapter": 1 }
            ]
        })
    }

    #[test]
    fn moving_a_clip_takes_its_line_and_creates_a_speaker() {
        let mut m = manifest();
        let req = ReassignRequest { from: "S1".into(), candidate_ids: vec!["S1_c2".into()], new_label: Some("Matthew".into()), ..Default::default() };
        assert_eq!(apply(&mut m, &req).unwrap(), (1, 1));
        let s3 = m["speakers"].as_array().unwrap().iter().find(|s| s["id"] == "S3").unwrap();
        assert_eq!(s3["label"], "Matthew");
        assert_eq!(s3["split"], true);
        assert_eq!(s3["candidates"][0]["id"], "S1_c2");
        assert!(s3["candidates"][0]["similarity"].is_null());
        assert_eq!(s3["turn_count"], 1);
        assert_eq!(f(&s3["total_speech_s"]), 10.0);
        assert_eq!(f(&s3["first_heard_s"]), 20.0);
        assert_eq!(s3["sample_text"], "Gruff old man voice here.");
        assert_eq!(m["turns"][2]["speaker"], "S3");
        let s1 = m["speakers"].as_array().unwrap().iter().find(|s| s["id"] == "S1").unwrap();
        assert_eq!(s1["turn_count"], 2);
        assert_eq!(f(&s1["total_speech_s"]), 20.0);
        assert_eq!(s1["chapters"], json!([0, 1]));
        assert_eq!(m["corrections"], 1);
    }

    #[test]
    fn moving_a_line_takes_its_clips_to_an_existing_speaker() {
        let mut m = manifest();
        let req = ReassignRequest { from: "S1".into(), to: Some("S2".into()), turn_starts: vec![0.0], ..Default::default() };
        assert_eq!(apply(&mut m, &req).unwrap(), (1, 1));
        let s2 = m["speakers"].as_array().unwrap().iter().find(|s| s["id"] == "S2").unwrap();
        assert_eq!(s2["candidates"][0]["id"], "S1_c1");
        assert_eq!(f(&s2["first_heard_s"]), 0.0);
        assert_eq!(s2["sample_text"], "Hello.", "a sample still theirs is kept");
        let s1 = m["speakers"].as_array().unwrap().iter().find(|s| s["id"] == "S1").unwrap();
        assert_eq!(f(&s1["first_heard_s"]), 20.0);
        assert_eq!(s1["sample_text"], "Gruff old man voice here.", "the sample moved away, so a new one is picked");
    }

    #[test]
    fn merge_moves_everything_and_removes_the_speaker() {
        let mut m = manifest();
        let req = ReassignRequest { from: "S1".into(), to: Some("S2".into()), all: true, ..Default::default() };
        assert_eq!(apply(&mut m, &req).unwrap(), (3, 2));
        let sps = m["speakers"].as_array().unwrap();
        assert_eq!(sps.len(), 1);
        assert_eq!(sps[0]["id"], "S2");
        assert_eq!(sps[0]["turn_count"], 4);
        assert_eq!(f(&sps[0]["total_speech_s"]), 35.0);
        assert_eq!(sps[0]["credits"][0]["character"], "Anne");
        assert_eq!(sps[0]["candidates"][0]["id"], "S1_c1", "clips sorted by score");
        assert!(m["turns"].as_array().unwrap().iter().all(|t| t["speaker"] == "S2"));
    }

    #[test]
    fn bad_requests_change_nothing_on_disk() {
        let mut m = manifest();
        assert!(apply(&mut m, &ReassignRequest { from: "S9".into(), ..Default::default() }).is_err());
        assert!(apply(&mut m, &ReassignRequest { from: "S1".into(), all: true, ..Default::default() }).is_err());
        assert!(apply(&mut m, &ReassignRequest { from: "S1".into(), to: Some("S1".into()), ..Default::default() }).is_err());
        assert!(apply(&mut m, &ReassignRequest { from: "S1".into(), to: Some("S2".into()), turn_starts: vec![12.0], ..Default::default() }).is_err(), "that line is S2's");
        assert!(apply(&mut m, &ReassignRequest { from: "S2".into(), to: Some("S1".into()), candidate_ids: vec!["S1_c1".into()], ..Default::default() }).is_err());

        let dir = std::env::temp_dir().join(format!("pharaoh-dissect-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        write_json(&dir.join(MANIFEST), &manifest()).unwrap();
        assert!(reassign_in(&dir, &ReassignRequest { from: "S9".into(), ..Default::default() }).is_err());
        let after: Value = read_json(&dir.join(MANIFEST)).unwrap();
        assert_eq!(after, manifest());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reset_restores_the_server_manifest() {
        let dir = std::env::temp_dir().join(format!("pharaoh-dissect-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        write_json(&dir.join(MANIFEST), &manifest()).unwrap();
        reassign_in(&dir, &ReassignRequest { from: "S1".into(), to: Some("S2".into()), all: true, ..Default::default() }).unwrap();
        reassign_in(&dir, &ReassignRequest { from: "S2".into(), turn_starts: vec![12.0], ..Default::default() }).unwrap();
        assert!(dir.join(ORIGINAL).exists());
        let back = reset_in(&dir).unwrap();
        assert_eq!(back, manifest());
        assert!(!dir.join(ORIGINAL).exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
