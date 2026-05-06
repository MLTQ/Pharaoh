use crate::app_support::{app_projects_dir, read_script_rows, scene_dir};
use crate::commands::sidecar::{read_sidecar, write_sidecar};
use crate::error::{Error, Result};
use crate::models::{ScriptRow, SidecarMeta};
use chrono::Utc;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

fn db_to_linear(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn run_ffmpeg(args: &[&str]) -> Result<()> {
    let out = std::process::Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|e| Error::Other(format!("ffmpeg not found (install ffmpeg): {}", e)))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Other(format!(
            "ffmpeg failed:\n{}",
            &stderr[..stderr.len().min(1000)]
        )));
    }
    Ok(())
}

fn run_ffmpeg_owned(args: &[String]) -> Result<()> {
    let out = std::process::Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|e| Error::Other(format!("ffmpeg not found (install ffmpeg): {}", e)))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Other(format!(
            "ffmpeg failed:\n{}",
            &stderr[..stderr.len().min(1000)]
        )));
    }
    Ok(())
}

fn wav_info(path: &str) -> Result<(Option<u64>, u32)> {
    let reader = hound::WavReader::open(path)
        .map_err(|e| Error::Other(format!("could not read processed WAV metadata: {}", e)))?;
    let spec = reader.spec();
    let samples = reader.duration() as u64;
    let channels = u64::from(spec.channels.max(1));
    let duration_ms = samples
        .checked_mul(1000)
        .and_then(|v| v.checked_div(channels))
        .and_then(|v| v.checked_div(u64::from(spec.sample_rate)));
    Ok((duration_ms, spec.sample_rate))
}

fn clip_output_path(input_path: &str) -> Result<String> {
    let input = PathBuf::from(input_path);
    let parent = input
        .parent()
        .ok_or_else(|| Error::Other("clip input has no parent directory".into()))?;
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| Error::Other("clip input has no valid filename stem".into()))?;
    let stamped = format!("{}.clip.{}.wav", stem, Utc::now().format("%Y%m%d%H%M%S"));
    Ok(parent.join(stamped).to_string_lossy().to_string())
}

