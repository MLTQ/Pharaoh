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
        .find(|character| character.name.eq_ignore_ascii_case(&row.character));

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
        .unwrap_or(3.0);
    let use_audioldm = row.track_type == "BED" || duration_seconds > 5.0;

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
            model: format!("woosh-{}", params.model_variant.to_lowercase()),
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
    let output_path = status.output_path.ok_or_else(|| {
        Error::Other(format!(
            "Music job {} completed without output_path (row {} of scene {})",
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
        },
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
