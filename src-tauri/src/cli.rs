use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::app_support::{
    default_config_path, ensure_app_dirs, load_or_default_app_config, project_dir, read_json,
    read_script_rows, scene_dir, script_path, update_script_row_fields, write_json,
    write_script_rows,
};
use crate::commands::audio_engine::{
    import_audio_asset_with_projects_dir, process_clip_asset, ClipProcessRequest,
    ImportAudioRequest,
};
use crate::commands::audio_engine::{
    normalize_clip, render_scene_with_projects_dir, resample_to_48k,
};
use crate::commands::audio_enhance::{output_path_for, write_upscale_sidecar};
use crate::commands::inference::finalize_generation_output;
use crate::commands::sidecar::{read_sidecar, update_sidecar_qa, write_sidecar};
use crate::error::{Error, Result};
use crate::models::{
    Character, GeneratedAudioAsset, LlmConfig, MusicText2MusicRequest, Project, Scene, SceneStatus,
    ScriptRow, SfxT2ARequest, SidecarMeta, Storyboard, TtsCustomVoiceRequest, TtsVoiceCloneRequest,
    TtsVoiceDesignRequest, VoiceAssignment,
};

pub async fn run(args: Vec<String>) -> Result<()> {
    let config_path = default_config_path()?;
    let config = load_or_default_app_config(&config_path)?;
    ensure_app_dirs(&config)?;

    match args.as_slice() {
        [group, action] if group == "project" && action == "list" => project_list(&config).await,
        [group, action, project_id] if group == "project" && action == "status" => {
            project_status(&config, project_id).await
        }
        [group, action, rest @ ..] if group == "project" && action == "create" => {
            project_create(&config, rest).await
        }
        [group, action, project_id, rest @ ..] if group == "project" && action == "update" => {
            project_update(&config, project_id, rest).await
        }
        [group, action, project_id] if group == "scene" && action == "list" => {
            scene_list(&config, project_id).await
        }
        [group, action, project_id, scene_ref] if group == "scene" && action == "get" => {
            scene_get(&config, project_id, scene_ref).await
        }
        [group, action, project_id, rest @ ..] if group == "scene" && action == "create" => {
            scene_create(&config, project_id, rest).await
        }
        [group, action, project_id, scene_ref, rest @ ..]
            if group == "scene" && action == "update" =>
        {
            scene_update(&config, project_id, scene_ref, rest).await
        }
        [group, action, project_id, scene_slug] if group == "script" && action == "read" => {
            script_read(&config, project_id, scene_slug).await
        }
        [group, action, project_id, scene_slug, input_path]
            if group == "script" && action == "write" =>
        {
            script_write(&config, project_id, scene_slug, input_path).await
        }
        [group, action, project_id, scene_slug, row_index, rest @ ..]
            if group == "script" && action == "update-row" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            script_update_row(&config, project_id, scene_slug, row_index, rest).await
        }
        [group, action, rest @ ..] if group == "server" && action == "health" => {
            server_health(&config, rest).await
        }
        [group, action] if group == "server" && action == "config" => {
            server_config_get(&config).await
        }
        [group, action, rest @ ..] if group == "server" && action == "config-set" => {
            server_config_set(&config_path, config.clone(), rest).await
        }
        [group, action, model, rest @ ..] if group == "model" && action == "load" => {
            model_load(&config, model, rest).await
        }
        [group, action, model] if group == "model" && action == "unload" => {
            model_unload(&config, model).await
        }
        [group, action, project_id] if group == "character" && action == "list" => {
            character_list(&config, project_id).await
        }
        [group, action, project_id, rest @ ..] if group == "character" && action == "create" => {
            character_create(&config, project_id, rest).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "update" =>
        {
            character_update(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, character_id] if group == "character" && action == "delete" => {
            character_delete(&config, project_id, character_id).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "voice-set" =>
        {
            character_voice_set(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "voice-design-test" =>
        {
            character_voice_design_test(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "voice-clone-test" =>
        {
            character_voice_clone_test(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, rest @ ..] if group == "asset" && action == "list" => {
            asset_list(&config, project_id, rest).await
        }
        [group, action, audio_path] if group == "asset" && action == "meta" => {
            asset_meta(audio_path).await
        }
        [group, action, audio_path, rest @ ..] if group == "asset" && action == "qa" => {
            asset_qa(audio_path, rest).await
        }
        [group, action, audio_path] if group == "asset" && action == "takes" => {
            asset_takes(audio_path).await
        }
        [group, action, project_id, scene_slug, row_index, audio_path]
            if group == "asset" && action == "use" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            asset_use(&config, project_id, scene_slug, row_index, audio_path).await
        }
        [group, action, subaction, project_id, scene_slug]
            if group == "compose" && action == "render" && subaction == "scene" =>
        {
            compose_render_scene(&config, project_id, scene_slug).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "tts-custom" => {
            generate_tts_custom(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "tts-design" => {
            generate_tts_design(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "tts-clone" => {
            generate_tts_clone(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "sfx" => {
            generate_direct_sfx(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "music" => {
            generate_direct_music(&config, rest).await
        }
        [group, action, project_id, source_path, rest @ ..]
            if group == "post" && action == "import" =>
        {
            post_import(&config, project_id, source_path, rest).await
        }
        [group, action, input_path, rest @ ..] if group == "post" && action == "process" => {
            post_process(input_path, rest).await
        }
        [group, action, input_path, rest @ ..] if group == "post" && action == "normalize" => {
            post_normalize(input_path, rest).await
        }
        [group, action, input_path, output_path] if group == "post" && action == "resample" => {
            post_resample(input_path, output_path).await
        }
        [group, action, input_path, rest @ ..] if group == "post" && action == "upscale" => {
            post_upscale(&config, input_path, rest).await
        }
        [group, action] if group == "setup" && action == "status" => setup_status(&config).await,
        [group, action, subaction, project_id, scene_slug, row_index]
            if group == "generate" && action == "row" && subaction == "scene" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            generate_row(&config, project_id, scene_slug, row_index).await
        }
        [group, action, subaction, project_id, scene_slug]
            if group == "generate" && action == "all" && subaction == "scene" =>
        {
            generate_all(&config, project_id, scene_slug).await
        }
        _ => Err(Error::Other(usage().to_string())),
    }
}

fn usage() -> &'static str {
    "usage:
  pharaoh project list
  pharaoh project status <project_id>
  pharaoh project create --title <title> [--logline <text>] [--tone <text>]
  pharaoh project update <project_id> [--title <text>] [--synopsis <text>] [--tone <text>]
  pharaoh scene list <project_id>
  pharaoh scene get <project_id> <scene_slug_or_id>
  pharaoh scene create <project_id> --title <title> [--slug <slug>] [--index <n>]
  pharaoh scene update <project_id> <scene_slug_or_id> [--status draft|generating|assets_ready|composed|rendered]
  pharaoh script read <project_id> <scene_slug>
  pharaoh script write <project_id> <scene_slug> <script.csv|script.json>
  pharaoh script update-row <project_id> <scene_slug> <row_index> [--prompt <text>] [--instruct <text>] [--file <path>]
  pharaoh character list <project_id>
  pharaoh character create <project_id> --name <name> [--description <text>]
  pharaoh character update <project_id> <character_id> [--name <name>] [--description <text>]
  pharaoh character delete <project_id> <character_id>
  pharaoh character voice-set <project_id> <character_id> [--model CustomVoice|VoiceDesign|VoiceClone] [--instruct <text>]
  pharaoh character voice-design-test <project_id> <character_id> --voice-description <text> [--text <text>]
  pharaoh character voice-clone-test <project_id> <character_id> --ref-audio-path <wav> [--text <text>]
  pharaoh server health [tts|sfx|music|post|all]
  pharaoh server config
  pharaoh server config-set [--tts-url <url>] [--sfx-url <url>] [--music-url <url>] [--post-url <url>]
  pharaoh model load <tts|sfx|music|post> [--variant <name>]
  pharaoh model unload <tts|sfx|music|post>
  pharaoh asset list <project_id> [--kind tts|sfx|music] [--scene <slug>]
  pharaoh asset meta <audio_path>
  pharaoh asset qa <audio_path> --status <status> [--notes <text>]
  pharaoh asset takes <audio_path>
  pharaoh asset use <project_id> <scene_slug> <row_index> <audio_path>
  pharaoh generate tts-custom --text <text> --output-path <wav> [--speaker <name>] [--instruct <text>]
  pharaoh generate tts-design --text <text> --voice-description <text> --output-path <wav>
  pharaoh generate tts-clone --text <text> --ref-audio-path <wav> --output-path <wav>
  pharaoh generate sfx --prompt <text> --output-path <wav> [--backend woosh|audioldm] [--model-variant <name>] [--duration-seconds <n>] [--steps <n>] [--seed <n>] [--cfg-scale <n>] [--guidance-scale <n>] [--negative-prompt <text>] [--num-waveforms-per-prompt <n>]
  pharaoh generate music --caption <text> --output-path <wav> [--lyrics <text>] [--duration-seconds <n>] [--bpm <n>] [--key <key>] [--language <code>] [--lm-model-size <name>] [--diffusion-steps <n>] [--thinking-mode true|false] [--reference-audio-path <wav>] [--seed <n>] [--batch-size <n>]
  pharaoh compose render scene <project_id> <scene_slug>
  pharaoh post import <project_id> <source_audio> [--label <text>]
  pharaoh post process <input_wav> [--start-ms <n>] [--end-ms <n>] [--gain-db <n>] [--fade-in-ms <n>] [--fade-out-ms <n>] [--fade-in-curve tri|qsin|qua] [--fade-out-curve tri|qsin|qua]
  pharaoh post normalize <input_wav> [--target-lufs -16]
  pharaoh post resample <input_wav> <output_wav>
  pharaoh post upscale <input_wav> [--model basic|speech] [--steps 50] [--guidance 3.5] [--seed 0]
  pharaoh setup status
  pharaoh generate row scene <project_id> <scene_slug> <row_index>
  pharaoh generate all scene <project_id> <scene_slug>"
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    let output = serde_json::to_string_pretty(value)?;
    println!("{output}");
    Ok(())
}

fn parse_flags(rest: &[String]) -> Result<HashMap<String, String>> {
    let mut flags = HashMap::new();
    let mut i = 0usize;
    while i < rest.len() {
        let key = rest[i].as_str();
        if !key.starts_with("--") {
            return Err(Error::Other(format!("expected flag, got {}", key)));
        }
        let name = key.trim_start_matches("--").replace('-', "_");
        i += 1;
        let value = rest
            .get(i)
            .cloned()
            .ok_or_else(|| Error::Other(format!("missing value for {}", key)))?;
        flags.insert(name, value);
        i += 1;
    }
    Ok(flags)
}

fn flag_string(flags: &HashMap<String, String>, key: &str, default: &str) -> String {
    flags.get(key).cloned().unwrap_or_else(|| default.into())
}

fn flag_opt(flags: &HashMap<String, String>, key: &str) -> Option<String> {
    flags.get(key).cloned().filter(|value| !value.is_empty())
}

fn flag_parse<T: std::str::FromStr>(
    flags: &HashMap<String, String>,
    key: &str,
    default: T,
) -> Result<T> {
    match flags.get(key) {
        Some(value) => value
            .parse::<T>()
            .map_err(|_| Error::Other(format!("invalid --{} value", key.replace('_', "-")))),
        None => Ok(default),
    }
}

fn update_project_timestamp(config: &crate::models::AppConfig, project_id: &str) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = project_dir(&projects_dir, project_id).join("project.json");
    let mut project: Project = read_json(&path)?;
    project.updated_at = Utc::now();
    write_json(&path, &project)
}

fn find_scene<'a>(storyboard: &'a Storyboard, scene_ref: &str) -> Option<&'a Scene> {
    storyboard
        .scenes
        .iter()
        .find(|scene| scene.slug == scene_ref || scene.id == scene_ref)
}

fn find_scene_mut<'a>(storyboard: &'a mut Storyboard, scene_ref: &str) -> Option<&'a mut Scene> {
    storyboard
        .scenes
        .iter_mut()
        .find(|scene| scene.slug == scene_ref || scene.id == scene_ref)
}

async fn project_list(config: &crate::models::AppConfig) -> Result<()> {
    let root = PathBuf::from(&config.projects_dir);
    let mut projects = vec![];
    if root.exists() {
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let project_json = entry.path().join("project.json");
            if project_json.exists() {
                if let Ok(project) = read_json::<Project>(&project_json) {
                    projects.push(project);
                }
            }
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    print_json(&projects)
}

async fn project_status(config: &crate::models::AppConfig, project_id: &str) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project_path = project_dir(&projects_dir, project_id).join("project.json");
    let storyboard_path = project_dir(&projects_dir, project_id).join("storyboard.json");

    let project: Project = read_json(&project_path)?;
    let storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };

    let mut total_rows = 0usize;
    let mut unresolved_rows = 0usize;
    let mut placed_rows = 0usize;
    for scene in &storyboard.scenes {
        let rows = read_script_rows(&script_path(&projects_dir, project_id, &scene.slug))?;
        total_rows += rows.len();
        unresolved_rows += rows
            .iter()
            .filter(|row| row.track_type != "DIRECTION" && row.file.trim().is_empty())
            .count();
        placed_rows += rows
            .iter()
            .filter(|row| !row.file.trim().is_empty() && !row.start_ms.trim().is_empty())
            .count();
    }

    print_json(&json!({
        "project": {
            "id": project.id,
            "title": project.title,
            "updated_at": project.updated_at,
        },
        "scenes": storyboard.scenes,
        "metrics": {
            "total_scenes": project_scene_count(&storyboard),
            "script_rows": total_rows,
            "unresolved_rows": unresolved_rows,
            "placed_rows": placed_rows,
        }
    }))
}

fn project_scene_count(storyboard: &Storyboard) -> usize {
    storyboard.scenes.len()
}

async fn project_create(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let mut title: Option<String> = None;
    let mut logline: Option<String> = None;
    let mut tone: Option<String> = None;

    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--title" => {
                i += 1;
                title = rest.get(i).cloned();
            }
            "--logline" => {
                i += 1;
                logline = rest.get(i).cloned();
            }
            "--tone" => {
                i += 1;
                tone = rest.get(i).cloned();
            }
            other => {
                return Err(Error::Other(format!("unknown flag: {}", other)));
            }
        }
        i += 1;
    }

    let title = title.ok_or_else(|| Error::Other("missing --title".into()))?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let project = Project {
        id: id.clone(),
        title,
        logline: logline.unwrap_or_default(),
        synopsis: String::new(),
        tone: tone.unwrap_or_default(),
        global_audio_notes: String::new(),
        target_duration_minutes: 30,
        created_at: now,
        updated_at: now,
        characters: vec![],
        llm_config: LlmConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            api_key_env: "ANTHROPIC_API_KEY".into(),
        },
    };

    let projects_dir = PathBuf::from(&config.projects_dir);
    let dir = project_dir(&projects_dir, &id);
    std::fs::create_dir_all(dir.join("scenes"))?;
    std::fs::create_dir_all(dir.join("output"))?;
    write_json(&dir.join("project.json"), &project)?;
    write_json(&dir.join("storyboard.json"), &Storyboard { scenes: vec![] })?;

    print_json(&project)
}

async fn project_update(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = project_dir(&projects_dir, project_id).join("project.json");
    let mut project: Project = read_json(&path)?;
    if let Some(value) = flag_opt(&flags, "title") {
        project.title = value;
    }
    if let Some(value) = flag_opt(&flags, "logline") {
        project.logline = value;
    }
    if let Some(value) = flag_opt(&flags, "synopsis") {
        project.synopsis = value;
    }
    if let Some(value) = flag_opt(&flags, "tone") {
        project.tone = value;
    }
    if let Some(value) = flag_opt(&flags, "global_audio_notes") {
        project.global_audio_notes = value;
    }
    if flags.contains_key("target_duration_minutes") {
        project.target_duration_minutes = flag_parse(
            &flags,
            "target_duration_minutes",
            project.target_duration_minutes,
        )?;
    }
    project.updated_at = Utc::now();
    write_json(&path, &project)?;
    print_json(&project)
}

async fn scene_list(config: &crate::models::AppConfig, project_id: &str) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = project_dir(&projects_dir, project_id).join("storyboard.json");
    let storyboard: Storyboard = if path.exists() {
        read_json(&path)?
    } else {
        Storyboard { scenes: vec![] }
    };
    print_json(&storyboard.scenes)
}

async fn scene_get(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_ref: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let storyboard: Storyboard =
        read_json(&project_dir(&projects_dir, project_id).join("storyboard.json"))?;
    let scene = find_scene(&storyboard, scene_ref)
        .ok_or_else(|| Error::Other(format!("scene {} not found", scene_ref)))?;
    print_json(scene)
}

async fn scene_create(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let title = flag_opt(&flags, "title").ok_or_else(|| Error::Other("missing --title".into()))?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project_root = project_dir(&projects_dir, project_id);
    let storyboard_path = project_root.join("storyboard.json");
    let mut storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };
    let index = flags
        .get("index")
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| Error::Other("invalid --index".into()))
        })
        .transpose()?
        .unwrap_or(storyboard.scenes.len() as u32);
    let slug = flag_opt(&flags, "slug").unwrap_or_else(|| {
        format!(
            "{:02}_{}",
            index,
            title
                .to_lowercase()
                .replace(' ', "_")
                .replace(|c: char| !c.is_alphanumeric() && c != '_', "")
        )
    });
    let scene = Scene {
        id: Uuid::new_v4().to_string(),
        index,
        slug: slug.clone(),
        title,
        description: flag_string(&flags, "description", ""),
        location: flag_string(&flags, "location", ""),
        characters: flag_opt(&flags, "characters")
            .map(|value| {
                value
                    .split(',')
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        notes: flag_string(&flags, "notes", ""),
        connects_from: flag_opt(&flags, "connects_from"),
        connects_to: flag_opt(&flags, "connects_to"),
        status: SceneStatus::Draft,
    };
    let scene_root = scene_dir(&projects_dir, project_id, &slug);
    std::fs::create_dir_all(scene_root.join("assets"))?;
    std::fs::create_dir_all(scene_root.join("render"))?;
    write_script_rows(&scene_root.join("script.csv"), &[])?;
    storyboard.scenes.push(scene.clone());
    storyboard.scenes.sort_by_key(|scene| scene.index);
    write_json(&storyboard_path, &storyboard)?;
    update_project_timestamp(config, project_id)?;
    print_json(&scene)
}

async fn scene_update(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_ref: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let storyboard_path = project_dir(&projects_dir, project_id).join("storyboard.json");
    let mut storyboard: Storyboard = read_json(&storyboard_path)?;
    let scene = find_scene_mut(&mut storyboard, scene_ref)
        .ok_or_else(|| Error::Other(format!("scene {} not found", scene_ref)))?;
    if let Some(value) = flag_opt(&flags, "title") {
        scene.title = value;
    }
    if let Some(value) = flag_opt(&flags, "description") {
        scene.description = value;
    }
    if let Some(value) = flag_opt(&flags, "location") {
        scene.location = value;
    }
    if let Some(value) = flag_opt(&flags, "notes") {
        scene.notes = value;
    }
    if let Some(value) = flag_opt(&flags, "characters") {
        scene.characters = value
            .split(',')
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect();
    }
    if let Some(value) = flag_opt(&flags, "status") {
        scene.status = match value.as_str() {
            "draft" => SceneStatus::Draft,
            "generating" => SceneStatus::Generating,
            "assets_ready" => SceneStatus::AssetsReady,
            "composed" => SceneStatus::Composed,
            "rendered" => SceneStatus::Rendered,
            _ => return Err(Error::Other("invalid --status".into())),
        };
    }
    let updated = scene.clone();
    storyboard.scenes.sort_by_key(|scene| scene.index);
    write_json(&storyboard_path, &storyboard)?;
    update_project_timestamp(config, project_id)?;
    print_json(&updated)
}

async fn compose_render_scene(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let output_path = render_scene_with_projects_dir(&projects_dir, project_id, scene_slug).await?;
    print_json(&json!({
        "project_id": project_id,
        "scene_slug": scene_slug,
        "output_path": output_path,
    }))
}

async fn script_read(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    print_json(&rows)
}

async fn script_write(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    input_path: &str,
) -> Result<()> {
    let data = std::fs::read_to_string(input_path)?;
    let rows: Vec<ScriptRow> = if input_path.ends_with(".json") {
        serde_json::from_str(&data)?
    } else {
        let mut reader = csv::Reader::from_reader(data.as_bytes());
        let mut rows = vec![];
        for row in reader.deserialize() {
            rows.push(row?);
        }
        rows
    };
    let projects_dir = PathBuf::from(&config.projects_dir);
    write_script_rows(&script_path(&projects_dir, project_id, scene_slug), &rows)?;
    print_json(&json!({ "project_id": project_id, "scene_slug": scene_slug, "rows": rows.len() }))
}

async fn script_update_row(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    rest: &[String],
) -> Result<()> {
    let fields = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let row = update_script_row_fields(
        &script_path(&projects_dir, project_id, scene_slug),
        row_index,
        fields,
    )?;
    print_json(&row)
}

async fn server_health(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let model = rest.first().map(String::as_str).unwrap_or("all");
    let http = reqwest::Client::new();
    let fetch = |kind: &str, url: String| {
        let http = http.clone();
        let kind = kind.to_string();
        async move {
            let result = http
                .get(format!("{}/health", url))
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await;
            match result {
                Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
                Err(_) => None,
            }
            .map(|health| json!({ "status": "online", "health": health }))
            .unwrap_or_else(|| json!({ "status": "offline", "health": null, "kind": kind }))
        }
    };
    let value = match model {
        "tts" => fetch("tts", config.tts_url.clone()).await,
        "sfx" => fetch("sfx", config.sfx_url.clone()).await,
        "music" => fetch("music", config.music_url.clone()).await,
        "post" | "audiosr" => fetch("post", config.post_url.clone()).await,
        "all" => json!({
            "tts": fetch("tts", config.tts_url.clone()).await,
            "sfx": fetch("sfx", config.sfx_url.clone()).await,
            "music": fetch("music", config.music_url.clone()).await,
            "post": fetch("post", config.post_url.clone()).await,
        }),
        other => return Err(Error::Other(format!("unknown server kind: {}", other))),
    };
    print_json(&value)
}

async fn server_config_get(config: &crate::models::AppConfig) -> Result<()> {
    print_json(&json!({
        "tts_url": config.tts_url,
        "sfx_url": config.sfx_url,
        "music_url": config.music_url,
        "post_url": config.post_url,
        "projects_dir": config.projects_dir,
        "models_dir": config.models_dir,
        "woosh_dir": config.woosh_dir,
    }))
}

async fn server_config_set(
    config_path: &Path,
    mut config: crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    if let Some(value) = flag_opt(&flags, "tts_url") {
        config.tts_url = value;
    }
    if let Some(value) = flag_opt(&flags, "sfx_url") {
        config.sfx_url = value;
    }
    if let Some(value) = flag_opt(&flags, "music_url") {
        config.music_url = value;
    }
    if let Some(value) = flag_opt(&flags, "post_url") {
        config.post_url = value;
    }
    if let Some(value) = flag_opt(&flags, "projects_dir") {
        config.projects_dir = value;
    }
    if let Some(value) = flag_opt(&flags, "models_dir") {
        config.models_dir = value;
    }
    if let Some(value) = flag_opt(&flags, "woosh_dir") {
        config.woosh_dir = value;
    }
    write_json(config_path, &config)?;
    print_json(&config)
}

async fn model_load(config: &crate::models::AppConfig, model: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let url = server_base_url(config, model)?;
    let http = reqwest::Client::new();
    let mut req = http.post(format!("{}/load", url));
    if let Some(variant) = flag_opt(&flags, "variant") {
        req = req.json(&json!({ "variant": variant }));
    }
    let body: serde_json::Value = req
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| Error::Other(format!("load request failed: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("load response parse error: {}", e)))?;
    print_json(&body)
}

async fn model_unload(config: &crate::models::AppConfig, model: &str) -> Result<()> {
    let url = server_base_url(config, model)?;
    let body: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/unload", url))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("unload request failed: {}", e)))?
        .json()
        .await
        .unwrap_or_else(|_| json!({ "status": "ok" }));
    print_json(&body)
}

fn server_base_url(config: &crate::models::AppConfig, model: &str) -> Result<String> {
    match model {
        "tts" => Ok(config.tts_url.clone()),
        "sfx" => Ok(config.sfx_url.clone()),
        "music" => Ok(config.music_url.clone()),
        "post" | "audiosr" => Ok(config.post_url.clone()),
        other => Err(Error::Other(format!("unknown server kind: {}", other))),
    }
}

async fn character_list(config: &crate::models::AppConfig, project_id: &str) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project: Project = read_json(&project_dir(&projects_dir, project_id).join("project.json"))?;
    print_json(&project.characters)
}

async fn character_create(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let name = flag_opt(&flags, "name").ok_or_else(|| Error::Other("missing --name".into()))?;
    let id = flag_opt(&flags, "id").unwrap_or_else(|| {
        let short = Uuid::new_v4().simple().to_string();
        format!("CHAR_{}", short[..6].to_ascii_uppercase())
    });
    let mut project = load_project(config, project_id)?;
    let character = Character {
        id: id.clone(),
        name,
        description: flag_string(&flags, "description", ""),
        voice_assignment: VoiceAssignment {
            model: flag_string(&flags, "voice_model", "VoiceDesign"),
            speaker: flag_opt(&flags, "speaker"),
            instruct_default: flag_opt(&flags, "instruct"),
            ref_audio_path: flag_opt(&flags, "ref_audio_path"),
            ref_transcript: flag_opt(&flags, "ref_transcript"),
        },
    };
    project.characters.push(character.clone());
    save_project(config, project)?;
    print_json(&character)
}

async fn character_update(
    config: &crate::models::AppConfig,
    project_id: &str,
    character_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let mut project = load_project(config, project_id)?;
    let character = project
        .characters
        .iter_mut()
        .find(|character| character.id == character_id)
        .ok_or_else(|| Error::Other(format!("character {} not found", character_id)))?;
    if let Some(value) = flag_opt(&flags, "name") {
        character.name = value;
    }
    if let Some(value) = flag_opt(&flags, "description") {
        character.description = value;
    }
    let updated = character.clone();
    save_project(config, project)?;
    print_json(&updated)
}

async fn character_delete(
    config: &crate::models::AppConfig,
    project_id: &str,
    character_id: &str,
) -> Result<()> {
    let mut project = load_project(config, project_id)?;
    let before = project.characters.len();
    project
        .characters
        .retain(|character| character.id != character_id);
    if project.characters.len() == before {
        return Err(Error::Other(format!(
            "character {} not found",
            character_id
        )));
    }
    save_project(config, project)?;
    print_json(&json!({ "deleted": character_id }))
}

async fn character_voice_set(
    config: &crate::models::AppConfig,
    project_id: &str,
    character_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let mut project = load_project(config, project_id)?;
    let character = project
        .characters
        .iter_mut()
        .find(|character| character.id == character_id)
        .ok_or_else(|| Error::Other(format!("character {} not found", character_id)))?;
    if let Some(value) = flag_opt(&flags, "model") {
        character.voice_assignment.model = value;
    }
    if flags.contains_key("speaker") {
        character.voice_assignment.speaker = flag_opt(&flags, "speaker");
    }
    if flags.contains_key("instruct") {
        character.voice_assignment.instruct_default = flag_opt(&flags, "instruct");
    }
    if flags.contains_key("ref_audio_path") {
        character.voice_assignment.ref_audio_path = flag_opt(&flags, "ref_audio_path");
    }
    if flags.contains_key("ref_transcript") {
        character.voice_assignment.ref_transcript = flag_opt(&flags, "ref_transcript");
    }
    let updated = character.clone();
    save_project(config, project)?;
    print_json(&updated)
}

fn load_project(config: &crate::models::AppConfig, project_id: &str) -> Result<Project> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    read_json(&project_dir(&projects_dir, project_id).join("project.json"))
}

fn save_project(config: &crate::models::AppConfig, mut project: Project) -> Result<()> {
    project.updated_at = Utc::now();
    let projects_dir = PathBuf::from(&config.projects_dir);
    write_json(
        &project_dir(&projects_dir, &project.id).join("project.json"),
        &project,
    )
}

async fn character_voice_design_test(
    config: &crate::models::AppConfig,
    project_id: &str,
    character_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let project = load_project(config, project_id)?;
    let character = project
        .characters
        .iter()
        .find(|character| character.id == character_id)
        .ok_or_else(|| Error::Other(format!("character {} not found", character_id)))?;
    let text = flag_string(&flags, "text", "And then she said - nothing at all.");
    let voice_description = flag_opt(&flags, "voice_description")
        .or_else(|| character.voice_assignment.instruct_default.clone())
        .ok_or_else(|| Error::Other("missing --voice-description".into()))?;
    let output_path = character_output_path(config, project_id, character_id, "design");
    let params = TtsVoiceDesignRequest {
        text,
        voice_description,
        language: flag_string(&flags, "language", "en"),
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 2048)?,
        output_path,
    };
    submit_tts_design_and_finalize(config, params).await
}

