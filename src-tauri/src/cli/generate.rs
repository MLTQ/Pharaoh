//! `pharaoh generate tts-custom|tts-design|tts-clone|sfx|music` — direct
//! generation to caller-provided output paths, without a script row. Also
//! hosts the shared TTS submit/finalize helpers reused by the character
//! voice probe commands.

use std::path::Path;

use chrono::Utc;
use serde_json::json;

use super::helpers::{
    cli_wav_info, flag_opt, flag_parse, flag_string, parse_flags, poll_job, print_json,
    random_seed, submit_job,
};
use crate::commands::sidecar::write_sidecar;
use crate::error::{Error, Result};
use crate::models::{
    MusicText2MusicRequest, SfxT2ARequest, SidecarMeta, TtsCustomVoiceRequest,
    TtsVoiceCloneRequest, TtsVoiceDesignRequest,
};

pub(super) async fn generate_tts_custom(
    config: &crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    let params = TtsCustomVoiceRequest {
        text: flag_opt(&flags, "text").ok_or_else(|| Error::Other("missing --text".into()))?,
        speaker: flag_string(&flags, "speaker", "Vivian"),
        language: flag_string(&flags, "language", "en"),
        instruct: flag_string(&flags, "instruct", ""),
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 2048)?,
        output_path,
    };
    submit_tts_custom_and_finalize(config, params).await
}

pub(super) async fn generate_tts_design(
    config: &crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    let params = TtsVoiceDesignRequest {
        text: flag_opt(&flags, "text").ok_or_else(|| Error::Other("missing --text".into()))?,
        voice_description: flag_opt(&flags, "voice_description")
            .ok_or_else(|| Error::Other("missing --voice-description".into()))?,
        language: flag_string(&flags, "language", "en"),
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 2048)?,
        output_path,
    };
    submit_tts_design_and_finalize(config, params).await
}

pub(super) async fn generate_tts_clone(
    config: &crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    let params = TtsVoiceCloneRequest {
        text: flag_opt(&flags, "text").ok_or_else(|| Error::Other("missing --text".into()))?,
        ref_audio_path: flag_opt(&flags, "ref_audio_path")
            .ok_or_else(|| Error::Other("missing --ref-audio-path".into()))?,
        ref_transcript: flag_string(&flags, "ref_transcript", ""),
        language: flag_string(&flags, "language", "en"),
        icl_mode: flag_parse(&flags, "icl_mode", false)?,
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 1024)?,
        output_path,
    };
    submit_tts_clone_and_finalize(config, params).await
}

