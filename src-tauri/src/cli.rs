use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::app_support::{
    default_config_path, ensure_app_dirs, load_or_default_app_config, project_dir, read_json,
    read_script_rows, scene_dir, script_path, write_json,
};
use crate::commands::audio_engine::render_scene_with_projects_dir;
use crate::commands::inference::finalize_generation_output;
use crate::error::{Error, Result};
use crate::models::{
    LlmConfig, MusicText2MusicRequest, Project, ScriptRow, SfxT2ARequest, SidecarMeta, Storyboard,
    TtsCustomVoiceRequest, TtsVoiceCloneRequest, TtsVoiceDesignRequest,
};

pub async fn run(args: Vec<String>) -> Result<()> {
    let config_path = default_config_path()?;
    let config = load_or_default_app_config(&config_path)?;
    ensure_app_dirs(&config)?;

    match args.as_slice() {
        [group, action] if group == "project" && action == "list" => {
            project_list(&config).await
        }
        [group, action, project_id] if group == "project" && action == "status" => {
            project_status(&config, project_id).await
        }
        [group, action, rest @ ..] if group == "project" && action == "create" => {
            project_create(&config, rest).await
        }
        [group, action, subaction, project_id, scene_slug]
            if group == "compose" && action == "render" && subaction == "scene" =>
        {
            compose_render_scene(&config, project_id, scene_slug).await
        }
        [group, action, subaction, project_id, scene_slug, row_index]
            if group == "generate" && action == "row" && subaction == "scene" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            generate_row(&config, project_id, scene_slug, row_index).await
        }
        [group, action, subaction, project_id, scene_slug]
            if group == "generate" && action == "all" && subaction == "scene" =>
        {
            generate_all(&config, project_id, scene_slug).await
        }
        _ => Err(Error::Other(usage().to_string())),
    }
}

fn usage() -> &'static str {
    "usage:
  pharaoh project list
  pharaoh project status <project_id>
  pharaoh project create --title <title> [--logline <text>] [--tone <text>]
  pharaoh compose render scene <project_id> <scene_slug>
  pharaoh generate row scene <project_id> <scene_slug> <row_index>
  pharaoh generate all scene <project_id> <scene_slug>"
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    let output = serde_json::to_string_pretty(value)?;
    println!("{output}");
    Ok(())
}

async fn project_list(config: &crate::models::AppConfig) -> Result<()> {
    let root = PathBuf::from(&config.projects_dir);
    let mut projects = vec![];
    if root.exists() {
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let project_json = entry.path().join("project.json");
            if project_json.exists() {
                if let Ok(project) = read_json::<Project>(&project_json) {
                    projects.push(project);
                }
            }
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    print_json(&projects)
}

async fn project_status(config: &crate::models::AppConfig, project_id: &str) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project_path = project_dir(&projects_dir, project_id).join("project.json");
    let storyboard_path = project_dir(&projects_dir, project_id).join("storyboard.json");

    let project: Project = read_json(&project_path)?;
    let storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };

    let mut total_rows = 0usize;
    let mut unresolved_rows = 0usize;
    let mut placed_rows = 0usize;
    for scene in &storyboard.scenes {
        let rows = read_script_rows(&script_path(&projects_dir, project_id, &scene.slug))?;
        total_rows += rows.len();
        unresolved_rows += rows
            .iter()
            .filter(|row| row.track_type != "DIRECTION" && row.file.trim().is_empty())
            .count();
        placed_rows += rows
            .iter()
            .filter(|row| !row.file.trim().is_empty() && !row.start_ms.trim().is_empty())
            .count();
    }

    print_json(&json!({
        "project": {
            "id": project.id,
            "title": project.title,
            "updated_at": project.updated_at,
        },
        "scenes": storyboard.scenes,
        "metrics": {
            "total_scenes": project_scene_count(&storyboard),
            "script_rows": total_rows,
            "unresolved_rows": unresolved_rows,
            "placed_rows": placed_rows,
        }
    }))
}

fn project_scene_count(storyboard: &Storyboard) -> usize {
    storyboard.scenes.len()
}

