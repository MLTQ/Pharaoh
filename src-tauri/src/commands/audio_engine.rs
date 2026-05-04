use std::path::Path;
use tauri::AppHandle;
use crate::app_support::{app_projects_dir, read_script_rows, scene_dir};
use crate::error::{Error, Result};
use crate::models::ScriptRow;

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

/// Normalize a single WAV file to `target_lufs` integrated loudness using ffmpeg loudnorm.
/// Writes to `{stem}.norm.wav` next to the original and returns the new path.
#[tauri::command]
pub fn normalize_clip(path: String, target_lufs: f32) -> Result<String> {
    let stem = path.trim_end_matches(".wav");
    let output = format!("{}.norm.wav", stem);
    run_ffmpeg(&[
        "-y", "-i", &path,
        "-af", &format!("loudnorm=I={}:TP=-1.5:LRA=11", target_lufs),
        "-ar", "48000", "-ac", "2",
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
