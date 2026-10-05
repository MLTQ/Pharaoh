//! `pharaoh generate row scene ...` and `pharaoh generate all scene ...` —
//! per-row generation from script.csv: routes each row type to the proper
//! inference endpoint, waits for completion, and binds outputs back into the
//! script via `finalize_generation_output`.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

use super::helpers::{load_project, poll_job, print_json, random_seed, submit_job};
use crate::app_support::{read_script_rows, scene_dir, script_path};
use crate::commands::inference::finalize_generation_output;
use crate::error::{Error, Result};
use crate::models::{
    MusicText2MusicRequest, Project, ScriptRow, SfxT2ARequest, SidecarMeta, TtsCustomVoiceRequest,
};

pub(super) async fn generate_row(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project = load_project(config, project_id)?;
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    let row = rows.get(row_index).cloned().ok_or_else(|| {
        Error::Other(format!(
            "row {} out of range for scene {} in project {} ({} rows) — run `pharaoh script read {} {}`",
            row_index,
            scene_slug,
            project_id,
            rows.len(),
            project_id,
            scene_slug
        ))
    })?;
    let result = generate_script_row(
        config,
        &projects_dir,
        &project,
        project_id,
        scene_slug,
        row_index,
        row,
    )
    .await?;
    print_json(&result)
}

pub(super) async fn generate_all(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project = load_project(config, project_id)?;
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    let mut outputs = vec![];

    for (row_index, row) in rows.into_iter().enumerate() {
        if row.track_type == "DIRECTION" || !row.file.trim().is_empty() {
            continue;
        }
        outputs.push(
            generate_script_row(
                config,
                &projects_dir,
                &project,
                project_id,
                scene_slug,
                row_index,
                row,
            )
            .await?,
        );
    }

    print_json(&outputs)
}

#[derive(Serialize)]
struct GeneratedRowResult {
    project_id: String,
    scene_slug: String,
    row_index: usize,
    model: String,
    output_path: String,
    duration_ms: Option<u64>,
    bound_to_script: bool,
}

