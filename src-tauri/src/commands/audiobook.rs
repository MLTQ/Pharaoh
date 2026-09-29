//! Audiobook export — the rendered episode as a chaptered `.m4b`.
//!
//! `render_episode` writes `output/final.wav` plus `final.wav.meta.json`, which
//! records each scene's position in the episode (`chapters`). Export encodes
//! that WAV to AAC in an MP4 audiobook container with:
//!
//! - one chapter per scene, titled from the storyboard;
//! - title / album / author / genre / comment / description / year tags from
//!   the project, and the iTunes `stik = 2` atom so Apple Books files it as an
//!   audiobook rather than music;
//! - optional cover art, persisted as `<project>/cover.jpg|png` so every later
//!   export reuses it.
//!
//! Encoding goes to `<output>.part` and is renamed into place, so a failed or
//! cancelled export never leaves a truncated `.m4b` where a good one was.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_support::{app_projects_dir, project_dir, read_json, wav_info};
use crate::error::{Error, Result};
use crate::models::{Project, Storyboard};

const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EpisodeChapter {
    pub slug: String,
    pub title: String,
    pub start_s: f64,
    pub end_s: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct M4bOptions {
    /// New cover image to embed and remember for this project.
    #[serde(default)]
    pub cover_path: Option<String>,
    /// Author / artist tag. Players show this as the book's author.
    #[serde(default)]
    pub author: Option<String>,
    /// Narrator(s) / cast, written to the composer tag (Apple's "narrator" slot).
    #[serde(default)]
    pub narrator: Option<String>,
    /// AAC bitrate in kbps (default 128; clamped to 32–320).
    #[serde(default)]
    pub bitrate_kbps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct M4bExport {
    pub output_path: String,
    pub bytes: u64,
    pub duration_s: f64,
    pub chapters: Vec<EpisodeChapter>,
    /// The cover that was embedded, if any.
    pub cover_path: Option<String>,
}

// ── Chapter math ──────────────────────────────────────────────────────────

/// Where each scene lands in an episode built by `render_episode`.
///
/// With a crossfade of `xf` seconds, scene `i` starts fading in at
/// `sum(durations[..i]) - i * xf` — that is where its chapter begins, so
/// skipping to a chapter lands at the start of the transition into it.
pub fn chapters_for_render(
    scenes: &[(String, String, f64)], // (slug, title, duration_s)
    crossfade_s: f64,
) -> Vec<EpisodeChapter> {
    let xf = if scenes.len() > 1 { crossfade_s.max(0.0) } else { 0.0 };
    let total: f64 = scenes.iter().map(|s| s.2).sum::<f64>() - xf * (scenes.len().saturating_sub(1)) as f64;
    let mut out = Vec::with_capacity(scenes.len());
    let mut cursor = 0.0;
    for (i, (slug, title, dur)) in scenes.iter().enumerate() {
        let start = if i == 0 { 0.0 } else { cursor - xf };
        cursor = start + dur;
        out.push(EpisodeChapter {
            slug: slug.clone(),
            title: title.clone(),
            start_s: round_ms(start.max(0.0)),
            end_s: 0.0,
        });
    }
    for i in 0..out.len() {
        out[i].end_s = if i + 1 < out.len() { out[i + 1].start_s } else { round_ms(total.max(0.0)) };
    }
    out
}

fn round_ms(s: f64) -> f64 {
    (s * 1000.0).round() / 1000.0
}

/// Chapter list for the given scene order, measured from the scene renders.
pub fn chapters_from_scene_renders(
    projects_dir: &Path,
    project_id: &str,
    slugs: &[String],
    crossfade_ms: u64,
) -> Result<Vec<EpisodeChapter>> {
    let titles = scene_titles(projects_dir, project_id);
    let mut scenes = Vec::with_capacity(slugs.len());
    for slug in slugs {
        let wav = crate::app_support::scene_dir(projects_dir, project_id, slug).join("render.wav");
        let info = wav_info(&wav.to_string_lossy())?;
        let dur = info.duration_ms().unwrap_or(0) as f64 / 1000.0;
        let title = titles
            .iter()
            .find(|(s, _)| s == slug)
            .map(|(_, t)| t.clone())
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| slug.clone());
        scenes.push((slug.clone(), title, dur));
    }
    Ok(chapters_for_render(&scenes, crossfade_ms as f64 / 1000.0))
}

fn scene_titles(projects_dir: &Path, project_id: &str) -> Vec<(String, String)> {
    let path = project_dir(projects_dir, project_id).join("storyboard.json");
    read_json::<Storyboard>(&path)
        .map(|sb| sb.scenes.into_iter().map(|s| (s.slug, s.title)).collect())
        .unwrap_or_default()
}

/// Chapters of the current `final.wav`: from its meta when recorded there,
/// otherwise recomputed from the scene order + crossfade the meta does record
/// (renders from before chapters were stored).
pub fn episode_chapters_for(projects_dir: &Path, project_id: &str) -> Result<Vec<EpisodeChapter>> {
    let meta_path = project_dir(projects_dir, project_id)
        .join("output")
        .join("final.wav.meta.json");
    let meta: serde_json::Value = read_json(&meta_path)
        .map_err(|_| Error::Other("render the episode first (no output/final.wav.meta.json)".into()))?;
    if let Some(ch) = meta.get("chapters") {
        if let Ok(list) = serde_json::from_value::<Vec<EpisodeChapter>>(ch.clone()) {
            if !list.is_empty() {
                return Ok(list);
            }
        }
    }
    let slugs: Vec<String> = meta
        .get("scene_slugs")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let crossfade_ms = meta.get("crossfade_ms").and_then(|v| v.as_u64()).unwrap_or(0);
    chapters_from_scene_renders(projects_dir, project_id, &slugs, crossfade_ms)
}

// ── Cover art ─────────────────────────────────────────────────────────────

/// The project's remembered cover image, if one has been set.
pub fn project_cover(projects_dir: &Path, project_id: &str) -> Option<PathBuf> {
    let root = project_dir(projects_dir, project_id);
    COVER_EXTS
        .iter()
        .map(|ext| root.join(format!("cover.{}", ext)))
        .find(|p| p.is_file())
}

/// Copy `source` in as the project's cover, replacing any previous one.
fn set_project_cover(projects_dir: &Path, project_id: &str, source: &Path) -> Result<PathBuf> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| COVER_EXTS.contains(&e.as_str()))
        .ok_or_else(|| Error::Other("cover art must be a .jpg or .png image".into()))?;
    if !source.is_file() {
        return Err(Error::Other(format!("cover image not found: {}", source.display())));
    }
    let root = project_dir(projects_dir, project_id);
    let ext = if ext == "jpeg" { "jpg".to_string() } else { ext };
    let dest = root.join(format!("cover.{}", ext));
    if dest != source {
        std::fs::copy(source, &dest)?;
    }
    for other in COVER_EXTS {
        let p = root.join(format!("cover.{}", other));
        if p != dest {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(dest)
}

// ── ffmetadata ────────────────────────────────────────────────────────────

/// Escape a value for ffmpeg's FFMETADATA1 format.
fn esc(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '=' | ';' | '#' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '\n' => out.push_str("\\\n"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

pub fn ffmetadata(project: &Project, opts: &M4bOptions, chapters: &[EpisodeChapter]) -> String {
    let mut s = String::from(";FFMETADATA1\n");
    let mut tag = |k: &str, v: &str| {
        if !v.trim().is_empty() {
            s.push_str(&format!("{}={}\n", k, esc(v.trim())));
        }
    };
    tag("title", &project.title);
    tag("album", &project.title);
    if let Some(a) = opts.author.as_deref() {
        tag("artist", a);
        tag("album_artist", a);
    }
    if let Some(n) = opts.narrator.as_deref() {
        tag("composer", n);
    }
    tag("genre", "Audio Drama");
    tag("comment", &project.logline);
    tag("description", &project.synopsis);
    tag("date", &project.created_at.format("%Y").to_string());
    tag("media_type", "2"); // iTunes stik: audiobook
    for ch in chapters {
        s.push_str(&format!(
            "[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={}\n",
            (ch.start_s * 1000.0).round() as i64,
            (ch.end_s * 1000.0).round() as i64,
            esc(&ch.title),
        ));
    }
    s
}

// ── Export ────────────────────────────────────────────────────────────────

pub async fn export_m4b(
    projects_dir: &Path,
    project_id: &str,
    output_path: &str,
    opts: M4bOptions,
) -> Result<M4bExport> {
    let root = project_dir(projects_dir, project_id);
    let project: Project = read_json(&root.join("project.json"))?;
    let final_wav = root.join("output").join("final.wav");
    if !final_wav.is_file() {
        return Err(Error::Other("render the episode first (no output/final.wav)".into()));
    }
    let chapters = episode_chapters_for(projects_dir, project_id)?;
    let duration_s = wav_info(&final_wav.to_string_lossy())?
        .duration_ms()
        .unwrap_or(0) as f64
        / 1000.0;

    let cover = match opts.cover_path.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(p) => Some(set_project_cover(projects_dir, project_id, Path::new(p))?),
        None => project_cover(projects_dir, project_id),
    };

    let mut out = PathBuf::from(output_path);
    if out.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) != Some("m4b".into()) {
        out.set_extension("m4b");
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = PathBuf::from(format!("{}.part", out.to_string_lossy()));
    let meta_file = root.join("output").join("m4b.ffmetadata");
    std::fs::write(&meta_file, ffmetadata(&project, &opts, &chapters))?;

    let bitrate = opts.bitrate_kbps.unwrap_or(128).clamp(32, 320);
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.args(["-y", "-loglevel", "error", "-i"]).arg(&final_wav);
    cmd.arg("-i").arg(&meta_file);
    if let Some(c) = &cover {
        cmd.arg("-i").arg(c);
    }
    // Map only the audio (and cover): a chapter-text data track from any input
    // is rejected by the ipod muxer.
    cmd.args(["-map", "0:a:0"]);
    if cover.is_some() {
        cmd.args(["-map", "2:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"]);
    }
    cmd.args(["-map_metadata", "1", "-map_chapters", "1"]);
    cmd.args(["-c:a", "aac", "-b:a", &format!("{}k", bitrate)]);
    cmd.args(["-movflags", "+faststart", "-brand", "M4B ", "-f", "ipod"]);
    cmd.arg(&part);

    let res = cmd
        .output()
        .await
        .map_err(|e| Error::Other(format!("could not run ffmpeg: {}", e)))?;
    let _ = std::fs::remove_file(&meta_file);
    if !res.status.success() {
        let _ = std::fs::remove_file(&part);
        let err = String::from_utf8_lossy(&res.stderr);
        return Err(Error::Other(format!("m4b encode failed:\n{}", &err[..err.len().min(2000)])));
    }
    std::fs::rename(&part, &out)?;
    let bytes = std::fs::metadata(&out)?.len();
    Ok(M4bExport {
        output_path: out.to_string_lossy().into_owned(),
        bytes,
        duration_s,
        chapters,
        cover_path: cover.map(|c| c.to_string_lossy().into_owned()),
    })
}

// ── Tauri surface ─────────────────────────────────────────────────────────

/// Chapters the next export would write (for preview before exporting).
#[tauri::command]
pub fn get_episode_chapters(app: AppHandle, project_id: String) -> Result<Vec<EpisodeChapter>> {
    episode_chapters_for(&app_projects_dir(&app)?, &project_id)
}

/// The project's remembered cover image path, if any.
#[tauri::command]
pub fn get_project_cover(app: AppHandle, project_id: String) -> Result<Option<String>> {
    Ok(project_cover(&app_projects_dir(&app)?, &project_id).map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn export_episode_m4b(
    app: AppHandle,
    project_id: String,
    output_path: String,
    options: Option<M4bOptions>,
) -> Result<M4bExport> {
    export_m4b(&app_projects_dir(&app)?, &project_id, &output_path, options.unwrap_or_default()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(slug: &str, d: f64) -> (String, String, f64) {
        (slug.into(), slug.to_uppercase(), d)
    }

    #[test]
    fn hard_cut_chapters_are_back_to_back() {
        let c = chapters_for_render(&[sc("a", 10.0), sc("b", 20.0), sc("c", 5.0)], 0.0);
        let spans: Vec<(f64, f64)> = c.iter().map(|c| (c.start_s, c.end_s)).collect();
        assert_eq!(spans, vec![(0.0, 10.0), (10.0, 30.0), (30.0, 35.0)]);
        assert_eq!(c[1].title, "B");
    }

    #[test]
    fn crossfades_pull_each_chapter_back_by_the_overlap() {
        // 0.5 s crossfades: b starts fading in at 9.5, c at 9.5 + 20 - 0.5 = 29.0.
        let c = chapters_for_render(&[sc("a", 10.0), sc("b", 20.0), sc("c", 5.0)], 0.5);
        let spans: Vec<(f64, f64)> = c.iter().map(|c| (c.start_s, c.end_s)).collect();
        assert_eq!(spans, vec![(0.0, 9.5), (9.5, 29.0), (29.0, 34.0)]);
    }

    #[test]
    fn single_scene_ignores_crossfade() {
        let c = chapters_for_render(&[sc("a", 12.0)], 2.0);
        assert_eq!((c[0].start_s, c[0].end_s), (0.0, 12.0));
    }

    #[test]
    fn ffmetadata_escapes_and_orders_chapters() {
        let project: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "title": "The Reach; Part = 1", "logline": "Line one\nline two",
            "synopsis": "", "tone": "", "global_audio_notes": "", "target_duration_minutes": 30,
            "created_at": "2026-01-02T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
            "characters": [], "llm_config": {"provider": "anthropic", "model": "m", "api_key_env": "K"}
        }))
        .unwrap();
        let opts = M4bOptions { author: Some("Max #1".into()), ..Default::default() };
        let chapters = chapters_for_render(&[sc("a", 1.5), sc("b", 2.0)], 0.0);
        let m = ffmetadata(&project, &opts, &chapters);
        assert!(m.starts_with(";FFMETADATA1\n"));
        assert!(m.contains("title=The Reach\\; Part \\= 1\n"));
        assert!(m.contains("artist=Max \\#1\n"));
        assert!(m.contains("comment=Line one\\\nline two\n"));
        assert!(m.contains("date=2026\n"));
        assert!(m.contains("media_type=2\n"));
        assert!(!m.contains("description="), "empty tags are omitted");
        assert!(m.contains("START=0\nEND=1500\ntitle=A\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1500\nEND=3500\ntitle=B\n"));
    }
}
