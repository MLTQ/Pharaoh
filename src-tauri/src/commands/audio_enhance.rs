use super::sidecar::{read_sidecar, write_sidecar};
use crate::error::{Error, Result};
use crate::models::{
    AppState, JobCompleteEvent, JobFailedEvent, JobProgressEvent, JobStatus, SidecarMeta,
};
use chrono::Utc;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Serialize)]
struct PostUpscaleRequest {
    job_id: String,
    input_path: String,
    output_path: String,
    model_name: String,
    ddim_steps: u32,
    guidance_scale: f32,
    seed: i64,
}

pub fn output_path_for(input: &Path, model_name: &str) -> Result<PathBuf> {
    let parent = input
        .parent()
        .ok_or_else(|| Error::Other("input has no parent directory".into()))?;
    let stem = input.file_stem().unwrap_or_default().to_string_lossy();
    Ok(parent.join(format!(
        "{}.upscaled.{}.{}.wav",
        stem,
        model_name,
        Utc::now().timestamp_millis()
    )))
}

fn wav_duration_ms(path: &Path) -> Option<u64> {
    let reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    Some((reader.duration() as u64 * 1000) / spec.sample_rate as u64)
}

pub fn write_upscale_sidecar(
    input_path: String,
    output_path: String,
    model_name: String,
    seed: i64,
) -> Result<Option<u64>> {
    let output = PathBuf::from(&output_path);
    let duration_ms = wav_duration_ms(&output);
    let input = PathBuf::from(&input_path);
    let parent_meta = read_sidecar(input_path.clone())?;
    let mut meta = parent_meta.unwrap_or_else(|| SidecarMeta {
        model: "unknown".into(),
        model_variant: None,
        prompt: input
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        instruct: None,
        speaker: None,
        language: None,
        seed,
        temperature: None,
        top_p: None,
        duration_target_ms: None,
        duration_actual_ms: None,
        sample_rate: 48000,
        generated_at: Utc::now(),
        parent: None,
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    });

    meta.model = "audiosr".into();
    meta.model_variant = Some(model_name);
    meta.seed = seed;
    meta.duration_actual_ms = duration_ms.or(meta.duration_actual_ms);
    meta.sample_rate = 48000;
    meta.generated_at = Utc::now();
    meta.parent = Some(input_path);
    meta.take_index += 1;
    meta.qa_status = "unreviewed".into();
    meta.qa_notes = String::new();

    write_sidecar(output_path, meta)?;
    Ok(duration_ms)
}

async fn poll_post_until_done(
    app: AppHandle,
    http: reqwest::Client,
    jobs_url: String,
    job_id: String,
    input_path: String,
    output_path: String,
    model_name: String,
    seed: i64,
) {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;

        let result = http
            .get(format!("{}/{}", jobs_url, job_id))
            .timeout(Duration::from_secs(5))
            .send()
            .await;

        let status: JobStatus = match result {
            Ok(r) => match r.json().await {
                Ok(s) => s,
                Err(e) => {
                    let _ = app.emit(
                        "job-failed",
                        &JobFailedEvent {
                            job_id: job_id.clone(),
                            model: "post".into(),
                            error: format!("parse error: {}", e),
                        },
                    );
                    return;
                }
            },
            Err(e) => {
                let _ = app.emit(
                    "job-failed",
                    &JobFailedEvent {
                        job_id: job_id.clone(),
                        model: "post".into(),
                        error: format!("poll error: {}", e),
                    },
                );
                return;
            }
        };

        let _ = app.emit(
            "job-progress",
            &JobProgressEvent {
                job_id: job_id.clone(),
                model: "post".into(),
                status: status.status.clone(),
                progress: status.progress,
            },
        );

        match status.status.as_str() {
            "complete" => {
                let final_output = status.output_path.unwrap_or_else(|| output_path.clone());
                let duration_ms =
                    match write_upscale_sidecar(input_path, final_output.clone(), model_name, seed)
                    {
                        Ok(duration_ms) => duration_ms,
                        Err(e) => {
                            let _ = app.emit(
                                "job-failed",
                                &JobFailedEvent {
                                    job_id: job_id.clone(),
                                    model: "post".into(),
                                    error: format!("finalization error: {}", e),
                                },
                            );
                            return;
                        }
                    };

                let _ = app.emit(
                    "job-complete",
                    &JobCompleteEvent {
                        job_id,
                        model: "post".into(),
                        output_path: final_output,
                        project_id: String::new(),
                        scene_slug: String::new(),
                        row_index: 0,
                        duration_ms,
                        bound_to_script: false,
                    },
                );
                return;
            }
            "failed" => {
                let _ = app.emit(
                    "job-failed",
                    &JobFailedEvent {
                        job_id: job_id.clone(),
                        model: "post".into(),
                        error: status.error.unwrap_or_else(|| "unknown error".into()),
                    },
                );
                return;
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn upscale_audio_asset(
    app: AppHandle,
    input_path: String,
    job_id: Option<String>,
    model_name: String,
    ddim_steps: u32,
    guidance_scale: f32,
    seed: i64,
) -> Result<String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(Error::Other(format!(
            "input audio not found: {}",
            input_path
        )));
    }

    let state = app.state::<AppState>();
    let (base_url, http) = {
        let cfg = state
            .server_config
            .read()
            .map_err(|_| Error::Other("lock poisoned".into()))?;
        (cfg.post_url.clone(), state.http.clone())
    };
    let job_id = job_id.unwrap_or_else(|| format!("audiosr-{}", uuid::Uuid::new_v4()));
    let output_path = output_path_for(&input, &model_name)?
        .to_string_lossy()
        .to_string();
    let params = PostUpscaleRequest {
        job_id: job_id.clone(),
        input_path: input_path.clone(),
        output_path: output_path.clone(),
        model_name: model_name.clone(),
        ddim_steps,
        guidance_scale,
        seed,
    };

    let resp: serde_json::Value = http
        .post(format!("{}/generate/upscale", base_url))
        .json(&params)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("Post server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("Post response error: {}", e)))?;

    let server_job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id".into()))?
        .to_string();

    tokio::spawn(poll_post_until_done(
        app,
        http,
        format!("{}/jobs", base_url),
        server_job_id,
        input_path,
        output_path,
        model_name,
        seed,
    ));

    Ok(job_id)
}
