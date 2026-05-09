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

fn fade_curve(raw: Option<&str>) -> &'static str {
    match raw.unwrap_or("tri") {
        "tri" => "tri",
        "qsin" => "qsin",
        "hsin" => "hsin",
        "esin" => "esin",
        "log" => "log",
        "qua" => "qua",
        "cub" => "cub",
        "squ" => "squ",
        "cbr" => "cbr",
        _ => "tri",
    }
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
    pub fade_in_curve: Option<String>,
    pub fade_out_curve: Option<String>,
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
    let projects_dir = app_projects_dir(&app)?;
    import_audio_asset_with_projects_dir(&projects_dir, params)
}

pub fn import_audio_asset_with_projects_dir(
    projects_dir: &Path,
    params: ImportAudioRequest,
) -> Result<String> {
    let source = PathBuf::from(&params.source_path);
    if !source.exists() {
        return Err(Error::Other(format!(
            "source audio not found: {}",
            params.source_path
        )));
    }

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
            "afade=t=in:st=0:d={:.3}:curve={}",
            params.fade_in_ms as f32 / 1000.0,
            fade_curve(params.fade_in_curve.as_deref())
        ));
    }
    if let (Some(duration_ms), fade_out_ms) = (output_duration_ms, params.fade_out_ms) {
        if fade_out_ms > 0 && duration_ms > fade_out_ms {
            filters.push(format!(
                "afade=t=out:st={:.3}:d={:.3}:curve={}",
                (duration_ms - fade_out_ms) as f32 / 1000.0,
                fade_out_ms as f32 / 1000.0,
                fade_curve(params.fade_out_curve.as_deref())
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
/// The render has three stages:
///   1. **Per-clip processing** — fades, time-delay, gain, equal-power pan.
///   2. **Bus structure** — dialogue / music+bed / sfx are submixed separately
///      with sane defaults: HPF at 80Hz on the dialogue bus, music+bed trimmed
///      -3 dB, sfx trimmed -1 dB. When DIALOGUE coexists with BED/MUSIC the
///      music+bed bus is sidechain-ducked against the dialogue sum.
///   3. **Master chain** — loudnorm to the configured target LUFS (default
///      -16) followed by an alimiter at -1 dBTP.
///
/// After the file is written we run ffmpeg's ebur128 filter to measure
/// integrated LUFS / true peak / loudness range and write that alongside the
/// audio at `render.meta.json` for the UI to surface.
#[tauri::command]
pub async fn render_scene(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    target_lufs: Option<f32>,
) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    render_scene_with_projects_dir(&projects_dir, &project_id, &scene_slug, target_lufs).await
}

pub async fn render_scene_with_projects_dir(
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    target_lufs: Option<f32>,
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

    // ── Per-clip processing ───────────────────────────────────────────────
    let mut filter_parts: Vec<String> = Vec::new();

    // Categorize so we can submix dialogue / music+bed / sfx into separate buses
    // and apply auto-ducking when DIALOGUE coexists with BED/MUSIC.
    let mut dialogue_idxs: Vec<usize> = Vec::new();
    let mut duck_target_idxs: Vec<usize> = Vec::new();
    let mut passthrough_idxs: Vec<usize> = Vec::new();

    for (i, row) in placed.iter().enumerate() {
        let start_ms: u64 = row.start_ms.parse().unwrap_or(0);
        let gain_db: f32 = row.gain_db.parse().unwrap_or(0.0);
        let vol = db_to_linear(gain_db);
        let pan: f32 = row.pan.parse::<f32>().unwrap_or(0.0).clamp(-1.0, 1.0);

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

        // Stereoize so the pan filter has two channels regardless of source
        filters.push("aformat=channel_layouts=stereo".to_string());

        // Equal-power pan. pan ∈ [-1, 1]: -1 = full left, 0 = center, +1 = full right.
        // L = cos((pan+1)·π/4), R = sin((pan+1)·π/4)
        if pan.abs() > 1e-3 {
            let theta = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
            let lg = theta.cos();
            let rg = theta.sin();
            // For mono-upmixed-to-stereo input, c0 == c1. For real stereo input
            // this slightly downmixes — acceptable since true-stereo SFX/music
            // are normally panned 0 anyway.
            filters.push(format!(
                "pan=stereo|c0={:.4}*c0|c1={:.4}*c1",
                lg, rg
            ));
        }

        filter_parts.push(format!("[{}:a]{}[a{}]", i, filters.join(","), i));

        let kind = row.track_type.to_uppercase();
        if kind == "DIALOGUE" {
            dialogue_idxs.push(i);
        } else if kind == "BED" || kind == "MUSIC" {
            duck_target_idxs.push(i);
        } else {
            passthrough_idxs.push(i);
        }
    }

    // ── Bus structure & ducking ───────────────────────────────────────────

    // Helper: name we use to reference the dialogue-bus pre-mix in the final stage
    let mut dialogue_bus_label: Option<String> = None;
    // Music+bed bus may be ducked or straight depending on whether dialogue exists
    let mut music_bed_bus_label: Option<String> = None;
    let mut sfx_bus_label: Option<String> = None;

    let do_ducking = !dialogue_idxs.is_empty() && !duck_target_idxs.is_empty();

    // Dialogue bus: sum all dialogue tracks → high-pass → trim → [dialogue_bus_premix]
    // The HPF at 80Hz kills TTS rumble; the small upward trim isn't applied here
    // because dialogue is the loudness reference for the rest of the mix.
    if !dialogue_idxs.is_empty() {
        let voice_in: String = dialogue_idxs.iter().map(|i| format!("[a{}]", i)).collect();
        let voice_chain = if dialogue_idxs.len() == 1 {
            format!("{}aformat=channel_layouts=stereo[voice_bus]", voice_in)
        } else {
            format!(
                "{}amix=inputs={}:normalize=0:duration=longest,aformat=channel_layouts=stereo[voice_bus]",
                voice_in,
                dialogue_idxs.len()
            )
        };
        filter_parts.push(voice_chain);
        // Apply HPF and a touch of headroom-friendly trim. Then split N+1 ways
        // when ducking is needed: N copies for sidechain inputs, 1 for the mix.
        let split_n = if do_ducking { duck_target_idxs.len() + 1 } else { 1 };
        let outs: String = (0..split_n).map(|j| format!("[vb{}]", j)).collect();
        filter_parts.push(format!(
            "[voice_bus]highpass=f=80:p=2,asplit={}{}",
            split_n, outs
        ));
        // The "main" copy used in the final mix is the last split.
        dialogue_bus_label = Some(format!("[vb{}]", split_n - 1));
    }

    // Music+bed bus: optionally sidechained against dialogue, then -3 dB trim
    if !duck_target_idxs.is_empty() {
        let post_duck_labels: Vec<String> = if do_ducking {
            for (j, &idx) in duck_target_idxs.iter().enumerate() {
                filter_parts.push(format!(
                    "[a{}][vb{}]sidechaincompress=threshold=0.05:ratio=8:attack=80:release=300:makeup=1[d{}]",
                    idx, j, idx
                ));
            }
            duck_target_idxs.iter().map(|i| format!("[d{}]", i)).collect()
        } else {
            duck_target_idxs.iter().map(|i| format!("[a{}]", i)).collect()
        };
        let mix_in: String = post_duck_labels.join("");
        let chain = if post_duck_labels.len() == 1 {
            format!("{}volume=-3.0dB[music_bed_bus]", mix_in)
        } else {
            format!(
                "{}amix=inputs={}:normalize=0:duration=longest,volume=-3.0dB[music_bed_bus]",
                mix_in,
                post_duck_labels.len()
            )
        };
        filter_parts.push(chain);
        music_bed_bus_label = Some("[music_bed_bus]".to_string());
    }

    // SFX bus: sum and -1 dB trim
    if !passthrough_idxs.is_empty() {
        let sfx_in: String = passthrough_idxs.iter().map(|i| format!("[a{}]", i)).collect();
        let chain = if passthrough_idxs.len() == 1 {
            format!("{}volume=-1.0dB[sfx_bus]", sfx_in)
        } else {
            format!(
                "{}amix=inputs={}:normalize=0:duration=longest,volume=-1.0dB[sfx_bus]",
                sfx_in,
                passthrough_idxs.len()
            )
        };
        filter_parts.push(chain);
        sfx_bus_label = Some("[sfx_bus]".to_string());
    }

    // ── Final premaster mix ───────────────────────────────────────────────
    let mut final_inputs: Vec<String> = Vec::new();
    if let Some(l) = &dialogue_bus_label   { final_inputs.push(l.clone()); }
    if let Some(l) = &music_bed_bus_label  { final_inputs.push(l.clone()); }
    if let Some(l) = &sfx_bus_label        { final_inputs.push(l.clone()); }

    // Defensive: if for some reason no buses materialized, fall back to a flat amix
    if final_inputs.is_empty() {
        for i in 0..placed.len() { final_inputs.push(format!("[a{}]", i)); }
    }

    let mix_count = final_inputs.len();
    let mix_out_label = "[premaster]";
    if mix_count == 1 {
        // amix with a single input is illegal in ffmpeg — just rename
        filter_parts.push(format!("{}anull{}", final_inputs[0], mix_out_label));
    } else {
        filter_parts.push(format!(
            "{}amix=inputs={}:normalize=0:duration=longest{}",
            final_inputs.join(""),
            mix_count,
            mix_out_label
        ));
    }

    // ── Master chain: loudnorm + alimiter ────────────────────────────────
    // Single-pass loudnorm (faster, slightly less precise than two-pass).
    // alimiter brick-walls to -1 dBTP so we never clip downstream encoders.
    let target_i = target_lufs.unwrap_or(-16.0).clamp(-30.0, -8.0);
    filter_parts.push(format!(
        "{}loudnorm=I={:.1}:TP=-1.0:LRA=11,alimiter=limit=0.891[master]",
        mix_out_label, target_i
    ));

    cmd.args(["-filter_complex", &filter_parts.join(";")]);
    cmd.args(["-map", "[master]", "-ar", "48000", "-ac", "2"]);
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

    // ── Post-render measurement ────────────────────────────────────────────
    // Run ebur128 over the rendered file and write the measured loudness /
    // true-peak / range to render.meta.json. Best-effort — if measurement
    // fails we still return success since the render itself was fine.
    let meta_path = output_path.with_file_name(
        format!("{}.meta.json", output_path.file_name().and_then(|n| n.to_str()).unwrap_or("render.wav")),
    );
    if let Ok(meas) = measure_render_loudness(&output_path).await {
        let meta = serde_json::json!({
            "render_path": output_path.to_string_lossy(),
            "target_lufs": target_i,
            "integrated_lufs": meas.integrated_lufs,
            "true_peak_dbtp": meas.true_peak_dbtp,
            "loudness_range_lu": meas.loudness_range_lu,
            "threshold_lufs": meas.threshold_lufs,
            "duration_seconds": meas.duration_seconds,
            "measured_at": chrono::Utc::now().to_rfc3339(),
        });
        let _ = std::fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default());
    }

    Ok(output_path.to_string_lossy().to_string())
}

/// Concatenate scene renders into a single episode WAV with crossfades.
///
/// Reads `storyboard.json` to get scene order. Any scene without a
/// `render.wav` is rendered first via `render_scene_with_projects_dir`. The
/// final concat applies a single episode-level master chain (loudnorm +
/// alimiter) so loudness is consistent across scene boundaries — per-scene
/// renders may have drifted by 0.5–1 LU due to short-content loudnorm
/// imprecision. ebur128 is run on the result and a meta JSON written.
///
/// `crossfade_ms` is the duration applied between every adjacent pair.
/// Crossfades use ffmpeg's `acrossfade` filter (equal-power triangle by
/// default). 0 = hard cut.
#[tauri::command]
pub async fn render_episode(
    app: AppHandle,
    project_id: String,
    crossfade_ms: u64,
    target_lufs: Option<f32>,
    scene_slugs: Option<Vec<String>>,
) -> Result<String> {
    let projects_dir = app_projects_dir(&app)?;
    render_episode_with_projects_dir(&projects_dir, &project_id, crossfade_ms, target_lufs, scene_slugs).await
}

pub async fn render_episode_with_projects_dir(
    projects_dir: &Path,
    project_id: &str,
    crossfade_ms: u64,
    target_lufs: Option<f32>,
    scene_slugs_override: Option<Vec<String>>,
) -> Result<String> {
    let project_root = crate::app_support::project_dir(projects_dir, project_id);
    let storyboard_path = project_root.join("storyboard.json");
    let storyboard: serde_json::Value = if storyboard_path.exists() {
        let bytes = std::fs::read(&storyboard_path)
            .map_err(|e| Error::Other(format!("read storyboard.json: {}", e)))?;
        serde_json::from_slice(&bytes)
            .map_err(|e| Error::Other(format!("parse storyboard.json: {}", e)))?
    } else {
        return Err(Error::Other("project has no storyboard.json".into()));
    };

    // Determine scene order. The override is for callers that want to
    // re-arrange episode order without mutating the storyboard.
    let scene_slugs: Vec<String> = if let Some(slugs) = scene_slugs_override {
        slugs
    } else {
        storyboard.get("scenes")
            .and_then(|s| s.as_array())
            .map(|arr| arr.iter()
                .filter_map(|s| s.get("slug").and_then(|v| v.as_str()).map(|v| v.to_string()))
                .collect::<Vec<_>>())
            .unwrap_or_default()
    };
    if scene_slugs.is_empty() {
        return Err(Error::Other("no scenes in storyboard".into()));
    }

    // Make sure each scene has a render.wav — render any missing on the fly.
    let mut scene_render_paths: Vec<PathBuf> = Vec::with_capacity(scene_slugs.len());
    for slug in &scene_slugs {
        let scene_root = crate::app_support::scene_dir(projects_dir, project_id, slug);
        let render_wav = scene_root.join("render.wav");
        if !render_wav.exists() {
            // Lazy render with the scene's own target (defaults to -16). The
            // episode-level loudnorm pass below will normalize across scenes.
            render_scene_with_projects_dir(projects_dir, project_id, slug, target_lufs).await?;
        }
        if !render_wav.exists() {
            return Err(Error::Other(format!(
                "scene {} render did not produce render.wav", slug
            )));
        }
        scene_render_paths.push(render_wav);
    }

    let output_dir = project_root.join("output");
    std::fs::create_dir_all(&output_dir)?;
    let output_path = output_dir.join("final.wav");

    // ── Build ffmpeg filter graph ─────────────────────────────────────────
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.arg("-y");
    for p in &scene_render_paths {
        cmd.args(["-i", &p.to_string_lossy()]);
    }

    let mut filter_parts: Vec<String> = Vec::new();
    let crossfade_s = (crossfade_ms as f32 / 1000.0).max(0.0);

    let concat_label = if scene_render_paths.len() == 1 {
        // Single scene — just rename, no crossfade math
        filter_parts.push(format!("[0:a]aformat=channel_layouts=stereo[concat]"));
        "[concat]".to_string()
    } else if crossfade_s <= 0.001 {
        // Hard cut — use straight concat filter
        let inputs: String = (0..scene_render_paths.len())
            .map(|i| format!("[{}:a]aformat=channel_layouts=stereo[s{}]", i, i))
            .collect::<Vec<_>>()
            .join(";");
        filter_parts.push(inputs);
        let cat_inputs: String = (0..scene_render_paths.len())
            .map(|i| format!("[s{}]", i))
            .collect();
        filter_parts.push(format!(
            "{}concat=n={}:v=0:a=1[concat]",
            cat_inputs, scene_render_paths.len()
        ));
        "[concat]".to_string()
    } else {
        // acrossfade pairwise: [0]+[1] → [x1], [x1]+[2] → [x2], …
        for i in 0..scene_render_paths.len() {
            filter_parts.push(format!("[{}:a]aformat=channel_layouts=stereo[s{}]", i, i));
        }
        let mut prev_label = "[s0]".to_string();
        for i in 1..scene_render_paths.len() {
            let next_label = if i == scene_render_paths.len() - 1 {
                "[concat]".to_string()
            } else {
                format!("[x{}]", i)
            };
            filter_parts.push(format!(
                "{}{}acrossfade=d={:.3}:c1=tri:c2=tri{}",
                prev_label, format!("[s{}]", i), crossfade_s, next_label
            ));
            prev_label = next_label;
        }
        "[concat]".to_string()
    };

    // Episode-level master chain. Same parameters as per-scene render so the
    // overall result hits the same target with consistent ceilings.
    let target_i = target_lufs.unwrap_or(-16.0).clamp(-30.0, -8.0);
    filter_parts.push(format!(
        "{}loudnorm=I={:.1}:TP=-1.0:LRA=11,alimiter=limit=0.891[master]",
        concat_label, target_i
    ));

    cmd.args(["-filter_complex", &filter_parts.join(";")]);
    cmd.args(["-map", "[master]", "-ar", "48000", "-ac", "2"]);
    cmd.arg(output_path.to_string_lossy().as_ref());

    let result = cmd
        .output()
        .await
        .map_err(|e| Error::Other(format!("ffmpeg episode render failed: {}", e)))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(Error::Other(format!(
            "ffmpeg episode render failed:\n{}",
            &stderr[..stderr.len().min(2000)]
        )));
    }

    // Measure and write meta
    let meta_path = output_path.with_file_name("final.wav.meta.json");
    if let Ok(meas) = measure_render_loudness(&output_path).await {
        let meta = serde_json::json!({
            "render_path": output_path.to_string_lossy(),
            "target_lufs": target_i,
            "integrated_lufs": meas.integrated_lufs,
            "true_peak_dbtp": meas.true_peak_dbtp,
            "loudness_range_lu": meas.loudness_range_lu,
            "threshold_lufs": meas.threshold_lufs,
            "duration_seconds": meas.duration_seconds,
            "measured_at": chrono::Utc::now().to_rfc3339(),
            "scene_slugs": scene_slugs,
            "crossfade_ms": crossfade_ms,
        });
        let _ = std::fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap_or_default());
    }

    Ok(output_path.to_string_lossy().to_string())
}

