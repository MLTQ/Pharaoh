//! `pharaoh asset ...` and `pharaoh post ...` commands: sidecar-backed asset
//! listing/QA/takes/row binding, plus clip import, ffmpeg processing,
//! normalize, resample, and Post-server upscaling.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use serde_json::json;

use super::helpers::{
    cli_wav_info, flag_opt, flag_parse, flag_string, parse_flags, poll_job, print_json, submit_job,
};
use crate::app_support::{script_path, update_script_row_fields};
use crate::commands::audio_engine::{
    import_audio_asset_with_projects_dir, normalize_clip, process_clip_asset, resample_to_48k,
    ClipProcessRequest, ImportAudioRequest,
};
use crate::commands::audio_enhance::{output_path_for, write_upscale_sidecar};
use crate::commands::sidecar::{read_sidecar, update_sidecar_qa, write_sidecar};
use crate::error::{Error, Result};
use crate::models::{GeneratedAudioAsset, SidecarMeta};

fn cli_audio_path_from_meta(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let audio_name = name.strip_suffix(".meta.json")?;
    Some(path.with_file_name(audio_name))
}

fn cli_kind_from_model(model: &str) -> &'static str {
    let model = model.to_lowercase();
    if model.contains("qwen") || model.contains("tts") {
        "tts"
    } else if model.contains("ace") || model.contains("music") {
        "music"
    } else {
        "sfx"
    }
}

fn collect_cli_assets(
    root: &Path,
    scene_slug: &str,
    out: &mut Vec<GeneratedAudioAsset>,
) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_cli_assets(&path, scene_slug, out)?;
            continue;
        }

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if !name.ends_with(".wav.meta.json") {
            continue;
        }

        let data = std::fs::read_to_string(&path)?;
        let meta: SidecarMeta = serde_json::from_str(&data)?;
        let Some(audio_path) = cli_audio_path_from_meta(&path) else {
            continue;
        };
        if !audio_path.exists() {
            continue;
        }

        let kind_model = if meta.model == "audiosr" || meta.model == "clip-studio" {
            meta.parent
                .as_ref()
                .and_then(|parent| read_sidecar(parent.clone()).ok().flatten())
                .map(|parent_meta| parent_meta.model)
                .unwrap_or_else(|| meta.model.clone())
        } else {
            meta.model.clone()
        };

        out.push(GeneratedAudioAsset {
            audio_path: audio_path.to_string_lossy().into_owned(),
            meta_path: path.to_string_lossy().into_owned(),
            scene_slug: scene_slug.to_string(),
            kind: cli_kind_from_model(&kind_model).to_string(),
            name: audio_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            duration_ms: meta.duration_actual_ms,
            sample_rate: meta.sample_rate,
            model: meta.model,
            model_variant: meta.model_variant,
            prompt: meta.prompt,
            generated_at: meta.generated_at,
            parent: meta.parent,
            qa_status: meta.qa_status,
        });
    }

    Ok(())
}

pub(super) async fn asset_list(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let kind_filter = flag_opt(&flags, "kind");
    let scene_filter = flag_opt(&flags, "scene");
    let scenes_root = PathBuf::from(&config.projects_dir)
        .join(project_id)
        .join("scenes");
    let mut assets = Vec::new();

    if scenes_root.exists() {
        for entry in std::fs::read_dir(&scenes_root)? {
            let entry = entry?;
            let scene_path = entry.path();
            if !scene_path.is_dir() {
                continue;
            }
            let scene_slug = scene_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if scene_filter
                .as_deref()
                .is_some_and(|wanted| wanted != scene_slug)
            {
                continue;
            }
            collect_cli_assets(&scene_path.join("assets"), &scene_slug, &mut assets)?;
        }
    }

    if let Some(kind) = kind_filter {
        assets.retain(|asset| asset.kind == kind);
    }
    assets.sort_by(|a, b| b.generated_at.cmp(&a.generated_at));
    print_json(&assets)
}

pub(super) async fn asset_meta(audio_path: &str) -> Result<()> {
    let meta = read_sidecar(audio_path.to_string())?.ok_or_else(|| {
        Error::Other(format!(
            "no sidecar metadata for {} (expected {}.meta.json next to it)",
            audio_path, audio_path
        ))
    })?;
    print_json(&meta)
}

