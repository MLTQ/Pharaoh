use super::sidecar::{read_sidecar, write_sidecar};
use crate::error::{Error, Result};
use crate::models::{JobProgressEvent, SidecarMeta};
use chrono::Utc;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};

fn audiosr_cli_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "audiosr.exe"
    } else {
        "audiosr"
    }
}

fn candidate_audiosr_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = std::env::var("PHARAOH_AUDIOSR_CLI") {
        candidates.push(PathBuf::from(path));
    }

    for base in [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf)),
    ]
    .into_iter()
    .flatten()
    {
        for ancestor in base.ancestors() {
            candidates.push(
                ancestor
                    .join("inference")
                    .join(".venv-audiosr")
                    .join("bin")
                    .join(audiosr_cli_name()),
            );
            candidates.push(
                ancestor
                    .join("..")
                    .join("inference")
                    .join(".venv-audiosr")
                    .join("bin")
                    .join(audiosr_cli_name()),
            );
        }
    }

    candidates
}

fn find_audiosr_cli() -> Result<PathBuf> {
    candidate_audiosr_paths()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| Error::Other(
            "AudioSR CLI not found. Run: PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh, or set PHARAOH_AUDIOSR_CLI.".into()
        ))
}

fn output_path_for(input: &Path, model_name: &str) -> Result<PathBuf> {
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

fn scan_newest_wav(
    root: &Path,
    newest: &mut Option<(std::time::SystemTime, PathBuf)>,
) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            scan_newest_wav(&path, newest)?;
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            *newest = Some((modified, path));
        }
    }
    Ok(())
}

fn newest_wav(root: &Path) -> Result<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    scan_newest_wav(root, &mut newest)?;
    newest
        .map(|(_, p)| p)
        .ok_or_else(|| Error::Other("AudioSR completed without producing a WAV".into()))
}

fn wav_duration_ms(path: &Path) -> Option<u64> {
    let reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    Some((reader.duration() as u64 * 1000) / spec.sample_rate as u64)
}

fn emit_progress(app: Option<&AppHandle>, job_id: &str, progress: f32) {
    if let Some(app) = app {
        let _ = app.emit(
            "job-progress",
            &JobProgressEvent {
                job_id: job_id.into(),
                model: "post".into(),
                status: "running".into(),
                progress,
            },
        );
    }
}

fn extract_last_percent(text: &str) -> Option<f32> {
    let bytes = text.as_bytes();
    let mut found = None;
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'%' {
            continue;
        }
        let mut start = i;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start < i {
            if let Ok(n) = text[start..i].parse::<f32>() {
                found = Some((n / 100.0).clamp(0.0, 1.0));
            }
        }
    }
    found
}

async fn capture_audiosr_stream<R>(mut reader: R, app: Option<AppHandle>, job_id: String) -> String
where
    R: AsyncRead + Unpin,
{
    let mut captured = Vec::new();
    let mut buf = [0_u8; 1024];
    let mut max_progress = 0.1_f32;

    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                captured.extend_from_slice(&buf[..n]);
                let chunk = String::from_utf8_lossy(&buf[..n]);
                if let Some(percent) = extract_last_percent(&chunk) {
                    let progress = 0.1 + percent * 0.8;
                    if progress > max_progress {
                        max_progress = progress;
                        emit_progress(app.as_ref(), &job_id, progress);
                    }
                }
            }
            Err(_) => break,
        }
    }

    String::from_utf8_lossy(&captured).into_owned()
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
    upscale_audio_asset_path_with_progress(
        Some(app),
        job_id.unwrap_or_else(|| format!("audiosr-{}", uuid::Uuid::new_v4())),
        input_path,
        model_name,
        ddim_steps,
        guidance_scale,
        seed,
    )
    .await
}

pub async fn upscale_audio_asset_path(
    input_path: String,
    model_name: String,
    ddim_steps: u32,
    guidance_scale: f32,
    seed: i64,
) -> Result<String> {
    upscale_audio_asset_path_with_progress(
        None,
        format!("audiosr-{}", uuid::Uuid::new_v4()),
        input_path,
        model_name,
        ddim_steps,
        guidance_scale,
        seed,
    )
    .await
}

async fn upscale_audio_asset_path_with_progress(
    app: Option<AppHandle>,
    job_id: String,
    input_path: String,
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

    let cli = find_audiosr_cli()?;
    emit_progress(app.as_ref(), &job_id, 0.03);
    let output = output_path_for(&input, &model_name)?;
    let tmp = std::env::temp_dir().join(format!("pharaoh-audiosr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp)?;

    let mut child = tokio::process::Command::new(&cli)
        .arg("-i")
        .arg(&input)
        .arg("-s")
        .arg(&tmp)
        .arg("--model_name")
        .arg(&model_name)
        .arg("--ddim_steps")
        .arg(ddim_steps.to_string())
        .arg("-gs")
        .arg(guidance_scale.to_string())
        .arg("--seed")
        .arg(seed.to_string())
        .arg("--suffix")
        .arg("pharaoh")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Other(format!("failed to run AudioSR: {}", e)))?;

    emit_progress(app.as_ref(), &job_id, 0.08);

    let stdout = child
        .stdout
        .take()
        .map(|r| tokio::spawn(capture_audiosr_stream(r, app.clone(), job_id.clone())));
    let stderr = child
        .stderr
        .take()
        .map(|r| tokio::spawn(capture_audiosr_stream(r, app.clone(), job_id.clone())));

    let status = child
        .wait()
        .await
        .map_err(|e| Error::Other(format!("failed to wait for AudioSR: {}", e)))?;

    let stdout_text = match stdout {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    let stderr_text = match stderr {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };

    if !status.success() {
        let err = if stderr_text.trim().is_empty() {
            stdout_text
        } else {
            stderr_text
        };
        let snippet: String = err.chars().take(4000).collect();
        return Err(Error::Other(format!("AudioSR failed:\n{}", snippet)));
    }

    emit_progress(app.as_ref(), &job_id, 0.92);
    let generated = newest_wav(&tmp)?;
    std::fs::copy(&generated, &output)?;
    let _ = std::fs::remove_dir_all(&tmp);

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
    meta.duration_actual_ms = wav_duration_ms(&output).or(meta.duration_actual_ms);
    meta.sample_rate = 48000;
    meta.generated_at = Utc::now();
    meta.parent = Some(input_path);
    meta.take_index += 1;
    meta.qa_status = "unreviewed".into();
    meta.qa_notes = String::new();

    let output_str = output.to_string_lossy().to_string();
    write_sidecar(output_str.clone(), meta)?;
    Ok(output_str)
}
