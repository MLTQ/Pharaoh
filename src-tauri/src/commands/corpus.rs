//! Chatterbox corpus commands — stage 3 of the character voice pipeline.
//!
//! Stage 2 produces a handful of approved palette reference takes per emotion.
//! Stage 4 (RVC training) needs *minutes* of that voice, so stage 3 clones each
//! approved reference across a rotating set of test lines and paralinguistic
//! tags until the corpus is large and varied enough to train on.
//!
//! The GUI's Corpus tab drove these four commands from the day it shipped, but
//! nothing implemented them — the invokes failed and `CorpusBuilder` swallowed
//! the errors, so "Generate corpus" and "Clear" silently did nothing. This
//! module is the Rust half, mirroring the semantics of the MCP server's
//! `build_corpus` / `corpus_status` tools so both surfaces produce the same
//! corpus layout.
//!
//! A corpus build is one long-running *local* job that fans out into many
//! Chatterbox jobs. It is tracked here rather than in the shared job store
//! because the frontend polls it as a single unit of work with a completed/total
//! count, not as N independent takes in the job queue.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::app_support::app_projects_dir;
use crate::error::{Error, Result};
use crate::models::AppState;

// ── Corpus content ────────────────────────────────────────────────────────

/// Paralinguistic tags, in prefix and suffix position. The same line carries a
/// different prosodic shape depending on where the tag sits, so both are worth
/// having in the corpus.
const TAG_VARIANTS: &[&str] = &[
    "", // clean baseline
    "[sigh] ",
    "[chuckle] ",
    "[laugh] ",
    "[gasp] ",
    "[clears throat] ",
    "[hmm] ",
    " [sigh]",
    " [chuckle]",
    " [laugh]",
];

/// Fixed corpus lines. Deliberately *not* the character's `instruct_default`,
/// which is a voice description rather than speech. Rotating through varied
/// sentences gives the corpus prosodic range.
const CORPUS_LINES: &[&str] = &[
    "And then she said — nothing at all.",
    "The signal was gone before I could trace it.",
    "I knew what it meant. I just didn't want to say it out loud.",
    "Something is wrong with the archive.",
    "You were never supposed to find this.",
    "Three days. That's all we had.",
    "It doesn't matter anymore. None of it does.",
    "She looked at me like I was already gone.",
    "I've seen that look before. It never ends well.",
    "The door was open. It shouldn't have been.",
];

/// Default number of takes to generate across all approved emotions.
const DEFAULT_TARGET_COUNT: usize = 50;

// ── Data structures ───────────────────────────────────────────────────────

/// How many corpus WAVs exist for one emotion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionCorpusCount {
    pub emotion: String,
    pub count: usize,
}

/// Handle returned when a corpus build starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildCorpusResult {
    pub job_id: String,
    /// Total takes queued, so the UI can show progress out of a known total.
    pub total: usize,
}

/// Progress of a running (or finished) corpus build.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusJobStatus {
    pub completed: usize,
    pub total: usize,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct CorpusJob {
    completed: usize,
    total: usize,
    done: bool,
    error: Option<String>,
}

/// In-process registry of corpus builds. Entries are small and a session runs
/// few of them, so they are kept for the life of the process — the UI polls a
/// job by id after it finishes to read the final count.
fn jobs() -> &'static Mutex<HashMap<String, CorpusJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, CorpusJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn update_job(job_id: &str, f: impl FnOnce(&mut CorpusJob)) {
    if let Ok(mut map) = jobs().lock() {
        if let Some(job) = map.get_mut(job_id) {
            f(job);
        }
    }
}

// ── Paths ─────────────────────────────────────────────────────────────────

fn corpus_dir(projects_dir: &Path, project_id: &str, character_id: &str) -> PathBuf {
    projects_dir
        .join(project_id)
        .join("characters")
        .join(character_id)
        .join("rvc_corpus")
}