pub(super) async fn asset_qa(audio_path: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let status =
        flag_opt(&flags, "status").ok_or_else(|| Error::Other("missing --status".into()))?;
    let notes = flag_string(&flags, "notes", "");
    update_sidecar_qa(audio_path.to_string(), status, notes)?;
    asset_meta(audio_path).await
}

pub(super) async fn asset_takes(audio_path: &str) -> Result<()> {
    let base = PathBuf::from(audio_path);
    let stem = base
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = base
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dir = base.parent().ok_or_else(|| {
        Error::Other(format!(
            "asset path {} has no parent directory",
            audio_path
        ))
    })?;
    let mut takes: Vec<SidecarMeta> = std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with(&stem) && name.ends_with(&format!(".{}.meta.json", ext))
        })
        .filter_map(|entry| {
            std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|data| serde_json::from_str::<SidecarMeta>(&data).ok())
        })
        .collect();
    takes.sort_by_key(|take| take.take_index);
    print_json(&takes)
}

pub(super) async fn asset_use(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    audio_path: &str,
) -> Result<()> {
    if !Path::new(audio_path).exists() {
        return Err(Error::Other(format!(
            "asset file does not exist: {} — run `pharaoh asset list {}` to see available assets",
            audio_path, project_id
        )));
    }
    let meta = read_sidecar(audio_path.to_string()).ok().flatten();
    let mut fields = HashMap::from([("file".to_string(), audio_path.to_string())]);
    if let Some(duration_ms) = meta.and_then(|meta| meta.duration_actual_ms) {
        fields.insert("duration_ms".into(), duration_ms.to_string());
    }
    let projects_dir = PathBuf::from(&config.projects_dir);
    let row = update_script_row_fields(
        &script_path(&projects_dir, project_id, scene_slug),
        row_index,
        fields,
    )?;
    print_json(&row)
}

pub(super) async fn post_import(
    config: &crate::models::AppConfig,
    project_id: &str,
    source_path: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let output_path = import_audio_asset_with_projects_dir(
        &projects_dir,
        ImportAudioRequest {
            project_id: project_id.to_string(),
            source_path: source_path.to_string(),
            label: flag_opt(&flags, "label"),
        },
    )?;
    print_json(&json!({ "project_id": project_id, "output_path": output_path }))
}

pub(super) async fn post_process(input_path: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = process_clip_asset(ClipProcessRequest {
        input_path: input_path.to_string(),
        start_ms: flag_parse(&flags, "start_ms", 0)?,
        end_ms: flag_opt(&flags, "end_ms")
            .map(|_| flag_parse(&flags, "end_ms", 0))
            .transpose()?,
        gain_db: flag_parse(&flags, "gain_db", 0.0)?,
        fade_in_ms: flag_parse(&flags, "fade_in_ms", 0)?,
        fade_out_ms: flag_parse(&flags, "fade_out_ms", 0)?,
        fade_in_curve: flag_opt(&flags, "fade_in_curve"),
        fade_out_curve: flag_opt(&flags, "fade_out_curve"),
        normalize_lufs: flag_opt(&flags, "normalize_lufs")
            .map(|_| flag_parse(&flags, "normalize_lufs", -16.0))
            .transpose()?,
        highpass_hz: flag_opt(&flags, "highpass_hz")
            .map(|_| flag_parse(&flags, "highpass_hz", 0))
            .transpose()?,
        lowpass_hz: flag_opt(&flags, "lowpass_hz")
            .map(|_| flag_parse(&flags, "lowpass_hz", 0))
            .transpose()?,
    })?;
    print_json(&json!({ "input_path": input_path, "output_path": output_path }))
}

