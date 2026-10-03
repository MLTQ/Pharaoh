//! `pharaoh dissect …` — voices from an existing recording, headless.
//!
//! Thin wrappers over `commands::dissect`'s shared core, so the CLI and the
//! GUI produce identical imports and identical characters.

use std::path::PathBuf;
use std::time::Duration;

use crate::commands::dissect::{
    self, AssignSpeakerRequest, DissectOptions, DEFAULT_RIGHTS_STATEMENT,
};
use crate::error::{Error, Result};
use crate::models::AppConfig;

use super::helpers::{flag_opt, flag_parse, parse_flags, print_json};

fn projects_dir(config: &AppConfig) -> PathBuf {
    PathBuf::from(&config.projects_dir)
}

/// `dissect run <audio> [--separate true|false] [--max-candidates n] [--wait true|false]`
pub(super) async fn run(config: &AppConfig, source: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let options = DissectOptions {
        separate: Some(flag_parse(&flags, "separate", true)?),
        max_candidates: flags.get("max_candidates").map(|v| v.parse()).transpose()
            .map_err(|_| Error::Other("invalid --max-candidates".into()))?,
        chunk_minutes: flags.get("chunk_minutes").map(|v| v.parse()).transpose()
            .map_err(|_| Error::Other("invalid --chunk-minutes".into()))?,
        ..Default::default()
    };
    let source = std::fs::canonicalize(source)
        .map_err(|e| Error::Other(format!("source {}: {}", source, e)))?;
    let http = reqwest::Client::new();
    let import = dissect::submit(
        &http,
        &config.dissect_url,
        &projects_dir(config),
        &source.to_string_lossy(),
        options,
        false,
    )
    .await?;
    if !flag_parse(&flags, "wait", true)? {
        return print_json(&import);
    }
    wait_for(&http, config, &import.import_id).await
}

