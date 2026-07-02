//! `pharaoh compose ...` and `pharaoh audio ...` commands: scene/episode
//! rendering through the shared Rust audio engine, render metadata, and
//! waveform inspection primitives (peaks, duration, zero-crossings).

use std::path::PathBuf;

use serde_json::json;

use super::helpers::{flag_opt, flag_parse, parse_flags, print_json};
use crate::commands::audio::{find_zero_crossings, get_duration_ms, get_waveform_peaks};
use crate::commands::audio_engine::{
    render_episode_with_projects_dir, render_scene_with_projects_dir,
};
use crate::error::{Error, Result};

pub(super) async fn compose_render_scene(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let output_path =
        render_scene_with_projects_dir(&projects_dir, project_id, scene_slug, None).await?;
    print_json(&json!({
        "project_id": project_id,
        "scene_slug": scene_slug,
        "output_path": output_path,
    }))
}

/// `pharaoh compose final <project> [--crossfade <ms>] [--target-lufs <n>]`
pub(super) async fn compose_final(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let crossfade_ms: u64 = flag_parse(&flags, "crossfade", 500)?;
    let target_lufs: Option<f32> = flag_opt(&flags, "target_lufs")
        .map(|v| {
            v.parse::<f32>()
                .map_err(|_| Error::Other("invalid --target-lufs".into()))
        })
        .transpose()?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let output_path = render_episode_with_projects_dir(
        &projects_dir,
        project_id,
        crossfade_ms,
        target_lufs,
        None,
    )
    .await?;
    print_json(&json!({
        "project_id": project_id,
        "output_path": output_path,
        "crossfade_ms": crossfade_ms,
    }))
}

pub(super) async fn compose_meta(render_path: &str) -> Result<()> {
    let meta = crate::commands::audio_engine::read_render_meta(render_path.to_string()).await?;
    print_json(&json!({
        "render_path": render_path,
        "meta": meta,
    }))
}

pub(super) async fn audio_peaks(audio_path: &str, num_peaks: usize) -> Result<()> {
    let peaks = get_waveform_peaks(audio_path.to_string(), num_peaks)?;
    print_json(&json!({
        "audio_path": audio_path,
        "num_peaks": num_peaks,
        "peaks": peaks,
    }))
}

pub(super) async fn audio_duration(audio_path: &str) -> Result<()> {
    let duration_ms = get_duration_ms(audio_path.to_string())?;
    print_json(&json!({
        "audio_path": audio_path,
        "duration_ms": duration_ms,
    }))
}

pub(super) async fn audio_zero_crossings(audio_path: &str, near_ms: u64) -> Result<()> {
    let crossings_ms = find_zero_crossings(audio_path.to_string(), near_ms)?;
    print_json(&json!({
        "audio_path": audio_path,
        "near_ms": near_ms,
        "crossings_ms": crossings_ms,
    }))
}