async fn character_voice_clone_test(
    config: &crate::models::AppConfig,
    project_id: &str,
    character_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let project = load_project(config, project_id)?;
    let character = project
        .characters
        .iter()
        .find(|character| character.id == character_id)
        .ok_or_else(|| Error::Other(format!("character {} not found", character_id)))?;
    let ref_audio_path = flag_opt(&flags, "ref_audio_path")
        .or_else(|| character.voice_assignment.ref_audio_path.clone())
        .ok_or_else(|| Error::Other("missing --ref-audio-path".into()))?;
    let output_path = character_output_path(config, project_id, character_id, "clone");
    let params = TtsVoiceCloneRequest {
        text: flag_string(&flags, "text", "And then she said - nothing at all."),
        ref_audio_path,
        ref_transcript: flag_opt(&flags, "ref_transcript")
            .or_else(|| character.voice_assignment.ref_transcript.clone())
            .unwrap_or_default(),
        language: flag_string(&flags, "language", "en"),
        icl_mode: flag_parse(&flags, "icl_mode", false)?,
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 1024)?,
        output_path,
    };
    submit_tts_clone_and_finalize(config, params).await
}

fn character_output_path(
    config: &crate::models::AppConfig,
    project_id: &str,
    character_id: &str,
    suffix: &str,
) -> String {
    PathBuf::from(&config.projects_dir)
        .join(project_id)
        .join("characters")
        .join(character_id)
        .join(format!("{}_{}.wav", suffix, Utc::now().timestamp_millis()))
        .to_string_lossy()
        .to_string()
}