/// Corpus files are named `{emotion}_{index}.wav`, so the emotion is the part
/// before the final underscore. Names without an underscore are counted under
/// `"imported"` — bulk-imported real recordings carry their original filename.
fn emotion_of(file_stem: &str) -> String {
    match file_stem.rsplit_once('_') {
        Some((head, tail)) if !head.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
            head.to_string()
        }
        _ => "imported".to_string(),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Count corpus WAVs per emotion, so the Corpus tab can show which emotional
/// states are under-represented.
#[tauri::command]
pub async fn get_corpus_emotion_counts(
    app: AppHandle,
    project_id: String,
    character_id: String,
) -> Result<Vec<EmotionCorpusCount>> {
    let projects_dir = app_projects_dir(&app)?;
    let dir = corpus_dir(&projects_dir, &project_id, &character_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        *counts.entry(emotion_of(stem)).or_insert(0) += 1;
    }

    let mut out: Vec<EmotionCorpusCount> = counts
        .into_iter()
        .map(|(emotion, count)| EmotionCorpusCount { emotion, count })
        .collect();
    // Stable ordering so the UI list does not shuffle between polls.
    out.sort_by(|a, b| a.emotion.cmp(&b.emotion));
    Ok(out)
}

/// Delete every generated corpus WAV and its sidecar.
///
/// Removes the files rather than the directory so a corpus can be rebuilt
/// without recreating the tree, and leaves anything that is not a `.wav` or
/// its `.meta.json` alone.
#[tauri::command]
pub async fn clear_corpus(
    app: AppHandle,
    project_id: String,
    character_id: String,
) -> Result<usize> {
    let projects_dir = app_projects_dir(&app)?;
    let dir = corpus_dir(&projects_dir, &project_id, &character_id);
    if !dir.exists() {
        return Ok(0);
    }

    let mut removed = 0usize;
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let is_corpus_file = name.ends_with(".wav") || name.ends_with(".wav.meta.json");
        if is_corpus_file && path.is_file() {
            std::fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Queue a corpus build for a character.
///
/// Returns immediately with a job id and the number of takes queued; poll
/// [`get_corpus_job_status`] for progress. Requires at least one approved
/// palette entry with a reference WAV (stage 2).
#[tauri::command]
pub async fn build_corpus(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    character_id: String,
    target_count: Option<usize>,
) -> Result<BuildCorpusResult> {
    let projects_dir = app_projects_dir(&app)?;
    // Read through the same path the GUI uses: migrate_project_in_place also
    // absolutizes the character bundle's voice paths, and the Chatterbox server
    // needs an absolute ref_audio_path.
    let project_path =
        crate::app_support::project_dir(&projects_dir, &project_id).join("project.json");
    let mut project: crate::models::Project = crate::app_support::read_json(&project_path)?;
    crate::commands::project::migrate_project_in_place(&mut project, &projects_dir);
    let character = project
        .characters
        .iter()
        .find(|c| c.id == character_id)
        .ok_or_else(|| {
            Error::Other(format!(
                "character {} not found in project {}",
                character_id, project_id
            ))
        })?;

    // Only approved palette entries make good clone sources — an unapproved
    // take bakes its flaws into every one of the takes derived from it.
    let approved: Vec<(String, String)> = character
        .voice_assignment
        .emotional_palette
        .iter()
        .filter(|e| e.qa_status == "approved")
        .filter_map(|e| {
            let path = e.ref_audio_path.clone()?;
            if path.trim().is_empty() {
                None
            } else {
                Some((e.emotion.clone(), path))
            }
        })
        .collect();

    if approved.is_empty() {
        return Err(Error::Other(
            "no approved palette entries with reference audio — complete the Voice stage first"
                .into(),
        ));
    }

    let dir = corpus_dir(&projects_dir, &project_id, &character_id);
    std::fs::create_dir_all(&dir)?;

    let target = target_count.unwrap_or(DEFAULT_TARGET_COUNT);
    let per_emotion = (target / approved.len()).max(1);
    let total = per_emotion * approved.len();

    let job_id = format!("corpus-{}", uuid::Uuid::new_v4());
    if let Ok(mut map) = jobs().lock() {
        map.insert(
            job_id.clone(),
            CorpusJob { completed: 0, total, done: false, error: None },
        );
    }

    let base_url = {
        let cfg = state
            .server_config
            .read()
            .map_err(|_| Error::Other("server config lock poisoned".into()))?;
        cfg.chatterbox_url.clone()
    };
    let http = state.http.clone();
    let dir_for_task = dir.clone();
    let job_for_task = job_id.clone();

    tauri::async_runtime::spawn(async move {
        let mut take = 0usize;
        for (emotion, ref_audio) in &approved {
            for i in 0..per_emotion {
                let tag = TAG_VARIANTS[take % TAG_VARIANTS.len()];
                let line = CORPUS_LINES[take % CORPUS_LINES.len()];
                let text = if tag.starts_with('[') {
                    format!("{}{}", tag, line)
                } else if tag.is_empty() {
                    line.to_string()
                } else {
                    format!("{}{}", line, tag)
                };
                take += 1;

                let out_path = dir_for_task.join(format!("{}_{:03}.wav", emotion, i));
                let body = serde_json::json!({
                    "text": text.trim(),
                    "ref_audio_path": ref_audio,
                    "exaggeration": 0.45,
                    "cfg_weight": 0.5,
                    "temperature": 0.8,
                    "seed": i as i64,
                    "output_path": out_path.to_string_lossy(),
                });

                match submit_and_wait(&http, &base_url, &body).await {
                    Ok(()) => update_job(&job_for_task, |j| j.completed += 1),
                    Err(e) => {
                        update_job(&job_for_task, |j| {
                            j.error = Some(format!(
                                "stopped after {} of {} takes (emotion '{}'): {}",
                                j.completed, j.total, emotion, e
                            ));
                            j.done = true;
                        });
                        return;
                    }
                }
            }
        }
        update_job(&job_for_task, |j| j.done = true);
    });

    Ok(BuildCorpusResult { job_id, total })
}

/// Submit one Chatterbox clone job and wait for it to finish.
///
/// Corpus takes are generated serially: the Chatterbox server holds one model
/// and `torch.manual_seed` is global, so firing all fifty at once would both
/// thrash the GPU and cross-contaminate seeds.
async fn submit_and_wait(
    http: &reqwest::Client,
    base_url: &str,
    body: &serde_json::Value,
) -> std::result::Result<(), String> {
    let resp: serde_json::Value = http
        .post(format!("{}/generate/clone", base_url))
        .json(body)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("chatterbox unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("bad chatterbox response: {e}"))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| "chatterbox response had no job_id".to_string())?
        .to_string();

    // Generation of a single short line is quick, but the first take also pays
    // for model load. Cap the wait so a wedged server cannot hang the build.
    const POLL_INTERVAL: Duration = Duration::from_millis(750);
    const MAX_WAIT: Duration = Duration::from_secs(300);
    let started = std::time::Instant::now();

    loop {
        if started.elapsed() > MAX_WAIT {
            return Err(format!("take timed out after {}s", MAX_WAIT.as_secs()));
        }
        tokio::time::sleep(POLL_INTERVAL).await;

        let status: serde_json::Value = match http
            .get(format!("{}/jobs/{}", base_url, job_id))
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            Ok(r) => match r.json().await {
                Ok(v) => v,
                Err(e) => return Err(format!("bad job status: {e}")),
            },
            Err(e) => return Err(format!("job poll failed: {e}")),
        };

        match status["status"].as_str().unwrap_or("") {
            "complete" => return Ok(()),
            "failed" => {
                return Err(status["error"]
                    .as_str()
                    .unwrap_or("unknown chatterbox error")
                    .to_string())
            }
            _ => {}
        }
    }
}

/// Poll a corpus build started by [`build_corpus`].
#[tauri::command]
pub async fn get_corpus_job_status(job_id: String) -> Result<CorpusJobStatus> {
    let map = jobs()
        .lock()
        .map_err(|_| Error::Other("corpus job registry poisoned".into()))?;
    let job = map
        .get(&job_id)
        .ok_or_else(|| Error::Other(format!("unknown corpus job: {job_id}")))?;
    Ok(CorpusJobStatus {
        completed: job.completed,
        total: job.total,
        done: job.done,
        error: job.error.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emotion_is_the_stem_before_the_take_number() {
        assert_eq!(emotion_of("neutral_000"), "neutral");
        assert_eq!(emotion_of("quiet_dread_012"), "quiet_dread");
    }

    #[test]
    fn names_without_a_numeric_suffix_count_as_imported() {
        assert_eq!(emotion_of("interview_take"), "imported");
        assert_eq!(emotion_of("recording"), "imported");
        assert_eq!(emotion_of("_007"), "imported");
    }

    #[test]
    fn tag_placement_follows_the_prefix_or_suffix_form() {
        // Mirrors the text assembly in build_corpus.
        let build = |tag: &str, line: &str| {
            if tag.starts_with('[') {
                format!("{}{}", tag, line)
            } else if tag.is_empty() {
                line.to_string()
            } else {
                format!("{}{}", line, tag)
            }
        };
        assert_eq!(build("[sigh] ", "Hello."), "[sigh] Hello.");
        assert_eq!(build(" [sigh]", "Hello."), "Hello. [sigh]");
        assert_eq!(build("", "Hello."), "Hello.");
    }
}