async fn generate_script_row(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project: &Project,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
) -> Result<GeneratedRowResult> {
    let http = reqwest::Client::new();
    match row.track_type.as_str() {
        "DIALOGUE" => {
            generate_dialogue(
                config,
                projects_dir,
                project,
                project_id,
                scene_slug,
                row_index,
                row,
                http,
            )
            .await
        }
        "SFX" | "BED" => {
            generate_sfx(
                config,
                projects_dir,
                project_id,
                scene_slug,
                row_index,
                row,
                http,
            )
            .await
        }
        "MUSIC" => {
            generate_music(
                config,
                projects_dir,
                project_id,
                scene_slug,
                row_index,
                row,
                http,
            )
            .await
        }
        other => Err(Error::Other(format!(
            "cannot generate row type {} (row {} of scene {}) — only DIALOGUE, SFX, BED, and MUSIC rows are generatable",
            other, row_index, scene_slug
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
async fn generate_dialogue(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project: &Project,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    let character = project
        .characters
        .iter()
        // Compiled scripts carry the character id; hand-written CSVs often the name.
        .find(|character| character.id == row.character || character.name.eq_ignore_ascii_case(&row.character));

    let stem = sanitized_stem(
        character
            .map(|character| character.id.as_str())
            .or_else(|| (!row.character.is_empty()).then_some(row.character.as_str()))
            .unwrap_or("dialogue"),
    );
    let output_path = asset_output_path(
        projects_dir,
        project_id,
        scene_slug,
        &format!("{stem}_{}", Utc::now().timestamp_millis()),
    );

    // A cloned voice (gold reference) is cloned on the TTS port — Breeze, with
    // the line's direction, or Qwen3-TTS where Breeze isn't installed — from
    // the gold clip or the palette reference the row's emotion names. Everyone
    // else uses the TTS server's preset speakers.
    if let Some(ch) = character.filter(|c| c.voice_assignment.ref_audio_path.as_deref().is_some_and(|p| !p.trim().is_empty())) {
        return generate_cloned(config, projects_dir, project_id, scene_slug, row_index, &row, ch, &output_path, http).await;
    }

    let speaker = character
        .and_then(|character| character.voice_assignment.speaker.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Vivian".into());
    let instruct = (!row.instruct.trim().is_empty())
        .then_some(row.instruct.clone())
        .or_else(|| {
            character.and_then(|character| character.voice_assignment.instruct_default.clone())
        })
        .unwrap_or_default();
    let params = TtsCustomVoiceRequest {
        text: row.prompt.clone(),
        speaker: speaker.clone(),
        language: "en".into(),
        instruct: instruct.clone(),
        seed: random_seed(),
        temperature: 0.7,
        top_p: 0.9,
        max_new_tokens: 2048,
        output_path: output_path.clone(),
    };
    let job_id = submit_job(
        &http,
        format!("{}/generate/custom_voice", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let meta = SidecarMeta {
        model: "qwen3-tts-customvoice".into(),
        model_variant: Some("1.7B".into()),
        prompt: params.text.clone(),
        instruct: if params.instruct.is_empty() {
            None
        } else {
            Some(params.instruct.clone())
        },
        speaker: Some(params.speaker.clone()),
        language: Some(params.language.clone()),
        seed: params.seed,
        temperature: Some(params.temperature),
        top_p: Some(params.top_p),
        duration_target_ms: None,
        duration_actual_ms: None,
        sample_rate: 24000,
        generated_at: Utc::now(),
        parent: None,
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };

    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status.output_path.ok_or_else(|| {
        Error::Other(format!(
            "TTS job {} completed without output_path (row {} of scene {})",
            job_id, row_index, scene_slug
        ))
    })?;
    let finalized = finalize_generation_output(
        projects_dir,
        project_id,
        scene_slug,
        row_index,
        &output_path,
        meta,
    )?;

    Ok(GeneratedRowResult {
        project_id: project_id.into(),
        scene_slug: scene_slug.into(),
        row_index,
        model: "tts".into(),
        output_path: finalized.output_path,
        duration_ms: finalized.duration_ms,
        bound_to_script: finalized.bound_to_script,
    })
}

/// The palette entry a row asks for: its `emotion` column, or a word in its
/// direction ("angrily", "furious") naming an approved emotion. Mirrors
/// `paletteEntryFor` in useGenerateJob.ts.
fn palette_for<'a>(c: &'a crate::models::Character, row: &ScriptRow) -> Option<&'a crate::models::PaletteEntry> {
    let entries: Vec<&crate::models::PaletteEntry> = c
        .voice_assignment
        .emotional_palette
        .iter()
        .filter(|e| e.ref_audio_path.is_some() && e.qa_status == "approved")
        .collect();
    let exact = |n: &str| entries.iter().copied().find(|e| e.emotion.eq_ignore_ascii_case(n) || e.label.eq_ignore_ascii_case(n));
    if let Some(e) = exact(row.emotion.trim()) {
        return Some(e);
    }
    const SYN: &[(&str, &str)] = &[
        ("furious", "angry"), ("irate", "angry"), ("annoyed", "angry"), ("terrified", "afraid"), ("scared", "afraid"),
        ("frightened", "afraid"), ("fearful", "afraid"), ("joyful", "happy"), ("cheerful", "happy"), ("glad", "happy"),
        ("tearful", "sad"), ("sorrowful", "sad"), ("hushed", "whisper"), ("quietly", "whisper"), ("softly", "tender"),
        ("gently", "tender"), ("warmly", "tender"), ("sarcastic", "sardonic"), ("sarcastically", "sardonic"),
        ("dryly", "sardonic"), ("thrilled", "excited"), ("eagerly", "excited"),
    ];
    let strip = |w: &str| {
        let mut w = w.to_string();
        for _ in 0..2 {
            for suf in ["ily", "ly", "ness", "ed", "ing", "er", "y"] {
                if w.len() > suf.len() + 2 && w.ends_with(suf) {
                    w.truncate(w.len() - suf.len());
                    break;
                }
            }
        }
        w.chars().take(5).collect::<String>()
    };
    let note = format!("{} {}", row.emotion, row.instruct).to_lowercase();
    let words: Vec<String> = note
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| !w.is_empty())
        .map(|w| SYN.iter().find(|(k, _)| *k == w).map(|(_, v)| v.to_string()).unwrap_or_else(|| w.to_string()))
        .collect();
    entries.into_iter().find(|e| {
        let k = strip(&e.emotion.to_lowercase());
        k.len() >= 3 && words.iter().any(|w| { let v = strip(w); v.len() >= 3 && (v.starts_with(&k) || k.starts_with(&v)) })
    })
}

#[allow(clippy::too_many_arguments)]
async fn generate_cloned(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: &ScriptRow,
    c: &crate::models::Character,
    output_path: &str,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    use crate::commands::inference::{download_remote_file_to, is_remote_url, upload_input_file};
    let palette = palette_for(c, row);
    let raw_ref = palette.and_then(|e| e.ref_audio_path.clone()).or_else(|| c.voice_assignment.ref_audio_path.clone()).unwrap_or_default();
    // Project bundles store paths relative to the character's folder.
    let local_ref = if Path::new(&raw_ref).is_absolute() {
        raw_ref
    } else {
        crate::app_support::character_dir(projects_dir, project_id, &c.id).join(&raw_ref).to_string_lossy().into_owned()
    };
    let transcript = palette.and_then(|e| e.ref_transcript.clone()).or_else(|| c.voice_assignment.ref_transcript.clone()).unwrap_or_default();
    // The TTS port clones: Breeze performs the direction; Qwen3-TTS (without
    // Breeze) clones the voice and ignores it. Voice lock runs after either.
    let breeze = tts_engine(&http, &config.tts_url).await == "breeze";
    let base = config.tts_url.trim_end_matches('/').to_string();
    let remote = is_remote_url(&base);
    let ref_for_server = if remote { upload_input_file(&http, &base, &local_ref).await? } else { local_ref.clone() };
    let seed = random_seed();
    let out_field = if remote { String::new() } else { output_path.to_string() };
    // The direction: the palette emotion's written direction, plus the row's
    // own note when it says more than the emotion's name.
    let note = format!("{} {}", row.emotion, row.instruct).trim().to_string();
    let just_name = palette.is_some_and(|e| note.eq_ignore_ascii_case(&e.emotion) || note.eq_ignore_ascii_case(&e.label));
    let direction = [if just_name { "" } else { note.as_str() }, palette.map(|e| e.direction.as_str()).unwrap_or("")]
        .iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
    let label = if breeze { "Breeze" } else { "Qwen3-TTS" };
    let body = serde_json::json!({
        "text": row.prompt, "ref_audio_path": ref_for_server, "ref_transcript": transcript,
        "instruct": direction, "seed": seed, "output_path": out_field,
    });
    let job_id = submit_job(&http, format!("{}/generate/voice_clone", base), &body, label).await?;
    let status = poll_job(&http, format!("{}/jobs", base), &job_id, label).await?;
    let result = status.result.clone().unwrap_or_default();
    let local_out = if remote {
        download_remote_file_to(&http, &base, &job_id, output_path).await?
    } else {
        status.output_path.unwrap_or_else(|| output_path.to_string())
    };
    // Voice lock (optional): calm lines pass through the character's RVC model.
    let (local_out, lock_note) = match voice_lock(config, projects_dir, project_id, c, &row.prompt, &direction, &local_out, &http).await {
        Ok(Some((path, note))) => (path, note),
        Ok(None) => (local_out, String::new()),
        Err(e) => {
            eprintln!("warning: voice lock skipped for row {}: {}", row_index, e);
            (local_out, String::new())
        }
    };
    // What the take check found (Breeze), kept with the take.
    let check = match (result["wer"].as_f64(), result["heard"].as_str()) {
        (Some(w), Some(h)) => format!("take check: {:.0}% off the script; heard \"{}\"", w * 100.0, h),
        _ => String::new(),
    };
    let fixed_ref = if result["ref_transcript_corrected"].as_bool() == Some(true) { " · reference transcript corrected" } else { "" };
    let meta = SidecarMeta {
        model: if breeze { "breeze-tts-2-direction".into() } else { "qwen3-tts-clone".into() },
        model_variant: None,
        prompt: row.prompt.clone(),
        instruct: result["instruct"].as_str().map(str::to_string).filter(|s| !s.is_empty())
            .or_else(|| palette.map(|e| format!("palette: {}", e.label))),
        speaker: Some(c.name.clone()),
        language: Some("en".into()),
        seed,
        temperature: None,
        top_p: None,
        duration_target_ms: None,
        duration_actual_ms: None,
        sample_rate: if lock_note.is_empty() { 24000 } else { 48000 },
        generated_at: Utc::now(),
        parent: Some(local_ref),
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: format!("{}{}{}", check, fixed_ref, lock_note),
    };
    let finalized = finalize_generation_output(projects_dir, project_id, scene_slug, row_index, &local_out, meta)?;
    Ok(GeneratedRowResult {
        project_id: project_id.into(),
        scene_slug: scene_slug.into(),
        row_index,
        model: format!("{}{}", if breeze { "breeze" } else { "qwen3-tts" }, if palette.is_some() { " (palette)" } else { "" }),
        output_path: finalized.output_path,
        duration_ms: finalized.duration_ms,
        bound_to_script: finalized.bound_to_script,
    })
}

/// Run a finished take through the character's RVC model when voice lock is
/// on and the line is one it suits. Returns the locked file and a note for the
/// sidecar, or `None` when the take stays as the engine made it.
#[allow(clippy::too_many_arguments)]
async fn voice_lock(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project_id: &str,
    c: &crate::models::Character,
    text: &str,
    direction: &str,
    take: &str,
    http: &reqwest::Client,
) -> Result<Option<(String, String)>> {
    use crate::commands::rvc;
    let Some(cfg) = c.voice_assignment.rvc.as_ref().filter(|r| rvc::locks_line(r, text, direction)) else {
        return Ok(None);
    };
    let char_dir = crate::app_support::character_dir(projects_dir, project_id, &c.id);
    let pth = rvc::local_model(&char_dir, cfg).ok_or_else(|| Error::Other("voice lock is on but no model is trained".into()))?;
    let base = config.rvc_url.trim_end_matches('/').to_string();
    let (model, index) = rvc::server_model_paths(http, &base, &c.id, &pth).await?;
    let out = rvc::lock_output_path(take);
    let body = rvc::voice_lock_body(cfg, take, &out, &model, &index);
    let job_id = submit_job(http, format!("{}/convert", base), &body, "RVC").await?;
    let status = poll_job(http, format!("{}/jobs", base), &job_id, "RVC").await?;
    Ok(Some((status.output_path.unwrap_or(out), format!(" · voice lock (RVC, index {:.2})", cfg.index_rate))))
}

/// The TTS server's engine ("breeze" or "" for Qwen), checked once per run.
async fn tts_engine(http: &reqwest::Client, tts_url: &str) -> String {
    static ENGINE: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    ENGINE
        .get_or_init(|| async {
            match http.get(format!("{}/health", tts_url)).timeout(std::time::Duration::from_secs(10)).send().await {
                Ok(r) => r.json::<serde_json::Value>().await.ok().and_then(|h| h["engine"].as_str().map(str::to_string)).unwrap_or_default(),
                Err(_) => String::new(),
            }
        })
        .await
        .clone()
}

/// The SFX server's default engine ("moss" or "woosh"), checked once per run.
async fn sfx_engine(http: &reqwest::Client, sfx_url: &str) -> String {
    static ENGINE: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    ENGINE
        .get_or_init(|| async {
            match http.get(format!("{}/health", sfx_url)).timeout(std::time::Duration::from_secs(10)).send().await {
                Ok(r) => r.json::<serde_json::Value>().await.ok().and_then(|h| h["engine"].as_str().map(str::to_string)).unwrap_or_default(),
                Err(_) => String::new(),
            }
        })
        .await
        .clone()
}

/// Whether the SFX server reports AudioLDM usable (checked once per run).
async fn audioldm_ready(http: &reqwest::Client, sfx_url: &str) -> bool {
    static READY: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();
    *READY
        .get_or_init(|| async {
            match http.get(format!("{}/health", sfx_url)).timeout(std::time::Duration::from_secs(10)).send().await {
                Ok(r) => r.json::<serde_json::Value>().await.ok().and_then(|h| h["audioldm_ready"].as_bool()).unwrap_or(false),
                Err(_) => false,
            }
        })
        .await
}

async fn generate_sfx(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    let stem = sanitized_stem(&row.track.to_lowercase());
    let output_path = asset_output_path(
        projects_dir,
        project_id,
        scene_slug,
        &format!("{stem}_{}", Utc::now().timestamp_millis()),
    );
    let duration_seconds = row
        .duration_ms
        .parse::<f32>()
        .ok()
        .map(|ms| (ms / 1000.0).max(0.5))
        .unwrap_or(if row.track_type == "BED" { 30.0 } else { 3.0 });
    // MOSS-SoundEffect, where the server has it, does effects and beds (to
    // 30 s; beds loop under the scene).
    if sfx_engine(&http, &config.sfx_url).await == "moss" {
        let params = SfxT2ARequest {
            prompt: row.prompt.clone(),
            duration_seconds: duration_seconds.min(30.0),
            model_variant: "MOSS-SFX-v2".into(),
            backend: Some("moss".into()),
            steps: 100,
            seed: random_seed(),
            cfg_scale: None,
            guidance_scale: None,
            negative_prompt: None,
            num_waveforms_per_prompt: None,
            output_path: output_path.clone(),
        };
        return run_sfx(config, projects_dir, project_id, scene_slug, row_index, params, "moss-soundeffect-v2", http).await;
    }
    // Otherwise beds and long effects prefer AudioLDM — when the server says it's usable.
    let wants_audioldm = row.track_type == "BED" || duration_seconds > 5.0;
    let use_audioldm = wants_audioldm && audioldm_ready(&http, &config.sfx_url).await;
    if wants_audioldm && !use_audioldm {
        eprintln!("note: AudioLDM isn't usable on {} (see `pharaoh server health sfx`); using Woosh for row {}", config.sfx_url, row_index);
    }

    // Woosh tops out at 10 s; a longer bed is looped by the renderer.
    let duration_seconds = if use_audioldm { duration_seconds } else { duration_seconds.min(10.0) };
    let params = SfxT2ARequest {
        prompt: row.prompt.clone(),
        duration_seconds,
        model_variant: if use_audioldm {
            "AudioLDM-M-Full".into()
        } else {
            "Woosh-DFlow".into()
        },
        backend: Some(if use_audioldm { "audioldm" } else { "woosh" }.into()),
        steps: if use_audioldm { 200 } else { 4 },
        seed: random_seed(),
        cfg_scale: (!use_audioldm).then_some(4.5),
        guidance_scale: use_audioldm.then_some(2.5),
        negative_prompt: use_audioldm.then_some(
            "speech, talking, music, melody, low quality, distorted, clipped, noisy artifacts"
                .into(),
        ),
        num_waveforms_per_prompt: use_audioldm.then_some(1),
        output_path: output_path.clone(),
    };
    let model = format!("woosh-{}", params.model_variant.to_lowercase());
    run_sfx(config, projects_dir, project_id, scene_slug, row_index, params, &model, http).await
}

#[allow(clippy::too_many_arguments)]
async fn run_sfx(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    params: SfxT2ARequest,
    model: &str,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    let job_id = submit_job(
        &http,
        format!("{}/generate/t2a", config.sfx_url),
        &params,
        "SFX",
    )
    .await?;

    let status = poll_job(&http, format!("{}/jobs", config.sfx_url), &job_id, "SFX").await?;
    let output_path = status.output_path.ok_or_else(|| {
        Error::Other(format!(
            "SFX job {} completed without output_path (row {} of scene {})",
            job_id, row_index, scene_slug
        ))
    })?;
    let finalized = finalize_generation_output(
        projects_dir,
        project_id,
        scene_slug,
        row_index,
        &output_path,
        SidecarMeta {
            model: model.to_string(),
            model_variant: Some(params.model_variant.clone()),
            prompt: params.prompt.clone(),
            instruct: None,
            speaker: None,
            language: None,
            seed: params.seed,
            temperature: None,
            top_p: None,
            duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
            duration_actual_ms: None,
            sample_rate: 48000,
            generated_at: Utc::now(),
            parent: None,
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;

    Ok(GeneratedRowResult {
        project_id: project_id.into(),
        scene_slug: scene_slug.into(),
        row_index,
        model: "sfx".into(),
        output_path: finalized.output_path,
        duration_ms: finalized.duration_ms,
        bound_to_script: finalized.bound_to_script,
    })
}

async fn generate_music(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    let output_path = asset_output_path(
        projects_dir,
        project_id,
        scene_slug,
        &format!("music_{}", Utc::now().timestamp_millis()),
    );
    let duration_seconds = row
        .duration_ms
        .parse::<f32>()
        .ok()
        .map(|ms| (ms / 1000.0).max(1.0))
        .unwrap_or(30.0);
    let params = MusicText2MusicRequest {
        caption: row.prompt.clone(),
        lyrics: String::new(),
        duration_seconds,
        bpm: None,
        key: String::new(),
        language: "en".into(),
        lm_model_size: "1.7B".into(),
        diffusion_steps: 60,
        thinking_mode: false,
        reference_audio_path: String::new(),
        seed: random_seed(),
        batch_size: 1,
        output_path: output_path.clone(),
        instrumental: None,
    };

    let job_id = submit_job(
        &http,
        format!("{}/generate/text2music", config.music_url),
        &params,
        "Music",
    )
    .await?;

    let status = poll_job(
        &http,
        format!("{}/jobs", config.music_url),
        &job_id,
        "Music",
    )
    .await?;
    let output_path = status.output_path.clone().ok_or_else(|| {
        Error::Other(format!(
            "Music job {} completed without output_path (row {} of scene {})",
            job_id, row_index, scene_slug
        ))
    })?;
    let mut meta = SidecarMeta {
        model: "ace-step-1.5".into(),
        model_variant: Some(params.lm_model_size.clone()),
        prompt: params.caption.clone(),
        instruct: None,
        speaker: None,
        language: Some(params.language.clone()),
        seed: params.seed,
        temperature: None,
        top_p: None,
        duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
        duration_actual_ms: None,
        sample_rate: 44100,
        generated_at: Utc::now(),
        parent: None,
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };
    meta.apply_server_model(&status);
    let finalized = finalize_generation_output(
        projects_dir,
        project_id,
        scene_slug,
        row_index,
        &output_path,
        meta,
    )?;

    Ok(GeneratedRowResult {
        project_id: project_id.into(),
        scene_slug: scene_slug.into(),
        row_index,
        model: "music".into(),
        output_path: finalized.output_path,
        duration_ms: finalized.duration_ms,
        bound_to_script: finalized.bound_to_script,
    })
}

fn asset_output_path(
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    stem: &str,
) -> String {
    scene_dir(projects_dir, project_id, scene_slug)
        .join("assets")
        .join(format!("{stem}.wav"))
        .to_string_lossy()
        .to_string()
}

fn sanitized_stem(input: &str) -> String {
    let filtered: String = input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    filtered.trim_matches('_').to_string()
}