async fn generate_tts_custom(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    let params = TtsCustomVoiceRequest {
        text: flag_opt(&flags, "text").ok_or_else(|| Error::Other("missing --text".into()))?,
        speaker: flag_string(&flags, "speaker", "Vivian"),
        language: flag_string(&flags, "language", "en"),
        instruct: flag_string(&flags, "instruct", ""),
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 2048)?,
        output_path,
    };
    submit_tts_custom_and_finalize(config, params).await
}

async fn generate_tts_design(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    let params = TtsVoiceDesignRequest {
        text: flag_opt(&flags, "text").ok_or_else(|| Error::Other("missing --text".into()))?,
        voice_description: flag_opt(&flags, "voice_description")
            .ok_or_else(|| Error::Other("missing --voice-description".into()))?,
        language: flag_string(&flags, "language", "en"),
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 2048)?,
        output_path,
    };
    submit_tts_design_and_finalize(config, params).await
}

async fn generate_tts_clone(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    let params = TtsVoiceCloneRequest {
        text: flag_opt(&flags, "text").ok_or_else(|| Error::Other("missing --text".into()))?,
        ref_audio_path: flag_opt(&flags, "ref_audio_path")
            .ok_or_else(|| Error::Other("missing --ref-audio-path".into()))?,
        ref_transcript: flag_string(&flags, "ref_transcript", ""),
        language: flag_string(&flags, "language", "en"),
        icl_mode: flag_parse(&flags, "icl_mode", false)?,
        seed: flag_parse(&flags, "seed", random_seed())?,
        temperature: flag_parse(&flags, "temperature", 0.7)?,
        top_p: flag_parse(&flags, "top_p", 0.9)?,
        max_new_tokens: flag_parse(&flags, "max_new_tokens", 1024)?,
        output_path,
    };
    submit_tts_clone_and_finalize(config, params).await
}

