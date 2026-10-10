//! `pharaoh series …` and `pharaoh episode …`: show bibles and the episode
//! writer from the command line. A series can be named by id or title.

use std::path::PathBuf;

use super::helpers::{flag_opt, parse_flags, print_json};
use crate::commands::episode_writer::{self, CanonDraft, EpisodePlan, WriteEpisodeArgs, WriterSettings};
use crate::commands::series::{create_series_at, episodes_in, list_series_in, load_canon, resolve_series};
use crate::error::{Error, Result};
use crate::models::AppConfig;

fn dir(config: &AppConfig) -> PathBuf {
    PathBuf::from(&config.projects_dir)
}

fn settings(flags: &std::collections::HashMap<String, String>) -> WriterSettings {
    WriterSettings { model: flag_opt(flags, "model"), api_key_env: flag_opt(flags, "api_key_env") }
}

pub(super) async fn series_list(config: &AppConfig) -> Result<()> {
    let d = dir(config);
    let rows: Vec<_> = list_series_in(&d)?
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id, "title": s.title, "format": s.format, "logline": s.logline,
                "cast": s.cast.iter().map(|m| &m.name).collect::<Vec<_>>(),
                "episodes": episodes_in(&d, &s.id).len(),
            })
        })
        .collect();
    print_json(&rows)
}

pub(super) async fn series_show(config: &AppConfig, reference: &str) -> Result<()> {
    let d = dir(config);
    let s = resolve_series(&d, reference)?;
    let canon = load_canon(&d, &s.id)?;
    let episodes: Vec<_> = episodes_in(&d, &s.id)
        .into_iter()
        .map(|p| serde_json::json!({ "id": p.id, "title": p.title, "logline": p.logline }))
        .collect();
    print_json(&serde_json::json!({ "series": s, "episodes": episodes, "canon": canon }))
}

pub(super) async fn series_brief(config: &AppConfig, reference: &str) -> Result<()> {
    let d = dir(config);
    let s = resolve_series(&d, reference)?;
    let canon = load_canon(&d, &s.id)?;
    println!("{}", episode_writer::series_brief(&s, &canon));
    Ok(())
}

pub(super) async fn series_create(config: &AppConfig, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let title = flag_opt(&flags, "title").ok_or_else(|| Error::Other("missing --title".into()))?;
    let d = dir(config);
    let mut s = create_series_at(&d, title, flag_opt(&flags, "logline"), flag_opt(&flags, "format"))?;
    if let Some(pitch) = flag_opt(&flags, "pitch") {
        eprintln!("[bible] drafting from the description");
        s = episode_writer::draft_bible_impl(&d, &s.id, &pitch, &settings(&flags)).await?;
    }
    print_json(&s)
}

pub(super) async fn episode_pitch(config: &AppConfig, reference: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let d = dir(config);
    let s = resolve_series(&d, reference)?;
    let hint = flag_opt(&flags, "hint").unwrap_or_default();
    print_json(&episode_writer::pitch_impl(&d, &s.id, &hint, &settings(&flags)).await?)
}

pub(super) async fn episode_plan(config: &AppConfig, reference: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let d = dir(config);
    let s = resolve_series(&d, reference)?;
    let premise = flag_opt(&flags, "premise").unwrap_or_default();
    print_json(&episode_writer::plan_impl(&d, &s.id, &premise, &settings(&flags)).await?)
}

/// The whole thing: (pitch if no premise) → plan → write → punch up → import.
pub(super) async fn episode_new(config: &AppConfig, reference: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let d = dir(config);
    let s = resolve_series(&d, reference)?;
    let st = settings(&flags);
    let plan: Option<EpisodePlan> = match flag_opt(&flags, "plan") {
        Some(path) => Some(serde_json::from_str(&std::fs::read_to_string(&path)?)
            .map_err(|e| Error::Other(format!("{path}: not a beat sheet: {e}")))?),
        None => None,
    };
    let mut premise = flag_opt(&flags, "premise").unwrap_or_default();
    if premise.is_empty() && plan.is_none() {
        eprintln!("[pitch] no premise given; pitching");
        let pitches = episode_writer::pitch_impl(&d, &s.id, "", &st).await?;
        let first = pitches.into_iter().next().ok_or_else(|| Error::Other("no pitches came back".into()))?;
        eprintln!("[pitch] {}: {}", first.title, first.logline);
        premise = format!("{}: {}", first.title, first.logline);
    }
    let args = WriteEpisodeArgs {
        series_id: s.id.clone(),
        premise,
        plan,
        episode_id: flag_opt(&flags, "episode"),
        punch_up: flag_opt(&flags, "punch_up").map(|v| v != "false"),
        settings: st,
    };
    let progress = |stage: &str, message: &str| eprintln!("[{stage}] {message}");
    let r = episode_writer::write_impl(config, args, &progress).await?;
    print_json(&serde_json::json!({
        "project_id": r.project.id,
        "title": r.project.title,
        "logline": r.project.logline,
        "scenes": r.scenes,
        "sound_cues_bound": r.sound_cues_bound,
        "new_characters": r.new_characters,
        "input_tokens": r.input_tokens,
        "output_tokens": r.output_tokens,
        "next": format!("pharaoh project status {}", r.project.id),
    }))
}

/// Land a script written elsewhere (an agent, a person) as an episode:
/// `pharaoh episode import <series> <script.fountain|-> [--title] [--logline]
/// [--synopsis] [--canon <json>]`. Same import, cast linking, sound-cue
/// binding and canon log as the writer.
pub(super) async fn episode_import(config: &AppConfig, reference: &str, file: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let d = dir(config);
    let s = resolve_series(&d, reference)?;
    let fountain = if file == "-" {
        let mut t = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut t)?;
        t
    } else {
        std::fs::read_to_string(file)?
    };
    let title = flag_opt(&flags, "title")
        .or_else(|| fountain.lines().find_map(|l| l.trim().strip_prefix("Title:").map(|t| t.trim().to_string())))
        .unwrap_or_default();
    let plan = EpisodePlan {
        title,
        logline: flag_opt(&flags, "logline").unwrap_or_default(),
        synopsis: flag_opt(&flags, "synopsis").unwrap_or_default(),
        ..Default::default()
    };
    let entry: CanonDraft = match flag_opt(&flags, "canon") {
        Some(j) => serde_json::from_str(&j).map_err(|e| Error::Other(format!("--canon: {e}")))?,
        None => CanonDraft::default(),
    };
    let mut canon = load_canon(&d, &s.id)?;
    let landed = episode_writer::land_episode(
        config, &s, &mut canon, &plan, &fountain, entry, flag_opt(&flags, "episode").as_deref(),
        serde_json::json!({ "source": "import" }),
    )?;
    print_json(&serde_json::json!({
        "project_id": landed.project.id,
        "title": landed.project.title,
        "scenes": landed.scenes,
        "sound_cues_bound": landed.sound_cues_bound,
        "new_characters": landed.new_characters,
        "next": format!("pharaoh project status {}", landed.project.id),
    }))
}