/// Poll to a terminal state, echoing stage changes to stderr.
async fn wait_for(http: &reqwest::Client, config: &AppConfig, import_id: &str) -> Result<()> {
    let mut last = String::new();
    loop {
        let status = dissect::poll(http, &projects_dir(config), import_id).await?;
        let line = format!(
            "{:>3}% {}",
            (status.progress * 100.0) as u32,
            status.message.clone().unwrap_or_default()
        );
        if line != last {
            eprintln!("{}", line);
            last = line;
        }
        if status.status != "running" {
            if status.status == "failed" {
                return Err(Error::Other(status.error.unwrap_or_else(|| "dissect failed".into())));
            }
            if status.status == "cancelled" {
                return Err(Error::Other("dissect was cancelled".into()));
            }
            return print_json(&status);
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

/// `dissect status <import_id>`
pub(super) async fn status(config: &AppConfig, import_id: &str) -> Result<()> {
    let s = dissect::poll(&reqwest::Client::new(), &projects_dir(config), import_id).await?;
    print_json(&s)
}

/// `dissect list`
pub(super) fn list(config: &AppConfig) -> Result<()> {
    print_json(&dissect::list_imports(&projects_dir(config))?)
}

/// `dissect assign <import_id> <speaker_id> --clips S1_c1,S1_c2 [--gold S1_c1]
///  (--name <new> | --library-id <id>) --confirm-rights yes [--performer <name>] [--project <id>]`
pub(super) async fn assign(
    config: &AppConfig,
    import_id: &str,
    speaker_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let confirmed = matches!(
        flags.get("confirm_rights").map(String::as_str),
        Some("yes" | "true")
    );
    if !confirmed {
        return Err(Error::Other(format!(
            "pass --confirm-rights yes to affirm: \"{}\"",
            DEFAULT_RIGHTS_STATEMENT
        )));
    }
    let clips: Vec<String> = flag_opt(&flags, "clips")
        .ok_or_else(|| Error::Other("missing --clips".into()))?
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let character = dissect::assign_speaker(
        &projects_dir(config),
        AssignSpeakerRequest {
            import_id: import_id.into(),
            speaker_id: speaker_id.into(),
            candidate_ids: clips,
            gold_candidate_id: flag_opt(&flags, "gold"),
            library_id: flag_opt(&flags, "library_id"),
            new_name: flag_opt(&flags, "name"),
            rights_confirmed: true,
            rights_statement: None,
            performer: flag_opt(&flags, "performer"),
        },
    )?;
    if let (Some(project_id), Some(library_id)) = (flag_opt(&flags, "project"), character.library_id.clone()) {
        let imported = crate::commands::character::import_into_project(
            &projects_dir(config),
            &project_id,
            &library_id,
            None,
        )?;
        return print_json(&serde_json::json!({ "library": character, "project_character": imported }));
    }
    print_json(&character)
}

/// `dissect delete <import_id>`
pub(super) fn delete(config: &AppConfig, import_id: &str) -> Result<()> {
    dissect::delete_import(&projects_dir(config), import_id)?;
    print_json(&serde_json::json!({ "deleted": import_id }))
}

/// `dissect cancel <import_id>`
pub(super) async fn cancel(config: &AppConfig, import_id: &str) -> Result<()> {
    print_json(&dissect::cancel(&reqwest::Client::new(), &projects_dir(config), import_id).await?)
}

/// `dissect retry <import_id> [--wait true|false]`
pub(super) async fn retry(config: &AppConfig, import_id: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let http = reqwest::Client::new();
    let import = dissect::retry(&http, &config.dissect_url, &projects_dir(config), import_id, false).await?;
    if !flag_parse(&flags, "wait", true)? {
        return print_json(&import);
    }
    wait_for(&http, config, import_id).await
}

/// `dissect rebuild <import_id> --confirm-rights yes [--title T] [--chapters 0,2]
///  [--plan true] [--sounds true|false] [--remainders true|false]`
pub(super) fn rebuild(config: &AppConfig, import_id: &str, rest: &[String]) -> Result<()> {
    use crate::commands::rebuild as rb;
    let flags = parse_flags(rest)?;
    let mut opts = rb::RebuildOptions {
        title: flag_opt(&flags, "title"),
        rights_confirmed: matches!(flags.get("confirm_rights").map(String::as_str), Some("yes" | "true")),
        include_sounds: flag_parse(&flags, "sounds", true)?,
        include_remainders: flag_parse(&flags, "remainders", true)?,
        ..Default::default()
    };
    if let Some(c) = flag_opt(&flags, "chapters") {
        opts.chapters = Some(c.split(',').filter_map(|x| x.trim().parse().ok()).collect());
    }
    if let Some(m) = flags.get("max_scene_minutes") {
        opts.max_scene_minutes = m.parse().map_err(|_| Error::Other("invalid --max-scene-minutes".into()))?;
    }
    let dir = projects_dir(config);
    if flag_parse(&flags, "plan", false)? {
        return print_json(&rb::plan_for(&dir, import_id, &opts)?);
    }
    if !opts.rights_confirmed {
        return Err(Error::Other(format!("pass --confirm-rights yes to affirm: \"{}\"", DEFAULT_RIGHTS_STATEMENT)));
    }
    let last = std::sync::Mutex::new(String::new());
    let cb = |f: f32, msg: &str| {
        if let Ok(mut l) = last.lock() {
            if *l != msg { eprintln!("{:>3}% {}", (f * 100.0) as u32, msg); *l = msg.to_string(); }
        }
    };
    let project_id = rb::rebuild(&dir, import_id, &opts, &cb)?;
    print_json(&serde_json::json!({ "project_id": project_id }))
}

/// `dissect emotions <import_id>` — tag an import's dialogue with emotions
/// (writes emotions.json; new dissects do this themselves).
pub(super) async fn emotions(config: &AppConfig, import_id: &str) -> Result<()> {
    use crate::commands::emotions as em;
    let (job, fut) = em::start(reqwest::Client::new(), config.dissect_url.clone(), projects_dir(config), import_id.to_string())?;
    let work = tokio::spawn(fut);
    let mut last = String::new();
    loop {
        let s = em::dissect_emotion_status(job.clone())?;
        let line = format!("{:>3.0}% {}", s.progress * 100.0, s.message);
        if line != last {
            eprintln!("{}", line);
            last = line;
        }
        if s.done {
            let _ = work.await;
            if let Some(e) = s.error {
                return Err(Error::Other(e));
            }
            return print_json(&s);
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// `dissect clips <import_id> <S4,S38> <emotion> [--like <start_s>] [--limit N]`
/// — a character's best clips for a palette emotion (its built-in recipe), or
/// the clips most like the one starting at `--like`.
pub(super) fn clips(config: &AppConfig, import_id: &str, speakers: &str, emotion: &str, rest: &[String]) -> Result<()> {
    use crate::commands::emotions as em;
    let flags = parse_flags(rest)?;
    let speakers: Vec<String> = speakers.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let limit: usize = flag_parse(&flags, "limit", 8)?;
    match flag_opt(&flags, "like") {
        Some(start) => {
            let start: f64 = start.parse().map_err(|_| Error::Other("--like takes a start time in seconds".into()))?;
            print_json(&em::similar_for(&projects_dir(config), import_id, &speakers, start, limit)?)
        }
        None => print_json(&em::clips_for(&projects_dir(config), import_id, &speakers, emotion, None, limit)?),
    }
}

/// `dissect palette <library_id> [--replace true] [--per 4]` — fill a Library
/// character's emotional palette from its dissected performance.
pub(super) fn palette(config: &AppConfig, library_id: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let replace = matches!(flag_opt(&flags, "replace").as_deref(), Some("true" | "yes" | "1"));
    let per: usize = flag_parse(&flags, "per", 4)?;
    let r = crate::commands::emotions::build_library_palette(&projects_dir(config), library_id, replace, per)?;
    print_json(&r.report)
}

/// `dissect corpus <library_id> [--minutes 15]` — fill a Library character's
/// RVC corpus with its own clean lines from the dissected recording.
pub(super) fn corpus(config: &AppConfig, library_id: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let minutes: f64 = flag_parse(&flags, "minutes", 15.0)?;
    print_json(&crate::commands::emotions::corpus_for(&projects_dir(config), crate::app_support::LIBRARY_DIR_NAME, library_id, minutes)?)
}

// ── pharaoh library … ─────────────────────────────────────────────────────

pub(super) fn library_list(config: &AppConfig) -> Result<()> {
    print_json(&crate::commands::character::list_library(&projects_dir(config))?)
}

pub(super) fn library_export(config: &AppConfig, library_id: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let out = flag_opt(&flags, "output").ok_or_else(|| Error::Other("--output <file.zip> is required".into()))?;
    let corpus = matches!(flag_opt(&flags, "include_corpus").as_deref(), Some("true" | "yes" | "1"));
    print_json(&crate::commands::character::export_library_character_to(&projects_dir(config), library_id.to_string(), out, corpus)?)
}

pub(super) fn library_import(config: &AppConfig, file: &str) -> Result<()> {
    print_json(&crate::commands::character::import_library_file(&projects_dir(config), file.to_string())?)
}

pub(super) fn library_add(config: &AppConfig, project_id: &str, library_id: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    print_json(&crate::commands::character::import_into_project(&projects_dir(config), project_id, library_id, flag_opt(&flags, "name"))?)
}

/// `script layout <project_id> <scene_slug>` — place generated rows on the timeline.
pub(super) fn layout(config: &AppConfig, project_id: &str, scene_slug: &str, rest: &[String]) -> Result<()> {
    use crate::commands::layout::{layout_scene, LayoutOptions};
    let flags = parse_flags(rest)?;
    let d = LayoutOptions::default();
    let opts = LayoutOptions {
        replace: matches!(flag_opt(&flags, "replace").as_deref(), Some("true" | "yes" | "1")),
        gap_ms: flag_parse(&flags, "gap_ms", d.gap_ms)?,
        lead_in_ms: flag_parse(&flags, "lead_in_ms", d.lead_in_ms)?,
        ..d
    };
    print_json(&layout_scene(&projects_dir(config), project_id, scene_slug, &opts)?)
}