fn write_post_child_sidecar(
    input_path: &str,
    output_path: &str,
    model_variant: &str,
    instruct: String,
) -> Result<()> {
    let parent_meta = read_sidecar(input_path.to_string()).ok().flatten();
    let (duration_actual_ms, sample_rate) = cli_wav_info(output_path);
    write_sidecar(
        output_path.to_string(),
        SidecarMeta {
            model: "clip-studio".into(),
            model_variant: Some(model_variant.into()),
            prompt: parent_meta
                .as_ref()
                .map(|meta| meta.prompt.clone())
                .unwrap_or_else(|| "Manual post-processing".into()),
            instruct: Some(instruct),
            speaker: parent_meta.as_ref().and_then(|meta| meta.speaker.clone()),
            language: parent_meta.as_ref().and_then(|meta| meta.language.clone()),
            seed: parent_meta.as_ref().map(|meta| meta.seed).unwrap_or(0),
            temperature: None,
            top_p: None,
            duration_target_ms: duration_actual_ms,
            duration_actual_ms,
            sample_rate,
            generated_at: Utc::now(),
            parent: Some(input_path.to_string()),
            take_index: parent_meta
                .as_ref()
                .map(|meta| meta.take_index + 1)
                .unwrap_or(0),
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )
}

pub(super) async fn post_normalize(input_path: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let target_lufs = flag_parse(&flags, "target_lufs", -16.0)?;
    let output_path = normalize_clip(input_path.to_string(), target_lufs)?;
    write_post_child_sidecar(
        input_path,
        &output_path,
        "ffmpeg-loudnorm",
        format!("normalize_lufs={:.1}", target_lufs),
    )?;
    print_json(&json!({ "input_path": input_path, "output_path": output_path }))
}

pub(super) async fn post_resample(input_path: &str, output_path: &str) -> Result<()> {
    resample_to_48k(input_path.to_string(), output_path.to_string())?;
    write_post_child_sidecar(
        input_path,
        output_path,
        "ffmpeg-resample",
        "resample=48000 stereo".into(),
    )?;
    print_json(&json!({ "input_path": input_path, "output_path": output_path }))
}

#[derive(Serialize)]
struct CliPostUpscaleRequest {
    input_path: String,
    output_path: String,
    model_name: String,
    ddim_steps: u32,
    guidance_scale: f32,
    seed: i64,
}

pub(super) async fn post_upscale(
    config: &crate::models::AppConfig,
    input_path: &str,
    rest: &[String],
) -> Result<()> {
    let mut model = "basic".to_string();
    let mut steps = 50u32;
    let mut guidance = 3.5f32;
    let mut seed = 0i64;

    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--model" => {
                i += 1;
                model = rest
                    .get(i)
                    .cloned()
                    .ok_or_else(|| Error::Other("missing --model value".into()))?;
            }
            "--steps" => {
                i += 1;
                steps = rest
                    .get(i)
                    .ok_or_else(|| Error::Other("missing --steps value".into()))?
                    .parse()
                    .map_err(|_| Error::Other("invalid --steps value".into()))?;
            }
            "--guidance" => {
                i += 1;
                guidance = rest
                    .get(i)
                    .ok_or_else(|| Error::Other("missing --guidance value".into()))?
                    .parse()
                    .map_err(|_| Error::Other("invalid --guidance value".into()))?;
            }
            "--seed" => {
                i += 1;
                seed = rest
                    .get(i)
                    .ok_or_else(|| Error::Other("missing --seed value".into()))?
                    .parse()
                    .map_err(|_| Error::Other("invalid --seed value".into()))?;
            }
            other => return Err(Error::Other(format!("unknown flag: {}", other))),
        }
        i += 1;
    }

    if model != "basic" && model != "speech" {
        return Err(Error::Other("--model must be basic or speech".into()));
    }

    let output_path = output_path_for(Path::new(input_path), &model)?
        .to_string_lossy()
        .to_string();
    let params = CliPostUpscaleRequest {
        input_path: input_path.to_string(),
        output_path: output_path.clone(),
        model_name: model.clone(),
        ddim_steps: steps,
        guidance_scale: guidance,
        seed,
    };
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/upscale", config.post_url),
        &params,
        "Post",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.post_url), &job_id, "Post").await?;
    let final_output = status.output_path.unwrap_or(output_path);
    let duration_ms =
        write_upscale_sidecar(input_path.to_string(), final_output.clone(), model, seed)?;
    print_json(&json!({
        "input_path": input_path,
        "output_path": final_output,
        "duration_ms": duration_ms,
    }))
}