/// Read the per-render measurement JSON written next to render.wav.
/// Returns `Ok(None)` if the file doesn't exist (un-rendered or pre-mastering scene).
#[tauri::command]
pub async fn read_render_meta(render_path: String) -> Result<Option<serde_json::Value>> {
    let path = PathBuf::from(&render_path);
    let meta_path = path.with_file_name(
        format!("{}.meta.json", path.file_name().and_then(|n| n.to_str()).unwrap_or("render.wav")),
    );
    if !meta_path.exists() { return Ok(None); }
    let bytes = std::fs::read(&meta_path)
        .map_err(|e| Error::Other(format!("read {} failed: {}", meta_path.display(), e)))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Other(format!("parse {} failed: {}", meta_path.display(), e)))?;
    Ok(Some(v))
}

/// Loudness measurements parsed from `ebur128` summary stderr.
#[derive(Debug, Clone)]
struct LoudnessMeasurement {
    integrated_lufs: f32,
    true_peak_dbtp: f32,
    loudness_range_lu: f32,
    threshold_lufs: f32,
    duration_seconds: f32,
}

async fn measure_render_loudness(path: &Path) -> Result<LoudnessMeasurement> {
    // ffmpeg -i <path> -af ebur128=peak=true -f null -  prints a "Summary:" block to stderr.
    let result = tokio::process::Command::new("ffmpeg")
        .arg("-nostats")
        .arg("-hide_banner")
        .args(["-i", &path.to_string_lossy()])
        .args(["-af", "ebur128=peak=true"])
        .args(["-f", "null", "-"])
        .output()
        .await
        .map_err(|e| Error::Other(format!("ffmpeg ebur128 failed to start: {}", e)))?;
    if !result.status.success() {
        return Err(Error::Other("ffmpeg ebur128 returned non-zero".into()));
    }
    let stderr = String::from_utf8_lossy(&result.stderr);
    parse_ebur128_summary(&stderr)
        .ok_or_else(|| Error::Other("could not find ebur128 Summary block in ffmpeg output".into()))
}

