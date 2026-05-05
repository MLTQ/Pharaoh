use super::sidecar::{read_sidecar, write_sidecar};
use crate::error::{Error, Result};
use crate::models::SidecarMeta;
use chrono::Utc;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

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

#[tauri::command]
pub async fn upscale_audio_asset(
    _app: AppHandle,
    input_path: String,
    model_name: String,
    ddim_steps: u32,
    guidance_scale: f32,
    seed: i64,
) -> Result<String> {
    upscale_audio_asset_path(input_path, model_name, ddim_steps, guidance_scale, seed).await
}

pub async fn upscale_audio_asset_path(
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
    let output = output_path_for(&input, &model_name)?;
    let tmp = std::env::temp_dir().join(format!("pharaoh-audiosr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp)?;

    let result = tokio::process::Command::new(&cli)
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
        .output()
        .await
        .map_err(|e| Error::Other(format!("failed to run AudioSR: {}", e)))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(Error::Other(format!(
            "AudioSR failed:\n{}",
            &stderr[..stderr.len().min(4000)]
        )));
    }

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