async fn project_create(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let mut title: Option<String> = None;
    let mut logline: Option<String> = None;
    let mut tone: Option<String> = None;

    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--title" => {
                i += 1;
                title = rest.get(i).cloned();
            }
            "--logline" => {
                i += 1;
                logline = rest.get(i).cloned();
            }
            "--tone" => {
                i += 1;
                tone = rest.get(i).cloned();
            }
            other => {
                return Err(Error::Other(format!("unknown flag: {}", other)));
            }
        }
        i += 1;
    }

    let title = title.ok_or_else(|| Error::Other("missing --title".into()))?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let project = Project {
        id: id.clone(),
        title,
        logline: logline.unwrap_or_default(),
        synopsis: String::new(),
        tone: tone.unwrap_or_default(),
        global_audio_notes: String::new(),
        target_duration_minutes: 30,
        created_at: now,
        updated_at: now,
        characters: vec![],
        llm_config: LlmConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            api_key_env: "ANTHROPIC_API_KEY".into(),
        },
    };

    let projects_dir = PathBuf::from(&config.projects_dir);
    let dir = project_dir(&projects_dir, &id);
    std::fs::create_dir_all(dir.join("scenes"))?;
    std::fs::create_dir_all(dir.join("output"))?;
    write_json(&dir.join("project.json"), &project)?;
    write_json(&dir.join("storyboard.json"), &Storyboard { scenes: vec![] })?;

    print_json(&project)
}

async fn compose_render_scene(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let output_path = render_scene_with_projects_dir(&projects_dir, project_id, scene_slug).await?;
    print_json(&json!({
        "project_id": project_id,
        "scene_slug": scene_slug,
        "output_path": output_path,
    }))
}

async fn generate_row(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project: Project = read_json(&project_dir(&projects_dir, project_id).join("project.json"))?;
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    let row = rows
        .get(row_index)
        .cloned()
        .ok_or_else(|| Error::Other(format!("row {} out of range", row_index)))?;
    let result = generate_script_row(config, &projects_dir, &project, project_id, scene_slug, row_index, row).await?;
    print_json(&result)
}