async fn submit_tts_custom_and_finalize(
    config: &crate::models::AppConfig,
    params: TtsCustomVoiceRequest,
) -> Result<()> {
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/custom_voice", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status.output_path.unwrap_or(params.output_path.clone());
    write_sidecar(
        output_path.clone(),
        SidecarMeta {
            model: "qwen3-tts-customvoice".into(),
            model_variant: Some("1.7B".into()),
            prompt: params.text,
            instruct: (!params.instruct.is_empty()).then_some(params.instruct),
            speaker: Some(params.speaker),
            language: Some(params.language),
            seed: params.seed,
            temperature: Some(params.temperature),
            top_p: Some(params.top_p),
            duration_target_ms: None,
            duration_actual_ms: None,
            sample_rate: 24000,
            generated_at: Utc::now(),
            parent: None,
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": output_path }))
}

async fn submit_tts_design_and_finalize(
    config: &crate::models::AppConfig,
    params: TtsVoiceDesignRequest,
) -> Result<()> {
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/voice_design", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status.output_path.unwrap_or(params.output_path.clone());
    write_sidecar(
        output_path.clone(),
        SidecarMeta {
            model: "qwen3-tts-voicedesign".into(),
            model_variant: Some("1.7B".into()),
            prompt: params.text,
            instruct: Some(params.voice_description),
            speaker: None,
            language: Some(params.language),
            seed: params.seed,
            temperature: Some(params.temperature),
            top_p: Some(params.top_p),
            duration_target_ms: None,
            duration_actual_ms: None,
            sample_rate: 24000,
            generated_at: Utc::now(),
            parent: None,
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": output_path }))
}

async fn submit_tts_clone_and_finalize(
    config: &crate::models::AppConfig,
    params: TtsVoiceCloneRequest,
) -> Result<()> {
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/voice_clone", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status.output_path.unwrap_or(params.output_path.clone());
    write_sidecar(
        output_path.clone(),
        SidecarMeta {
            model: "qwen3-tts-clone".into(),
            model_variant: Some("1.7B".into()),
            prompt: params.text,
            instruct: None,
            speaker: None,
            language: Some(params.language),
            seed: params.seed,
            temperature: Some(params.temperature),
            top_p: Some(params.top_p),
            duration_target_ms: None,
            duration_actual_ms: None,
            sample_rate: 24000,
            generated_at: Utc::now(),
            parent: Some(params.ref_audio_path),
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": output_path }))
}

#[derive(Serialize)]
struct CliPostUpscaleRequest {
    input_path: String,
    output_path: String,
    model_name: String,
    ddim_steps: u32,
    guidance_scale: f32,
    seed: i64,
}

async fn post_upscale(
    config: &crate::models::AppConfig,
    input_path: &str,
    rest: &[String],
) -> Result<()> {
    let mut model = "basic".to_string();
    let mut steps = 50u32;
    let mut guidance = 3.5f32;
    let mut seed = 0i64;

    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--model" => {
                i += 1;
                model = rest
                    .get(i)
                    .cloned()
                    .ok_or_else(|| Error::Other("missing --model value".into()))?;
            }
            "--steps" => {
                i += 1;
                steps = rest
                    .get(i)
                    .ok_or_else(|| Error::Other("missing --steps value".into()))?
                    .parse()
                    .map_err(|_| Error::Other("invalid --steps value".into()))?;
            }
            "--guidance" => {
                i += 1;
                guidance = rest
                    .get(i)
                    .ok_or_else(|| Error::Other("missing --guidance value".into()))?
                    .parse()
                    .map_err(|_| Error::Other("invalid --guidance value".into()))?;
            }
            "--seed" => {
                i += 1;
                seed = rest
                    .get(i)
                    .ok_or_else(|| Error::Other("missing --seed value".into()))?
                    .parse()
                    .map_err(|_| Error::Other("invalid --seed value".into()))?;
            }
            other => return Err(Error::Other(format!("unknown flag: {}", other))),
        }
        i += 1;
    }

    if model != "basic" && model != "speech" {
        return Err(Error::Other("--model must be basic or speech".into()));
    }

    let output_path = output_path_for(Path::new(input_path), &model)?
        .to_string_lossy()
        .to_string();
    let params = CliPostUpscaleRequest {
        input_path: input_path.to_string(),
        output_path: output_path.clone(),
        model_name: model.clone(),
        ddim_steps: steps,
        guidance_scale: guidance,
        seed,
    };
    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/upscale", config.post_url),
        &params,
        "Post",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.post_url), &job_id, "Post").await?;
    let final_output = status.output_path.unwrap_or(output_path);
    let duration_ms =
        write_upscale_sidecar(input_path.to_string(), final_output.clone(), model, seed)?;
    print_json(&json!({
        "input_path": input_path,
        "output_path": final_output,
        "duration_ms": duration_ms,
    }))
}

async fn generate_row(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project: Project = read_json(&project_dir(&projects_dir, project_id).join("project.json"))?;
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    let row = rows
        .get(row_index)
        .cloned()
        .ok_or_else(|| Error::Other(format!("row {} out of range", row_index)))?;
    let result = generate_script_row(
        config,
        &projects_dir,
        &project,
        project_id,
        scene_slug,
        row_index,
        row,
    )
    .await?;
    print_json(&result)
}

async fn generate_all(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project: Project = read_json(&project_dir(&projects_dir, project_id).join("project.json"))?;
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    let mut outputs = vec![];

    for (row_index, row) in rows.into_iter().enumerate() {
        if row.track_type == "DIRECTION" || !row.file.trim().is_empty() {
            continue;
        }
        outputs.push(
            generate_script_row(
                config,
                &projects_dir,
                &project,
                project_id,
                scene_slug,
                row_index,
                row,
            )
            .await?,
        );
    }

    print_json(&outputs)
}

#[derive(Serialize)]
struct GeneratedRowResult {
    project_id: String,
    scene_slug: String,
    row_index: usize,
    model: String,
    output_path: String,
    duration_ms: Option<u64>,
    bound_to_script: bool,
}

async fn generate_script_row(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project: &Project,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
) -> Result<GeneratedRowResult> {
    let http = reqwest::Client::new();
    match row.track_type.as_str() {
        "DIALOGUE" => {
            generate_dialogue(
                config,
                projects_dir,
                project,
                project_id,
                scene_slug,
                row_index,
                row,
                http,
            )
            .await
        }
        "SFX" | "BED" => {
            generate_sfx(
                config,
                projects_dir,
                project_id,
                scene_slug,
                row_index,
                row,
                http,
            )
            .await
        }
        "MUSIC" => {
            generate_music(
                config,
                projects_dir,
                project_id,
                scene_slug,
                row_index,
                row,
                http,
            )
            .await
        }
        other => Err(Error::Other(format!("cannot generate row type {}", other))),
    }
}

async fn generate_dialogue(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project: &Project,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    let character = project
        .characters
        .iter()
        .find(|character| character.name.eq_ignore_ascii_case(&row.character));

    let stem = sanitized_stem(
        character
            .map(|character| character.id.as_str())
            .or_else(|| (!row.character.is_empty()).then_some(row.character.as_str()))
            .unwrap_or("dialogue"),
    );
    let output_path = asset_output_path(
        projects_dir,
        project_id,
        scene_slug,
        &format!("{stem}_{}", Utc::now().timestamp_millis()),
    );

    let speaker = character
        .and_then(|character| character.voice_assignment.speaker.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Vivian".into());
    let instruct = (!row.instruct.trim().is_empty())
        .then_some(row.instruct.clone())
        .or_else(|| {
            character.and_then(|character| character.voice_assignment.instruct_default.clone())
        })
        .unwrap_or_default();
    let params = TtsCustomVoiceRequest {
        text: row.prompt.clone(),
        speaker: speaker.clone(),
        language: "en".into(),
        instruct: instruct.clone(),
        seed: random_seed(),
        temperature: 0.7,
        top_p: 0.9,
        max_new_tokens: 2048,
        output_path: output_path.clone(),
    };
    let job_id = submit_job(
        &http,
        format!("{}/generate/custom_voice", config.tts_url),
        &params,
        "TTS",
    )
    .await?;
    let meta = SidecarMeta {
        model: "qwen3-tts-customvoice".into(),
        model_variant: Some("1.7B".into()),
        prompt: params.text.clone(),
        instruct: if params.instruct.is_empty() {
            None
        } else {
            Some(params.instruct.clone())
        },
        speaker: Some(params.speaker.clone()),
        language: Some(params.language.clone()),
        seed: params.seed,
        temperature: Some(params.temperature),
        top_p: Some(params.top_p),
        duration_target_ms: None,
        duration_actual_ms: None,
        sample_rate: 24000,
        generated_at: Utc::now(),
        parent: None,
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };

    let status = poll_job(&http, format!("{}/jobs", config.tts_url), &job_id, "TTS").await?;
    let output_path = status
        .output_path
        .ok_or_else(|| Error::Other("TTS job completed without output_path".into()))?;
    let finalized = finalize_generation_output(
        projects_dir,
        project_id,
        scene_slug,
        row_index,
        &output_path,
        meta,
    )?;

    Ok(GeneratedRowResult {
        project_id: project_id.into(),
        scene_slug: scene_slug.into(),
        row_index,
        model: "tts".into(),
        output_path: finalized.output_path,
        duration_ms: finalized.duration_ms,
        bound_to_script: finalized.bound_to_script,
    })
}

async fn generate_sfx(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    let stem = sanitized_stem(&row.track.to_lowercase());
    let output_path = asset_output_path(
        projects_dir,
        project_id,
        scene_slug,
        &format!("{stem}_{}", Utc::now().timestamp_millis()),
    );
    let duration_seconds = row
        .duration_ms
        .parse::<f32>()
        .ok()
        .map(|ms| (ms / 1000.0).max(0.5))
        .unwrap_or(3.0);
    let use_audioldm = row.track_type == "BED" || duration_seconds > 5.0;

    let params = SfxT2ARequest {
        prompt: row.prompt.clone(),
        duration_seconds,
        model_variant: if use_audioldm {
            "AudioLDM-M-Full".into()
        } else {
            "Woosh-DFlow".into()
        },
        backend: Some(if use_audioldm { "audioldm" } else { "woosh" }.into()),
        steps: if use_audioldm { 200 } else { 4 },
        seed: random_seed(),
        cfg_scale: (!use_audioldm).then_some(4.5),
        guidance_scale: use_audioldm.then_some(2.5),
        negative_prompt: use_audioldm.then_some(
            "speech, talking, music, melody, low quality, distorted, clipped, noisy artifacts"
                .into(),
        ),
        num_waveforms_per_prompt: use_audioldm.then_some(1),
        output_path: output_path.clone(),
    };

    let job_id = submit_job(
        &http,
        format!("{}/generate/t2a", config.sfx_url),
        &params,
        "SFX",
    )
    .await?;

    let status = poll_job(&http, format!("{}/jobs", config.sfx_url), &job_id, "SFX").await?;
    let output_path = status
        .output_path
        .ok_or_else(|| Error::Other("SFX job completed without output_path".into()))?;
    let finalized = finalize_generation_output(
        projects_dir,
        project_id,
        scene_slug,
        row_index,
        &output_path,
        SidecarMeta {
            model: format!("woosh-{}", params.model_variant.to_lowercase()),
            model_variant: Some(params.model_variant.clone()),
            prompt: params.prompt.clone(),
            instruct: None,
            speaker: None,
            language: None,
            seed: params.seed,
            temperature: None,
            top_p: None,
            duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
            duration_actual_ms: None,
            sample_rate: 48000,
            generated_at: Utc::now(),
            parent: None,
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;

    Ok(GeneratedRowResult {
        project_id: project_id.into(),
        scene_slug: scene_slug.into(),
        row_index,
        model: "sfx".into(),
        output_path: finalized.output_path,
        duration_ms: finalized.duration_ms,
        bound_to_script: finalized.bound_to_script,
    })
}

async fn generate_music(
    config: &crate::models::AppConfig,
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    row: ScriptRow,
    http: reqwest::Client,
) -> Result<GeneratedRowResult> {
    let output_path = asset_output_path(
        projects_dir,
        project_id,
        scene_slug,
        &format!("music_{}", Utc::now().timestamp_millis()),
    );
    let duration_seconds = row
        .duration_ms
        .parse::<f32>()
        .ok()
        .map(|ms| (ms / 1000.0).max(1.0))
        .unwrap_or(30.0);
    let params = MusicText2MusicRequest {
        caption: row.prompt.clone(),
        lyrics: String::new(),
        duration_seconds,
        bpm: None,
        key: String::new(),
        language: "en".into(),
        lm_model_size: "1.7B".into(),
        diffusion_steps: 60,
        thinking_mode: false,
        reference_audio_path: String::new(),
        seed: random_seed(),
        batch_size: 1,
        output_path: output_path.clone(),
    };

    let job_id = submit_job(
        &http,
        format!("{}/generate/text2music", config.music_url),
        &params,
        "Music",
    )
    .await?;

    let status = poll_job(
        &http,
        format!("{}/jobs", config.music_url),
        &job_id,
        "Music",
    )
    .await?;
    let output_path = status
        .output_path
        .ok_or_else(|| Error::Other("Music job completed without output_path".into()))?;
    let finalized = finalize_generation_output(
        projects_dir,
        project_id,
        scene_slug,
        row_index,
        &output_path,
        SidecarMeta {
            model: "ace-step-1.5".into(),
            model_variant: Some(params.lm_model_size.clone()),
            prompt: params.caption.clone(),
            instruct: None,
            speaker: None,
            language: Some(params.language.clone()),
            seed: params.seed,
            temperature: None,
            top_p: None,
            duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
            duration_actual_ms: None,
            sample_rate: 44100,
            generated_at: Utc::now(),
            parent: None,
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;

    Ok(GeneratedRowResult {
        project_id: project_id.into(),
        scene_slug: scene_slug.into(),
        row_index,
        model: "music".into(),
        output_path: finalized.output_path,
        duration_ms: finalized.duration_ms,
        bound_to_script: finalized.bound_to_script,
    })
}

fn cli_audio_path_from_meta(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let audio_name = name.strip_suffix(".meta.json")?;
    Some(path.with_file_name(audio_name))
}

fn cli_kind_from_model(model: &str) -> &'static str {
    let model = model.to_lowercase();
    if model.contains("qwen") || model.contains("tts") {
        "tts"
    } else if model.contains("ace") || model.contains("music") {
        "music"
    } else {
        "sfx"
    }
}

fn cli_wav_info(path: &str) -> (Option<u64>, u32) {
    let Ok(reader) = hound::WavReader::open(path) else {
        return (None, 48000);
    };
    let spec = reader.spec();
    let samples = reader.duration() as u64;
    let channels = u64::from(spec.channels.max(1));
    let duration_ms = samples
        .checked_mul(1000)
        .and_then(|v| v.checked_div(channels))
        .and_then(|v| v.checked_div(u64::from(spec.sample_rate)));
    (duration_ms, spec.sample_rate)
}

fn collect_cli_assets(
    root: &Path,
    scene_slug: &str,
    out: &mut Vec<GeneratedAudioAsset>,
) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_cli_assets(&path, scene_slug, out)?;
            continue;
        }

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if !name.ends_with(".wav.meta.json") {
            continue;
        }

        let data = std::fs::read_to_string(&path)?;
        let meta: SidecarMeta = serde_json::from_str(&data)?;
        let Some(audio_path) = cli_audio_path_from_meta(&path) else {
            continue;
        };
        if !audio_path.exists() {
            continue;
        }

        let kind_model = if meta.model == "audiosr" || meta.model == "clip-studio" {
            meta.parent
                .as_ref()
                .and_then(|parent| read_sidecar(parent.clone()).ok().flatten())
                .map(|parent_meta| parent_meta.model)
                .unwrap_or_else(|| meta.model.clone())
        } else {
            meta.model.clone()
        };

        out.push(GeneratedAudioAsset {
            audio_path: audio_path.to_string_lossy().into_owned(),
            meta_path: path.to_string_lossy().into_owned(),
            scene_slug: scene_slug.to_string(),
            kind: cli_kind_from_model(&kind_model).to_string(),
            name: audio_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            duration_ms: meta.duration_actual_ms,
            sample_rate: meta.sample_rate,
            model: meta.model,
            model_variant: meta.model_variant,
            prompt: meta.prompt,
            generated_at: meta.generated_at,
            parent: meta.parent,
            qa_status: meta.qa_status,
        });
    }

    Ok(())
}

async fn asset_list(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let kind_filter = flag_opt(&flags, "kind");
    let scene_filter = flag_opt(&flags, "scene");
    let scenes_root = PathBuf::from(&config.projects_dir)
        .join(project_id)
        .join("scenes");
    let mut assets = Vec::new();

    if scenes_root.exists() {
        for entry in std::fs::read_dir(&scenes_root)? {
            let entry = entry?;
            let scene_path = entry.path();
            if !scene_path.is_dir() {
                continue;
            }
            let scene_slug = scene_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if scene_filter
                .as_deref()
                .is_some_and(|wanted| wanted != scene_slug)
            {
                continue;
            }
            collect_cli_assets(&scene_path.join("assets"), &scene_slug, &mut assets)?;
        }
    }

    if let Some(kind) = kind_filter {
        assets.retain(|asset| asset.kind == kind);
    }
    assets.sort_by(|a, b| b.generated_at.cmp(&a.generated_at));
    print_json(&assets)
}

async fn asset_meta(audio_path: &str) -> Result<()> {
    let meta = read_sidecar(audio_path.to_string())?
        .ok_or_else(|| Error::Other(format!("no sidecar for {}", audio_path)))?;
    print_json(&meta)
}

async fn asset_qa(audio_path: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let status =
        flag_opt(&flags, "status").ok_or_else(|| Error::Other("missing --status".into()))?;
    let notes = flag_string(&flags, "notes", "");
    update_sidecar_qa(audio_path.to_string(), status, notes)?;
    asset_meta(audio_path).await
}

async fn asset_takes(audio_path: &str) -> Result<()> {
    let base = PathBuf::from(audio_path);
    let stem = base
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = base
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dir = base
        .parent()
        .ok_or_else(|| Error::Other("asset path has no parent directory".into()))?;
    let mut takes: Vec<SidecarMeta> = std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with(&stem) && name.ends_with(&format!(".{}.meta.json", ext))
        })
        .filter_map(|entry| {
            std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|data| serde_json::from_str::<SidecarMeta>(&data).ok())
        })
        .collect();
    takes.sort_by_key(|take| take.take_index);
    print_json(&takes)
}

