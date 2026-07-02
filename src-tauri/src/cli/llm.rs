//! `pharaoh llm draft-scene` and `pharaoh storyboard review|rewrite` — the
//! GUI's Anthropic-backed scene drafting and continuity-review passes,
//! assembled from on-disk project/storyboard state.

use std::path::PathBuf;

use serde_json::json;

use super::helpers::{
    find_scene, flag_opt, flag_parse, load_project, load_storyboard, parse_flags, print_json,
    scene_not_found, update_project_timestamp,
};
use super::scene_script::{compile_fountain_for_scene, fountain_path, write_scene_fountain};
use crate::app_support::{read_script_rows, script_path};
use crate::error::{Error, Result};

/// `pharaoh storyboard rewrite <project> [--model <name>]`
///
/// Loads the project, all scenes, and every scene's compiled prose (from
/// script.csv prompts), then asks the configured LLM to do a Chekhov's
/// Gun continuity pass. Prints markdown to stdout.
pub(super) async fn storyboard_rewrite(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let model_override = flag_opt(&flags, "model");
    let api_key_env_override = flag_opt(&flags, "api_key_env");

    let project = load_project(config, project_id)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let storyboard = load_storyboard(&projects_dir, project_id)?;

    // Build prose per scene from script.csv prompts. Each row contributes a
    // line — DIALOGUE rows become "CHARACTER: text", others become bracketed
    // cues like "[SFX: door creak]". This is enough context for continuity
    // review without needing the full audio.
    let mut scene_summaries: Vec<serde_json::Value> = Vec::new();
    let cast_by_id: std::collections::HashMap<&str, &str> = project
        .characters
        .iter()
        .map(|c| (c.id.as_str(), c.name.as_str()))
        .collect();
    for scene in &storyboard.scenes {
        let csv_path = script_path(&projects_dir, project_id, &scene.slug);
        let rows = if csv_path.exists() {
            read_script_rows(&csv_path).unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut prose = String::new();
        for row in &rows {
            let kind = row.track_type.to_uppercase();
            let line = match kind.as_str() {
                "DIALOGUE" => {
                    let name = cast_by_id
                        .get(row.character.as_str())
                        .copied()
                        .unwrap_or(row.character.as_str());
                    let mut s = format!("{}: {}", name.to_uppercase(), row.prompt);
                    if !row.instruct.is_empty() {
                        s = format!("{} [({})]", s, row.instruct);
                    }
                    s
                }
                "DIRECTION" => format!("[ACTION: {}]", row.prompt),
                "SFX" | "BED" | "MUSIC" => format!("[{}: {}]", kind, row.prompt),
                _ => format!("[{}: {}]", kind, row.prompt),
            };
            prose.push_str(&line);
            prose.push('\n');
        }
        let scene_no = format!("S{:02}", scene.index + 1);
        scene_summaries.push(serde_json::json!({
            "slug": scene.slug,
            "no": scene_no,
            "title": scene.title,
            "description": scene.description,
            "location": scene.location,
            "prose": prose.trim(),
        }));
    }

    let args = serde_json::json!({
        "project_title": project.title,
        "logline": project.logline,
        "synopsis": project.synopsis,
        "tone": project.tone,
        "characters": project.characters.iter().map(|c| serde_json::json!({
            "name": c.name,
            "description": c.description,
            "voice_direction": c.voice_assignment.instruct_default,
        })).collect::<Vec<_>>(),
        "scenes": scene_summaries,
        "model": model_override,
        "api_key_env": api_key_env_override,
    });

    let parsed: crate::commands::llm::StoryboardReviewArgs = serde_json::from_value(args)
        .map_err(|e| Error::Other(format!("review args build failed: {}", e)))?;
    let result = crate::commands::llm::storyboard_review_impl(parsed).await?;

    // Print as plain markdown to stdout — this is meant to be piped into a
    // user's editor or read directly. JSON wrapper would be noise.
    println!("{}", result.review);
    eprintln!(
        "\n— continuity review · {} · {}→{} tok",
        result.model, result.input_tokens, result.output_tokens
    );
    Ok(())
}

/// `pharaoh llm draft-scene <project> <scene> [--write-fountain true]`
///
/// Runs the same Anthropic scene-drafting pass used by the GUI, assembled from
/// on-disk project/storyboard state. By default it prints JSON only; with
/// `--write-fountain true` it also persists script.fountain and compiles the
/// generated Fountain text back to script.csv.
pub(super) async fn llm_draft_scene(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let write_fountain: bool = flag_parse(&flags, "write_fountain", false)?;
    let compile_after_write: bool = flag_parse(&flags, "compile", true)?;
    let project = load_project(config, project_id)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let storyboard = load_storyboard(&projects_dir, project_id)?;
    let scene = find_scene(&storyboard, scene_slug)
        .ok_or_else(|| scene_not_found(scene_slug, project_id))?;
    let previous_path = fountain_path(&projects_dir, project_id, &scene.slug);
    let previous_fountain = if previous_path.exists() {
        Some(
            std::fs::read_to_string(&previous_path)
                .map_err(|e| Error::Other(format!("read {}: {}", previous_path.display(), e)))?,
        )
    } else {
        None
    };

    let args = crate::commands::llm::DraftSceneArgs {
        project_title: project.title.clone(),
        logline: project.logline.clone(),
        synopsis: project.synopsis.clone(),
        tone: project.tone.clone(),
        characters: project
            .characters
            .iter()
            .map(|character| crate::commands::llm::DraftCharacter {
                name: character.name.clone(),
                description: character.description.clone(),
                voice_direction: character.voice_assignment.instruct_default.clone(),
            })
            .collect(),
        scene_title: scene.title.clone(),
        scene_description: scene.description.clone(),
        scene_location: scene.location.clone(),
        previous_fountain,
        model: flag_opt(&flags, "model"),
        api_key_env: flag_opt(&flags, "api_key_env"),
    };
    let result = crate::commands::llm::draft_scene_impl(args).await?;

    let mut written_path: Option<PathBuf> = None;
    let mut compiled_rows: Option<usize> = None;
    if write_fountain {
        let path = write_scene_fountain(config, project_id, &scene.slug, &result.fountain)?;
        written_path = Some(path);
        if compile_after_write {
            compiled_rows = Some(compile_fountain_for_scene(
                config,
                project_id,
                &scene.slug,
                &result.fountain,
            )?);
        } else {
            update_project_timestamp(config, project_id)?;
        }
    }

    print_json(&json!({
        "project_id": project_id,
        "scene_slug": scene.slug,
        "fountain": result.fountain,
        "model": result.model,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "written_path": written_path,
        "compiled_rows": compiled_rows,
    }))
}