async fn generate_all(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project: Project = read_json(&project_dir(&projects_dir, project_id).join("project.json"))?;
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    let mut outputs = vec![];

    for (row_index, row) in rows.into_iter().enumerate() {
        if row.track_type == "DIRECTION" || !row.file.trim().is_empty() {
            continue;
        }
        outputs.push(
            generate_script_row(config, &projects_dir, &project, project_id, scene_slug, row_index, row)
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
        "DIALOGUE" => generate_dialogue(config, projects_dir, project, project_id, scene_slug, row_index, row, http).await,
        "SFX" | "BED" => generate_sfx(config, projects_dir, project_id, scene_slug, row_index, row, http).await,
        "MUSIC" => generate_music(config, projects_dir, project_id, scene_slug, row_index, row, http).await,
        other => Err(Error::Other(format!("cannot generate row type {}", other))),
    }
}

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
    let output_path = asset_output_path(projects_dir, project_id, scene_slug, &format!("{stem}_{}", Utc::now().timestamp_millis()));

    let (job_id, meta) = match character
        .map(|character| character.voice_assignment.model.as_str())
        .unwrap_or("CustomVoice")
    {
        "Clone" if character
            .and_then(|character| character.voice_assignment.ref_audio_path.as_ref())
            .is_some() =>
        {
            let character = character.expect("character checked above");
            let params = TtsVoiceCloneRequest {
                text: row.prompt.clone(),
                ref_audio_path: character
                    .voice_assignment
                    .ref_audio_path
                    .clone()
                    .unwrap_or_default(),
                ref_transcript: character
                    .voice_assignment
                    .ref_transcript
                    .clone()
                    .unwrap_or_default(),
                language: "en".into(),
                icl_mode: false,
                seed: random_seed(),
                temperature: 0.7,
                top_p: 0.9,
                max_new_tokens: 1024,
                output_path: output_path.clone(),
            };
            let job_id = submit_job(
                &http,
                format!("{}/generate/voice_clone", config.tts_url),
                &params,
                "TTS",
            )
            .await?;
            let meta = SidecarMeta {
                model: "qwen3-tts-clone".into(),
                model_variant: Some("1.7B".into()),
                prompt: params.text.clone(),
                instruct: None,
                speaker: None,
                language: Some(params.language.clone()),
                seed: params.seed,
                temperature: Some(params.temperature),
                top_p: Some(params.top_p),
                duration_target_ms: None,
                duration_actual_ms: None,
                sample_rate: 24000,
                generated_at: Utc::now(),
                parent: Some(params.ref_audio_path.clone()),
                take_index: 1,
                qa_status: "unreviewed".into(),
                qa_notes: String::new(),
            };
            (job_id, meta)
        }
        "VoiceDesign" => {
            let character = character;
            let params = TtsVoiceDesignRequest {
                text: row.prompt.clone(),
                voice_description: character
                    .and_then(|character| character.voice_assignment.instruct_default.clone())
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| (!row.instruct.trim().is_empty()).then_some(row.instruct.clone()))
                    .unwrap_or_else(|| "neutral voice".into()),
                language: "en".into(),
                seed: random_seed(),
                temperature: 0.7,
                top_p: 0.9,
                max_new_tokens: 2048,
                output_path: output_path.clone(),
            };
            let job_id = submit_job(
                &http,
                format!("{}/generate/voice_design", config.tts_url),
                &params,
                "TTS",
            )
            .await?;
            let meta = SidecarMeta {
                model: "qwen3-tts-voicedesign".into(),
                model_variant: Some("1.7B".into()),
                prompt: params.text.clone(),
                instruct: Some(params.voice_description.clone()),
                speaker: None,
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
            (job_id, meta)
        }
        _ => {
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
            (job_id, meta)
        }
    };

    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status
        .output_path
        .ok_or_else(|| Error::Other("TTS job completed without output_path".into()))?;
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
    let output_path = asset_output_path(projects_dir, project_id, scene_slug, &format!("{stem}_{}", Utc::now().timestamp_millis()));
    let duration_seconds = row
        .duration_ms
        .parse::<f32>()
        .ok()
        .map(|ms| (ms / 1000.0).max(0.5))
        .unwrap_or(3.0);

    let params = SfxT2ARequest {
        prompt: row.prompt.clone(),
        duration_seconds,
        model_variant: "Woosh-DFlow".into(),
        steps: 4,
        seed: random_seed(),
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
    let output_path = status
        .output_path
        .ok_or_else(|| Error::Other("SFX job completed without output_path".into()))?;
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

    let status = poll_job(&http, format!("{}/jobs", config.music_url), &job_id, "Music").await?;
    let output_path = status
        .output_path
        .ok_or_else(|| Error::Other("Music job completed without output_path".into()))?;
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

async fn submit_job<T: Serialize>(
    http: &reqwest::Client,
    url: String,
    params: &T,
    label: &str,
) -> Result<String> {
    let resp: serde_json::Value = http
        .post(url)
        .json(params)
        .send()
        .await
        .map_err(|e| Error::Other(format!("{label} server error: {e}")))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("{label} response error: {e}")))?;

    resp["job_id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Other(format!("{label} response missing job_id")))
}

async fn poll_job(
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
            .map_err(|e| Error::Other(format!("{label} poll error: {e}")))?
            .json::<crate::models::JobStatus>()
            .await
            .map_err(|e| Error::Other(format!("{label} poll parse error: {e}")))?;

        match status.status.as_str() {
            "complete" => return Ok(status),
            "failed" => {
                return Err(Error::Other(
                    status
                        .error
                        .unwrap_or_else(|| format!("{label} generation failed")),
                ))
            }
            _ => {}
        }
    }
}

fn asset_output_path(projects_dir: &Path, project_id: &str, scene_slug: &str, stem: &str) -> String {
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

fn random_seed() -> i64 {
    (Utc::now().timestamp_nanos_opt().unwrap_or_default() % 100_000) as i64
}