async fn asset_use(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    audio_path: &str,
) -> Result<()> {
    if !Path::new(audio_path).exists() {
        return Err(Error::Other(format!(
            "asset does not exist: {}",
            audio_path
        )));
    }
    let meta = read_sidecar(audio_path.to_string()).ok().flatten();
    let mut fields = HashMap::from([("file".to_string(), audio_path.to_string())]);
    if let Some(duration_ms) = meta.and_then(|meta| meta.duration_actual_ms) {
        fields.insert("duration_ms".into(), duration_ms.to_string());
    }
    let projects_dir = PathBuf::from(&config.projects_dir);
    let row = update_script_row_fields(
        &script_path(&projects_dir, project_id, scene_slug),
        row_index,
        fields,
    )?;
    print_json(&row)
}

async fn generate_direct_sfx(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let prompt =
        flag_opt(&flags, "prompt").ok_or_else(|| Error::Other("missing --prompt".into()))?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    if let Some(parent) = Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)?;
    }

    let backend = flag_opt(&flags, "backend");
    let model_variant = flag_opt(&flags, "model_variant").unwrap_or_else(|| {
        if backend.as_deref() == Some("audioldm") {
            "AudioLDM-M-Full".into()
        } else {
            "Woosh-DFlow".into()
        }
    });
    let is_audioldm =
        backend.as_deref() == Some("audioldm") || model_variant.to_lowercase().contains("audioldm");
    let params = SfxT2ARequest {
        prompt,
        duration_seconds: flag_parse(
            &flags,
            "duration_seconds",
            if is_audioldm { 10.0 } else { 3.0 },
        )?,
        model_variant: model_variant.clone(),
        backend: backend.or_else(|| Some(if is_audioldm { "audioldm" } else { "woosh" }.into())),
        steps: flag_parse(&flags, "steps", if is_audioldm { 200 } else { 4 })?,
        seed: flag_parse(&flags, "seed", random_seed())?,
        cfg_scale: if is_audioldm {
            flag_opt(&flags, "cfg_scale")
                .map(|_| flag_parse(&flags, "cfg_scale", 4.5))
                .transpose()?
        } else {
            Some(flag_parse(&flags, "cfg_scale", 4.5)?)
        },
        guidance_scale: if is_audioldm {
            Some(flag_parse(&flags, "guidance_scale", 2.5)?)
        } else {
            flag_opt(&flags, "guidance_scale")
                .map(|_| flag_parse(&flags, "guidance_scale", 2.5))
                .transpose()?
        },
        negative_prompt: flag_opt(&flags, "negative_prompt").or_else(|| {
            is_audioldm.then_some(
                "speech, talking, music, melody, low quality, distorted, clipped, noisy artifacts"
                    .into(),
            )
        }),
        num_waveforms_per_prompt: if is_audioldm {
            Some(flag_parse(&flags, "num_waveforms_per_prompt", 1)?)
        } else {
            flag_opt(&flags, "num_waveforms_per_prompt")
                .map(|_| flag_parse(&flags, "num_waveforms_per_prompt", 1))
                .transpose()?
        },
        output_path: output_path.clone(),
    };

    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/t2a", config.sfx_url),
        &params,
        "SFX",
    )
    .await?;
    let status = poll_job(&http, format!("{}/jobs", config.sfx_url), &job_id, "SFX").await?;
    let final_output = status.output_path.unwrap_or(output_path);
    let (duration_actual_ms, sample_rate) = cli_wav_info(&final_output);
    write_sidecar(
        final_output.clone(),
        SidecarMeta {
            model: format!(
                "{}-{}",
                if is_audioldm { "audioldm" } else { "woosh" },
                params.model_variant.to_lowercase()
            ),
            model_variant: Some(params.model_variant.clone()),
            prompt: params.prompt.clone(),
            instruct: params
                .negative_prompt
                .clone()
                .map(|p| format!("negative={}", p)),
            speaker: None,
            language: None,
            seed: params.seed,
            temperature: None,
            top_p: None,
            duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
            duration_actual_ms,
            sample_rate,
            generated_at: Utc::now(),
            parent: None,
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": final_output }))
}

async fn generate_direct_music(config: &crate::models::AppConfig, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = flag_opt(&flags, "output_path")
        .ok_or_else(|| Error::Other("missing --output-path".into()))?;
    if let Some(parent) = Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let params = MusicText2MusicRequest {
        caption: flag_opt(&flags, "caption")
            .ok_or_else(|| Error::Other("missing --caption".into()))?,
        lyrics: flag_string(&flags, "lyrics", ""),
        duration_seconds: flag_parse(&flags, "duration_seconds", 30.0)?,
        bpm: flag_opt(&flags, "bpm")
            .map(|_| flag_parse(&flags, "bpm", 0))
            .transpose()?
            .filter(|bpm| *bpm > 0),
        key: flag_string(&flags, "key", ""),
        language: flag_string(&flags, "language", "en"),
        lm_model_size: flag_string(&flags, "lm_model_size", "1.7B"),
        diffusion_steps: flag_parse(&flags, "diffusion_steps", 60)?,
        thinking_mode: flag_parse(&flags, "thinking_mode", false)?,
        reference_audio_path: flag_string(&flags, "reference_audio_path", ""),
        seed: flag_parse(&flags, "seed", random_seed())?,
        batch_size: flag_parse(&flags, "batch_size", 1)?,
        output_path: output_path.clone(),
    };

    let http = reqwest::Client::new();
    let job_id = submit_job(
        &http,
        format!("{}/generate/text2music", config.music_url),
        &params,
        "Music",
    )
    .await?;
    let status = poll_job(
        &http,
        format!("{}/jobs", config.music_url),
        &job_id,
        "Music",
    )
    .await?;
    let final_output = status.output_path.unwrap_or(output_path);
    let (duration_actual_ms, sample_rate) = cli_wav_info(&final_output);
    write_sidecar(
        final_output.clone(),
        SidecarMeta {
            model: "ace-step-1.5".into(),
            model_variant: Some(params.lm_model_size.clone()),
            prompt: params.caption.clone(),
            instruct: (!params.lyrics.is_empty()).then_some(params.lyrics.clone()),
            speaker: None,
            language: Some(params.language.clone()),
            seed: params.seed,
            temperature: None,
            top_p: None,
            duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
            duration_actual_ms,
            sample_rate,
            generated_at: Utc::now(),
            parent: (!params.reference_audio_path.is_empty())
                .then_some(params.reference_audio_path.clone()),
            take_index: 1,
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )?;
    print_json(&json!({ "job_id": job_id, "output_path": final_output }))
}

async fn post_import(
    config: &crate::models::AppConfig,
    project_id: &str,
    source_path: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let output_path = import_audio_asset_with_projects_dir(
        &projects_dir,
        ImportAudioRequest {
            project_id: project_id.to_string(),
            source_path: source_path.to_string(),
            label: flag_opt(&flags, "label"),
        },
    )?;
    print_json(&json!({ "project_id": project_id, "output_path": output_path }))
}

async fn post_process(input_path: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let output_path = process_clip_asset(ClipProcessRequest {
        input_path: input_path.to_string(),
        start_ms: flag_parse(&flags, "start_ms", 0)?,
        end_ms: flag_opt(&flags, "end_ms")
            .map(|_| flag_parse(&flags, "end_ms", 0))
            .transpose()?,
        gain_db: flag_parse(&flags, "gain_db", 0.0)?,
        fade_in_ms: flag_parse(&flags, "fade_in_ms", 0)?,
        fade_out_ms: flag_parse(&flags, "fade_out_ms", 0)?,
        fade_in_curve: flag_opt(&flags, "fade_in_curve"),
        fade_out_curve: flag_opt(&flags, "fade_out_curve"),
        normalize_lufs: flag_opt(&flags, "normalize_lufs")
            .map(|_| flag_parse(&flags, "normalize_lufs", -16.0))
            .transpose()?,
        highpass_hz: flag_opt(&flags, "highpass_hz")
            .map(|_| flag_parse(&flags, "highpass_hz", 0))
            .transpose()?,
        lowpass_hz: flag_opt(&flags, "lowpass_hz")
            .map(|_| flag_parse(&flags, "lowpass_hz", 0))
            .transpose()?,
    })?;
    print_json(&json!({ "input_path": input_path, "output_path": output_path }))
}

fn write_post_child_sidecar(
    input_path: &str,
    output_path: &str,
    model_variant: &str,
    instruct: String,
) -> Result<()> {
    let parent_meta = read_sidecar(input_path.to_string()).ok().flatten();
    let (duration_actual_ms, sample_rate) = cli_wav_info(output_path);
    write_sidecar(
        output_path.to_string(),
        SidecarMeta {
            model: "clip-studio".into(),
            model_variant: Some(model_variant.into()),
            prompt: parent_meta
                .as_ref()
                .map(|meta| meta.prompt.clone())
                .unwrap_or_else(|| "Manual post-processing".into()),
            instruct: Some(instruct),
            speaker: parent_meta.as_ref().and_then(|meta| meta.speaker.clone()),
            language: parent_meta.as_ref().and_then(|meta| meta.language.clone()),
            seed: parent_meta.as_ref().map(|meta| meta.seed).unwrap_or(0),
            temperature: None,
            top_p: None,
            duration_target_ms: duration_actual_ms,
            duration_actual_ms,
            sample_rate,
            generated_at: Utc::now(),
            parent: Some(input_path.to_string()),
            take_index: parent_meta
                .as_ref()
                .map(|meta| meta.take_index + 1)
                .unwrap_or(0),
            qa_status: "unreviewed".into(),
            qa_notes: String::new(),
        },
    )
}

async fn post_normalize(input_path: &str, rest: &[String]) -> Result<()> {
    let flags = parse_flags(rest)?;
    let target_lufs = flag_parse(&flags, "target_lufs", -16.0)?;
    let output_path = normalize_clip(input_path.to_string(), target_lufs)?;
    write_post_child_sidecar(
        input_path,
        &output_path,
        "ffmpeg-loudnorm",
        format!("normalize_lufs={:.1}", target_lufs),
    )?;
    print_json(&json!({ "input_path": input_path, "output_path": output_path }))
}

async fn post_resample(input_path: &str, output_path: &str) -> Result<()> {
    resample_to_48k(input_path.to_string(), output_path.to_string())?;
    write_post_child_sidecar(
        input_path,
        output_path,
        "ffmpeg-resample",
        "resample=48000 stereo".into(),
    )?;
    print_json(&json!({ "input_path": input_path, "output_path": output_path }))
}

async fn setup_status(config: &crate::models::AppConfig) -> Result<()> {
    let models_dir = PathBuf::from(&config.models_dir);
    let projects_dir = PathBuf::from(&config.projects_dir);
    let woosh_dir = PathBuf::from(&config.woosh_dir);
    let audioldm_cache_dir = std::env::var("PHARAOH_AUDIOLDM_CACHE_DIR")
        .or_else(|_| std::env::var("AUDIOLDM_CACHE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| models_dir.join("sfx/audioldm"));
    let inference_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../inference");
    let status = json!({
        "config": {
            "projects_dir": config.projects_dir,
            "models_dir": config.models_dir,
            "woosh_dir": config.woosh_dir,
            "tts_url": config.tts_url,
            "sfx_url": config.sfx_url,
            "music_url": config.music_url,
            "post_url": config.post_url,
        },
        "paths": {
            "projects_dir_exists": projects_dir.exists(),
            "models_dir_exists": models_dir.exists(),
            "woosh_dir_exists": woosh_dir.exists(),
            "woosh_venv_exists": woosh_dir.join(".venv/bin/python3").exists(),
            "tts_venv_exists": inference_dir.join(".venv-tts/bin/python3").exists(),
            "music_venv_exists": inference_dir.join(".venv-music/bin/python3").exists(),
            "audioldm_venv_exists": inference_dir.join(".venv-audioldm/bin/python3").exists(),
            "audiosr_venv_exists": inference_dir.join(".venv-audiosr/bin/python3").exists(),
            "tts_base_model_exists": models_dir.join("tts/base").exists(),
            "tts_voice_design_model_exists": models_dir.join("tts/voice_design").exists(),
            "tts_custom_voice_model_exists": models_dir.join("tts/custom_voice").exists(),
            "music_model_exists": models_dir.join("music").exists(),
            "audioldm_cache_dir": audioldm_cache_dir.to_string_lossy(),
            "audioldm_cache_exists": audioldm_cache_dir.exists(),
            "audiosr_cache_exists": models_dir.join("audiosr").exists(),
        }
    });
    print_json(&status)
}

async fn submit_job<T: Serialize>(
    http: &reqwest::Client,
    url: String,
    params: &T,
    label: &str,
) -> Result<String> {
    let resp: serde_json::Value = http
        .post(url)
        .json(params)
        .send()
        .await
        .map_err(|e| Error::Other(format!("{label} server error: {e}")))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("{label} response error: {e}")))?;

    resp["job_id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Other(format!("{label} response missing job_id")))
}

async fn poll_job(
    http: &reqwest::Client,
    jobs_url: String,
    job_id: &str,
    label: &str,
) -> Result<crate::models::JobStatus> {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let status = http
            .get(format!("{jobs_url}/{job_id}"))
            .send()
            .await
            .map_err(|e| Error::Other(format!("{label} poll error: {e}")))?
            .json::<crate::models::JobStatus>()
            .await
            .map_err(|e| Error::Other(format!("{label} poll parse error: {e}")))?;

        match status.status.as_str() {
            "complete" => return Ok(status),
            "failed" => {
                return Err(Error::Other(
                    status
                        .error
                        .unwrap_or_else(|| format!("{label} generation failed")),
                ))
            }
            _ => {}
        }
    }
}

fn asset_output_path(
    projects_dir: &Path,
    project_id: &str,
    scene_slug: &str,
    stem: &str,
) -> String {
    scene_dir(projects_dir, project_id, scene_slug)
        .join("assets")
        .join(format!("{stem}.wav"))
        .to_string_lossy()
        .to_string()
}

fn sanitized_stem(input: &str) -> String {
    let filtered: String = input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    filtered.trim_matches('_').to_string()
}

fn random_seed() -> i64 {
    (Utc::now().timestamp_nanos_opt().unwrap_or_default() % 100_000) as i64
}