fn sanitize_stem(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    sanitized
        .trim_matches('_')
        .chars()
        .take(80)
        .collect::<String>()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipProcessRequest {
    pub input_path: String,
    pub start_ms: u64,
    pub end_ms: Option<u64>,
    pub gain_db: f32,
    pub fade_in_ms: u64,
    pub fade_out_ms: u64,
    pub normalize_lufs: Option<f32>,
    pub highpass_hz: Option<u32>,
    pub lowpass_hz: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAudioRequest {
    pub project_id: String,
    pub source_path: String,
    pub label: Option<String>,
}

/// Import arbitrary source audio into the project as a sidecar-indexed WAV.
#[tauri::command]
pub fn import_audio_asset(app: AppHandle, params: ImportAudioRequest) -> Result<String> {
    let source = PathBuf::from(&params.source_path);
    if !source.exists() {
        return Err(Error::Other(format!(
            "source audio not found: {}",
            params.source_path
        )));
    }

    let projects_dir = app_projects_dir(&app)?;
    let imports_dir = projects_dir
        .join(&params.project_id)
        .join("scenes")
        .join("__imports")
        .join("assets");
    std::fs::create_dir_all(&imports_dir)?;

    let label = params
        .label
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| source.file_stem().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| "imported_audio".into());
    let stem = sanitize_stem(&label);
    let output = imports_dir
        .join(format!(
            "{}.import.{}.wav",
            if stem.is_empty() { "audio" } else { &stem },
            Utc::now().format("%Y%m%d%H%M%S")
        ))
        .to_string_lossy()
        .to_string();

    run_ffmpeg_owned(&[
        "-y".into(),
        "-i".into(),
        params.source_path.clone(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "1".into(),
        output.clone(),
    ])?;

    let (duration_actual_ms, sample_rate) = wav_info(&output).unwrap_or((None, 48000));
    let meta = SidecarMeta {
        model: "tts-reference-import".into(),
        model_variant: Some("ffmpeg-import".into()),
        prompt: format!("Imported reference recording: {}", label),
        instruct: Some(format!("source={}", params.source_path)),
        speaker: None,
        language: None,
        seed: 0,
        temperature: None,
        top_p: None,
        duration_target_ms: duration_actual_ms,
        duration_actual_ms,
        sample_rate,
        generated_at: Utc::now(),
        parent: Some(params.source_path),
        take_index: 0,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };
    write_sidecar(output.clone(), meta)?;
    Ok(output)
}

/// Process a generated asset into a child WAV using ffmpeg, then write a child sidecar.
#[tauri::command]
pub fn process_clip_asset(params: ClipProcessRequest) -> Result<String> {
    if !Path::new(&params.input_path).exists() {
        return Err(Error::Other(format!(
            "clip input not found: {}",
            params.input_path
        )));
    }
    if let Some(end_ms) = params.end_ms {
        if end_ms <= params.start_ms {
            return Err(Error::Other("clip end must be after clip start".into()));
        }
    }

    let output = clip_output_path(&params.input_path)?;
    let mut args = vec!["-y".to_string()];
    if params.start_ms > 0 {
        args.push("-ss".into());
        args.push(format!("{:.3}", params.start_ms as f32 / 1000.0));
    }
    if let Some(end_ms) = params.end_ms {
        args.push("-t".into());
        args.push(format!("{:.3}", (end_ms - params.start_ms) as f32 / 1000.0));
    }
    args.push("-i".into());
    args.push(params.input_path.clone());

    let output_duration_ms = params.end_ms.map(|end_ms| end_ms - params.start_ms);
    let mut filters = Vec::new();
    if let Some(hz) = params.highpass_hz.filter(|hz| *hz > 0) {
        filters.push(format!("highpass=f={}", hz));
    }
    if let Some(hz) = params.lowpass_hz.filter(|hz| *hz > 0) {
        filters.push(format!("lowpass=f={}", hz));
    }
    if params.gain_db.abs() > f32::EPSILON {
        filters.push(format!("volume={:.2}dB", params.gain_db));
    }
    if params.fade_in_ms > 0 {
        filters.push(format!(
            "afade=t=in:st=0:d={:.3}",
            params.fade_in_ms as f32 / 1000.0
        ));
    }
    if let (Some(duration_ms), fade_out_ms) = (output_duration_ms, params.fade_out_ms) {
        if fade_out_ms > 0 && duration_ms > fade_out_ms {
            filters.push(format!(
                "afade=t=out:st={:.3}:d={:.3}",
                (duration_ms - fade_out_ms) as f32 / 1000.0,
                fade_out_ms as f32 / 1000.0
            ));
        }
    }
    if let Some(lufs) = params.normalize_lufs {
        filters.push(format!("loudnorm=I={:.1}:TP=-1.5:LRA=11", lufs));
    }
    if !filters.is_empty() {
        args.push("-af".into());
        args.push(filters.join(","));
    }
    args.extend([
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        output.clone(),
    ]);

    run_ffmpeg_owned(&args)?;

    let (duration_actual_ms, sample_rate) =
        wav_info(&output).unwrap_or((output_duration_ms, 48000));
    let parent_meta = read_sidecar(params.input_path.clone()).ok().flatten();
    let prompt = parent_meta
        .as_ref()
        .map(|m| m.prompt.clone())
        .unwrap_or_else(|| "Manual clip edit".into());
    let meta = SidecarMeta {
        model: "clip-studio".into(),
        model_variant: Some("ffmpeg".into()),
        prompt,
        instruct: Some(format!(
            "trim={}..{} ms; gain={:.2} dB; fade_in={} ms; fade_out={} ms; highpass={:?}; lowpass={:?}; normalize={:?}",
            params.start_ms,
            params.end_ms.map(|v| v.to_string()).unwrap_or_else(|| "end".into()),
            params.gain_db,
            params.fade_in_ms,
            params.fade_out_ms,
            params.highpass_hz,
            params.lowpass_hz,
            params.normalize_lufs
        )),
        speaker: parent_meta.as_ref().and_then(|m| m.speaker.clone()),
        language: parent_meta.as_ref().and_then(|m| m.language.clone()),
        seed: parent_meta.as_ref().map(|m| m.seed).unwrap_or(0),
        temperature: None,
        top_p: None,
        duration_target_ms: output_duration_ms,
        duration_actual_ms,
        sample_rate,
        generated_at: Utc::now(),
        parent: Some(params.input_path),
        take_index: parent_meta.as_ref().map(|m| m.take_index + 1).unwrap_or(0),
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };
    write_sidecar(output.clone(), meta)?;
    Ok(output)
}

/// Normalize a single WAV file to `target_lufs` integrated loudness using ffmpeg loudnorm.
/// Writes to `{stem}.norm.wav` next to the original and returns the new path.
#[tauri::command]
pub fn normalize_clip(path: String, target_lufs: f32) -> Result<String> {
    let stem = path.trim_end_matches(".wav");
    let output = format!("{}.norm.wav", stem);
    run_ffmpeg(&[
        "-y",
        "-i",
        &path,
        "-af",
        &format!("loudnorm=I={}:TP=-1.5:LRA=11", target_lufs),
        "-ar",
        "48000",
        "-ac",
        "2",
        &output,
    ])?;
    Ok(output)
}

/// Resample a WAV file to 48 kHz stereo, writing to `output_path`.
#[tauri::command]
pub fn resample_to_48k(path: String, output_path: String) -> Result<()> {
    run_ffmpeg(&["-y", "-i", &path, "-ar", "48000", "-ac", "2", &output_path])
}

/// Build a scene render from script.csv using ffmpeg filter_complex.
///
/// Only rows with a non-empty `file` and `start_ms` are placed. Each placed clip is
/// delayed by its `start_ms`, has its gain_db applied, and optionally faded.
/// All tracks are summed with `amix` and written to
/// `{projects_dir}/{project_id}/scenes/{scene_slug}/render.wav` at 48 kHz stereo.
#[tauri::command]
pub async fn render_scene(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    render_scene_with_projects_dir(&projects_dir, &project_id, &scene_slug).await
}

pub async fn render_scene_with_projects_dir(
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
) -> Result<String> {
    let scene_root = scene_dir(projects_dir, project_id, scene_slug);
    let output_path = scene_root.join("render.wav");

    let rows: Vec<ScriptRow> = read_script_rows(&scene_root.join("script.csv"))
        .map_err(|e| Error::Other(format!("cannot read script.csv: {}", e)))?;

    // Only rows that are fully placed (file + start_ms) and not direction cues
    let placed: Vec<&ScriptRow> = rows
        .iter()
        .filter(|r| {
            !r.file.is_empty()
                && !r.start_ms.is_empty()
                && r.track_type.to_uppercase() != "DIRECTION"
        })
        .collect();

    if placed.is_empty() {
        return Err(Error::Other(
            "no placed rows in script.csv — assign file + start_ms to rows first".to_string(),
        ));
    }

    // ── Build ffmpeg command ──────────────────────────────────────────────
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.arg("-y");

    for row in &placed {
        cmd.args(["-i", &row.file]);
    }

    // Per-track filter chains
    let mut filter_parts: Vec<String> = Vec::new();
    let mut mix_inputs = String::new();

    for (i, row) in placed.iter().enumerate() {
        let start_ms: u64 = row.start_ms.parse().unwrap_or(0);
        let gain_db: f32 = row.gain_db.parse().unwrap_or(0.0);
        let vol = db_to_linear(gain_db);

        let mut filters: Vec<String> = Vec::new();

        // Fade in
        if let Ok(fi_ms) = row.fade_in_ms.parse::<u64>() {
            if fi_ms > 0 {
                filters.push(format!("afade=t=in:st=0:d={:.3}", fi_ms as f32 / 1000.0));
            }
        }

        // Fade out (requires duration_ms to compute start of fade)
        if let (Ok(fo_ms), Ok(dur_ms)) = (
            row.fade_out_ms.parse::<u64>(),
            row.duration_ms.parse::<u64>(),
        ) {
            if fo_ms > 0 && dur_ms > fo_ms {
                let fo_start_s = (dur_ms - fo_ms) as f32 / 1000.0;
                filters.push(format!(
                    "afade=t=out:st={:.3}:d={:.3}",
                    fo_start_s,
                    fo_ms as f32 / 1000.0
                ));
            }
        }

        // Delay clip to its timeline position
        filters.push(format!("adelay={}|{}", start_ms, start_ms));

        // Apply track gain
        filters.push(format!("volume={:.4}", vol));

        filter_parts.push(format!("[{}:a]{}[a{}]", i, filters.join(","), i));
        mix_inputs.push_str(&format!("[a{}]", i));
    }

    // Mix all tracks; normalize=0 preserves individual track levels
    filter_parts.push(format!(
        "{}amix=inputs={}:normalize=0:duration=longest[out]",
        mix_inputs,
        placed.len()
    ));

    cmd.args(["-filter_complex", &filter_parts.join(";")]);
    cmd.args(["-map", "[out]", "-ar", "48000", "-ac", "2"]);
    cmd.arg(output_path.to_string_lossy().as_ref());

    let result = cmd
        .output()
        .await
        .map_err(|e| Error::Other(format!("ffmpeg not found (install ffmpeg): {}", e)))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(Error::Other(format!(
            "ffmpeg render failed:\n{}",
            &stderr[..stderr.len().min(2000)]
        )));
    }

    Ok(output_path.to_string_lossy().to_string())
}