async fn submit_tts_custom_and_finalize(
    config: &crate::models::AppConfig,
    params: TtsCustomVoiceRequest,
) -> Result<()> {
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/custom_voice", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status.output_path.unwrap_or(params.output_path.clone());
    write_sidecar(
        output_path.clone(),
        SidecarMeta {
            model: "qwen3-tts-customvoice".into(),
            model_variant: Some("1.7B".into()),
            prompt: params.text,
            instruct: (!params.instruct.is_empty()).then_some(params.instruct),
            speaker: Some(params.speaker),
            language: Some(params.language),
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
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": output_path }))
}

pub(super) async fn submit_tts_design_and_finalize(
    config: &crate::models::AppConfig,
    params: TtsVoiceDesignRequest,
) -> Result<()> {
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/voice_design", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status.output_path.unwrap_or(params.output_path.clone());
    write_sidecar(
        output_path.clone(),
        SidecarMeta {
            model: "qwen3-tts-voicedesign".into(),
            model_variant: Some("1.7B".into()),
            prompt: params.text,
            instruct: Some(params.voice_description),
            speaker: None,
            language: Some(params.language),
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
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": output_path }))
}

pub(super) async fn submit_tts_clone_and_finalize(
    config: &crate::models::AppConfig,
    params: TtsVoiceCloneRequest,
) -> Result<()> {
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/voice_clone", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status.output_path.unwrap_or(params.output_path.clone());
    write_sidecar(
        output_path.clone(),
        SidecarMeta {
            model: "qwen3-tts-clone".into(),
            model_variant: Some("1.7B".into()),
            prompt: params.text,
            instruct: None,
            speaker: None,
            language: Some(params.language),
            seed: params.seed,
            temperature: Some(params.temperature),
            top_p: Some(params.top_p),
            duration_target_ms: None,
            duration_actual_ms: None,
            sample_rate: 24000,
            generated_at: Utc::now(),
            parent: Some(params.ref_audio_path),
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": output_path }))
}

pub(super) async fn generate_direct_sfx(
    config: &crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let prompt =
        flag_opt(&flags, "prompt").ok_or_else(|| Error::Other("missing --prompt".into()))?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    if let Some(parent) = Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)?;
    }

    let backend = flag_opt(&flags, "backend");
    let model_variant = flag_opt(&flags, "model_variant").unwrap_or_else(|| {
        if backend.as_deref() == Some("audioldm") {
            "AudioLDM-M-Full".into()
        } else {
            "Woosh-DFlow".into()
        }
    });
    let is_audioldm =
        backend.as_deref() == Some("audioldm") || model_variant.to_lowercase().contains("audioldm");
    let params = SfxT2ARequest {
        prompt,
        duration_seconds: flag_parse(
            &flags,
            "duration_seconds",
            if is_audioldm { 10.0 } else { 3.0 },
        )?,
        model_variant: model_variant.clone(),
        backend: backend.or_else(|| Some(if is_audioldm { "audioldm" } else { "woosh" }.into())),
        steps: flag_parse(&flags, "steps", if is_audioldm { 200 } else { 4 })?,
        seed: flag_parse(&flags, "seed", random_seed())?,
        cfg_scale: if is_audioldm {
            flag_opt(&flags, "cfg_scale")
                .map(|_| flag_parse(&flags, "cfg_scale", 4.5))
                .transpose()?
        } else {
            Some(flag_parse(&flags, "cfg_scale", 4.5)?)
        },
        guidance_scale: if is_audioldm {
            Some(flag_parse(&flags, "guidance_scale", 2.5)?)
        } else {
            flag_opt(&flags, "guidance_scale")
                .map(|_| flag_parse(&flags, "guidance_scale", 2.5))
                .transpose()?
        },
        negative_prompt: flag_opt(&flags, "negative_prompt").or_else(|| {
            is_audioldm.then_some(
                "speech, talking, music, melody, low quality, distorted, clipped, noisy artifacts"
                    .into(),
            )
        }),
        num_waveforms_per_prompt: if is_audioldm {
            Some(flag_parse(&flags, "num_waveforms_per_prompt", 1)?)
        } else {
            flag_opt(&flags, "num_waveforms_per_prompt")
                .map(|_| flag_parse(&flags, "num_waveforms_per_prompt", 1))
                .transpose()?
        },
        output_path: output_path.clone(),
    };

    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/t2a", config.sfx_url),
        &params,
        "SFX",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.sfx_url), &job_id, "SFX").await?;
    let final_output = status.output_path.unwrap_or(output_path);
    let (duration_actual_ms, sample_rate) = cli_wav_info(&final_output);
    write_sidecar(
        final_output.clone(),
        SidecarMeta {
            model: format!(
                "{}-{}",
                if is_audioldm { "audioldm" } else { "woosh" },
                params.model_variant.to_lowercase()
            ),
            model_variant: Some(params.model_variant.clone()),
            prompt: params.prompt.clone(),
            instruct: params
                .negative_prompt
                .clone()
                .map(|p| format!("negative={}", p)),
            speaker: None,
            language: None,
            seed: params.seed,
            temperature: None,
            top_p: None,
            duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
            duration_actual_ms,
            sample_rate,
            generated_at: Utc::now(),
            parent: None,
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": final_output }))
}

pub(super) async fn generate_direct_music(
    config: &crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    if let Some(parent) = Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let params = MusicText2MusicRequest {
        caption: flag_opt(&flags, "caption")
            .ok_or_else(|| Error::Other("missing --caption".into()))?,
        lyrics: flag_string(&flags, "lyrics", ""),
        duration_seconds: flag_parse(&flags, "duration_seconds", 30.0)?,
        bpm: flag_opt(&flags, "bpm")
            .map(|_| flag_parse(&flags, "bpm", 0))
            .transpose()?
            .filter(|bpm| *bpm > 0),
        key: flag_string(&flags, "key", ""),
        language: flag_string(&flags, "language", "en"),
        lm_model_size: flag_string(&flags, "lm_model_size", "1.7B"),
        diffusion_steps: flag_parse(&flags, "diffusion_steps", 60)?,
        thinking_mode: flag_parse(&flags, "thinking_mode", false)?,
        reference_audio_path: flag_string(&flags, "reference_audio_path", ""),
        seed: flag_parse(&flags, "seed", random_seed())?,
        batch_size: flag_parse(&flags, "batch_size", 1)?,
        output_path: output_path.clone(),
    };

    let http = reqwest::Client::new();
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
    let final_output = status.output_path.unwrap_or(output_path);
    let (duration_actual_ms, sample_rate) = cli_wav_info(&final_output);
    write_sidecar(
        final_output.clone(),
        SidecarMeta {
            model: "ace-step-1.5".into(),
            model_variant: Some(params.lm_model_size.clone()),
            prompt: params.caption.clone(),
            instruct: (!params.lyrics.is_empty()).then_some(params.lyrics.clone()),
            speaker: None,
            language: Some(params.language.clone()),
            seed: params.seed,
            temperature: None,
            top_p: None,
            duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
            duration_actual_ms,
            sample_rate,
            generated_at: Utc::now(),
            parent: (!params.reference_audio_path.is_empty())
                .then_some(params.reference_audio_path.clone()),
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": final_output }))
}
