//! Scene layout — give a generated scene's rows their places on the timeline.
//!
//! The renderer only mixes rows with a `start_ms`, and nothing assigned one
//! outside hand-placement in the Composition view, so a scene scripted and
//! generated from the CLI or the agent couldn't render. `layout_scene` reads
//! script order and each file's length and lays the scene out like a radio
//! play: lines one after another with a short gap, effects where they're cued
//! (the next line comes in before a long effect finishes), beds from their cue
//! to the end of the scene, looped, music from its cue for its own length,
//! with fades on both.
//!
//! Rows already placed keep their place unless `replace` is set.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_support::{app_projects_dir, read_script_rows, scene_dir, wav_info, write_script_rows};
use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutOptions {
    /// Silence before the first line.
    pub lead_in_ms: u64,
    /// Pause between lines.
    pub gap_ms: u64,
    /// How long an effect holds the floor before the next line starts.
    pub sfx_hold_ms: u64,
    /// Room after the last line.
    pub tail_ms: u64,
    /// Re-place rows that already have a start.
    pub replace: bool,
}

impl Default for LayoutOptions {
    fn default() -> Self {
        LayoutOptions { lead_in_ms: 1500, gap_ms: 350, sfx_hold_ms: 1200, tail_ms: 2500, replace: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutReport {
    pub placed: usize,
    pub kept: usize,
    /// Rows with no audio yet (generate them first).
    pub missing_audio: usize,
    pub scene_ms: u64,
}

fn file_ms(path: &str) -> Option<u64> {
    wav_info(path).ok().and_then(|i| i.duration_ms())
}

pub fn layout_scene(projects_dir: &Path, project_id: &str, scene_slug: &str, opts: &LayoutOptions) -> Result<LayoutReport> {
    let path = scene_dir(projects_dir, project_id, scene_slug).join("script.csv");
    let mut rows = read_script_rows(&path)?;
    let mut report = LayoutReport { placed: 0, kept: 0, missing_audio: 0, scene_ms: 0 };
    let mut cursor = opts.lead_in_ms;
    let mut spans: Vec<usize> = Vec::new(); // beds / music, sized once the scene length is known
    let mut started = false; // has any line or effect been placed yet?

    for (i, row) in rows.iter_mut().enumerate() {
        let kind = row.track_type.to_uppercase();
        if kind == "DIRECTION" {
            continue;
        }
        if row.file.trim().is_empty() {
            report.missing_audio += 1;
            continue;
        }
        let keep = !opts.replace && !row.start_ms.trim().is_empty();
        let len = file_ms(&row.file).or_else(|| row.duration_ms.parse().ok()).unwrap_or(0);
        match kind.as_str() {
            "BED" | "MUSIC" => {
                if keep {
                    report.kept += 1;
                } else {
                    // A cue before the first line starts the scene; later ones where they fall.
                    row.start_ms = if started { cursor } else { 0 }.to_string();
                    spans.push(i);
                }
            }
            _ => {
                if keep {
                    report.kept += 1;
                    let s: u64 = row.start_ms.parse().unwrap_or(cursor);
                    cursor = cursor.max(s + len + opts.gap_ms);
                } else {
                    row.start_ms = cursor.to_string();
                    row.duration_ms = len.to_string();
                    report.placed += 1;
                    cursor += if kind == "SFX" { len.min(opts.sfx_hold_ms) } else { len } + opts.gap_ms;
                }
                started = true;
            }
        }
    }

    let end = cursor + opts.tail_ms;
    for i in spans {
        let row = &mut rows[i];
        let start: u64 = row.start_ms.parse().unwrap_or(0);
        let room = end.saturating_sub(start);
        let len = file_ms(&row.file).unwrap_or(room);
        if row.track_type.eq_ignore_ascii_case("BED") {
            // Ambience covers the scene, repeating a short generated bed.
            row.duration_ms = room.to_string();
            row.r#loop = (len < room).to_string();
            row.fade_in_ms = "1500".into();
            row.fade_out_ms = "2500".into();
        } else {
            // Music plays once from its cue, eased in and out.
            let d = len.min(room);
            row.duration_ms = d.to_string();
            row.r#loop = "false".into();
            row.fade_in_ms = "1000".into();
            row.fade_out_ms = (d / 3).min(3000).to_string();
        }
        report.placed += 1;
    }
    report.scene_ms = end;
    if report.placed + report.kept == 0 {
        return Err(Error::Other(format!(
            "nothing to lay out in {} — generate the scene's audio first ({} rows have no file)",
            scene_slug, report.missing_audio
        )));
    }
    write_script_rows(&path, &rows)?;
    Ok(report)
}

/// Lay out a scene's generated rows on the timeline (script order).
#[tauri::command]
pub fn layout_scene_rows(app: AppHandle, project_id: String, scene_slug: String, replace: Option<bool>) -> Result<LayoutReport> {
    let opts = LayoutOptions { replace: replace.unwrap_or(false), ..Default::default() };
    layout_scene(&app_projects_dir(&app)?, &project_id, &scene_slug, &opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ScriptRow;

    fn wav(path: &Path, ms: u32) {
        let spec = hound::WavSpec { channels: 1, sample_rate: 8000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..(8 * ms) {
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();
    }

    fn row(kind: &str, file: &Path) -> ScriptRow {
        let mut r: ScriptRow = serde_json::from_value(serde_json::json!({
            "scene": "S01", "track": "t", "type": kind, "character": "", "prompt": "", "file": file.to_string_lossy(),
            "start_ms": "", "duration_ms": "", "loop": "false", "pan": "0", "gain_db": "0", "instruct": "",
            "fade_in_ms": "0", "fade_out_ms": "0", "reverb_send": "0", "emotion": "", "notes": ""
        }))
        .unwrap();
        r.track_type = kind.into();
        r
    }

    #[test]
    fn lays_out_lines_effects_beds_and_music() {
        let root = std::env::temp_dir().join(format!("pharaoh-layout-{}", uuid::Uuid::new_v4()));
        let scene = scene_dir(&root, "p", "s");
        std::fs::create_dir_all(&scene).unwrap();
        let f = |n: &str, ms: u32| {
            let p = scene.join(n);
            wav(&p, ms);
            p
        };
        let rows = vec![
            row("BED", &f("bed.wav", 3000)),
            row("MUSIC", &f("music.wav", 20000)),
            row("DIALOGUE", &f("a.wav", 2000)),
            row("SFX", &f("bell.wav", 3000)),
            row("DIALOGUE", &f("b.wav", 1000)),
        ];
        write_script_rows(&scene.join("script.csv"), &rows).unwrap();
        let r = layout_scene(&root, "p", "s", &LayoutOptions::default()).unwrap();
        assert_eq!(r.placed, 5);
        let out = read_script_rows(&scene.join("script.csv")).unwrap();
        let st = |i: usize| out[i].start_ms.parse::<u64>().unwrap();
        assert_eq!((st(0), st(1)), (0, 0), "cues before the first line start the scene");
        assert_eq!(st(2), 1500);
        assert_eq!(st(3), 1500 + 2000 + 350);
        assert_eq!(st(4), st(3) + 1200 + 350, "the next line comes in before a long effect ends");
        let end = st(4) + 1000 + 350 + 2500;
        assert_eq!(r.scene_ms, end);
        assert_eq!(out[0].duration_ms, end.to_string());
        assert_eq!(out[0].r#loop, "true", "a short bed loops to cover the scene");
        assert_eq!(out[1].duration_ms, end.min(20000).to_string());
        std::fs::remove_dir_all(&root).ok();
    }
}