/// Parse the ebur128 "Summary:" block. Robust to small ffmpeg version
/// differences in label spacing — finds `I:`, `Range:`, `True peak:`,
/// `Threshold:`, and the input file `Duration:`.
fn parse_ebur128_summary(stderr: &str) -> Option<LoudnessMeasurement> {
    let summary_start = stderr.rfind("Summary:")?;
    let summary = &stderr[summary_start..];

    fn extract_lufs(block: &str, label: &str) -> Option<f32> {
        for line in block.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with(label) {
                // Lines look like:  "    I:         -16.2 LUFS"
                // Find the number — first sequence that parses as a float.
                let after = trimmed[label.len()..].trim();
                let mut acc = String::new();
                for c in after.chars() {
                    if c.is_ascii_digit() || c == '-' || c == '+' || c == '.' {
                        acc.push(c);
                    } else if !acc.is_empty() {
                        break;
                    }
                }
                if let Ok(v) = acc.parse::<f32>() { return Some(v); }
            }
        }
        None
    }

    // Integrated loudness ("I:") is reported in LUFS in the Summary block.
    let integrated = extract_lufs(summary, "I:")?;
    let lra = extract_lufs(summary, "LRA:").or_else(|| extract_lufs(summary, "Range:")).unwrap_or(0.0);
    let tp = extract_lufs(summary, "True peak:")
        .or_else(|| {
            // Some builds report the peak as "Peak:" inside the Summary's True-peak block.
            // We scan for any "Peak:" whose preceding line mentioned "True peak" or "Peak".
            extract_lufs(summary, "Peak:")
        })
        .unwrap_or(-99.0);
    let threshold = extract_lufs(summary, "Threshold:").unwrap_or(-70.0);

    // Best-effort duration: find "Duration:" earlier in the full stderr (not in Summary)
    // It looks like "Duration: 00:00:30.10". We don't strictly need it for v1.
    let duration_seconds = stderr
        .lines()
        .find(|l| l.trim_start().starts_with("Duration:"))
        .and_then(|l| {
            let after = l.split("Duration:").nth(1)?;
            let token = after.split(',').next()?.trim();
            let mut parts = token.split(':');
            let h: f32 = parts.next()?.parse().ok()?;
            let m: f32 = parts.next()?.parse().ok()?;
            let s: f32 = parts.next()?.parse().ok()?;
            Some(h * 3600.0 + m * 60.0 + s)
        })
        .unwrap_or(0.0);

    Some(LoudnessMeasurement {
        integrated_lufs: integrated,
        true_peak_dbtp: tp,
        loudness_range_lu: lra,
        threshold_lufs: threshold,
        duration_seconds,
    })
}
