//! Headless CLI dispatcher.
//!
//! `run` parses argv-style commands and routes them into domain submodules.
//! Shared plumbing (flag parsing, JSON output, project/storyboard loading,
//! inference job submit/poll) lives in `helpers`. The command surface —
//! names, flags, JSON output shapes, and exit codes — is a stable
//! agent-facing API; see `cli.md` for the module map.

mod asset_post;
mod character;
mod compose;
mod generate;
mod generate_scene;
mod helpers;
mod llm;
mod project;
mod scene_script;
mod server_setup;

use crate::app_support::{default_config_path, ensure_app_dirs, load_or_default_app_config};
use crate::error::{Error, Result};

pub async fn run(args: Vec<String>) -> Result<()> {
    let config_path = default_config_path()?;
    let config = load_or_default_app_config(&config_path)?;
    ensure_app_dirs(&config)?;

    match args.as_slice() {
        [group, action] if group == "project" && action == "list" => {
            project::project_list(&config).await
        }
        [group, action, project_id] if group == "project" && action == "status" => {
            project::project_status(&config, project_id).await
        }
        [group, action, rest @ ..] if group == "project" && action == "create" => {
            project::project_create(&config, rest).await
        }
        [group, action, project_id, rest @ ..] if group == "project" && action == "update" => {
            project::project_update(&config, project_id, rest).await
        }
        [group, action, project_id, rest @ ..] if group == "project" && action == "archive" => {
            project::project_archive(&config, project_id, rest).await
        }
        [group, action, project_id] if group == "scene" && action == "list" => {
            scene_script::scene_list(&config, project_id).await
        }
        [group, action, project_id, scene_ref] if group == "scene" && action == "get" => {
            scene_script::scene_get(&config, project_id, scene_ref).await
        }
        [group, action, project_id, rest @ ..] if group == "scene" && action == "create" => {
            scene_script::scene_create(&config, project_id, rest).await
        }
        [group, action, project_id, scene_ref, rest @ ..]
            if group == "scene" && action == "update" =>
        {
            scene_script::scene_update(&config, project_id, scene_ref, rest).await
        }
        [group, action, project_id, scene_slug] if group == "script" && action == "read" => {
            scene_script::script_read(&config, project_id, scene_slug).await
        }
        [group, action, project_id, scene_slug, input_path]
            if group == "script" && action == "write" =>
        {
            scene_script::script_write(&config, project_id, scene_slug, input_path).await
        }
        [group, action, project_id, scene_slug]
            if group == "script" && action == "fountain-read" =>
        {
            scene_script::script_fountain_read(&config, project_id, scene_slug).await
        }
        [group, action, project_id, scene_slug, input_path, rest @ ..]
            if group == "script" && action == "fountain-write" =>
        {
            scene_script::script_fountain_write(&config, project_id, scene_slug, input_path, rest)
                .await
        }
        [group, action, project_id, scene_slug, row_index, rest @ ..]
            if group == "script" && action == "update-row" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            scene_script::script_update_row(&config, project_id, scene_slug, row_index, rest).await
        }
        [group, action, project_id, scene_slug, row_index, rest @ ..]
            if group == "script" && action == "spatialize" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            scene_script::script_spatialize(&config, project_id, scene_slug, row_index, rest).await
        }
        [group, action, project_id, fountain_path, rest @ ..]
            if group == "script" && action == "import" =>
        {
            scene_script::script_import(&config, project_id, fountain_path, rest).await
        }
        [group, action, rest @ ..] if group == "server" && action == "health" => {
            server_setup::server_health(&config, rest).await
        }
        [group, action] if group == "server" && action == "config" => {
            server_setup::server_config_get(&config).await
        }
        [group, action, rest @ ..] if group == "server" && action == "config-set" => {
            server_setup::server_config_set(&config_path, config.clone(), rest).await
        }
        [group, action, model, rest @ ..] if group == "model" && action == "load" => {
            server_setup::model_load(&config, model, rest).await
        }
        [group, action, model] if group == "model" && action == "unload" => {
            server_setup::model_unload(&config, model).await
        }
        [group, action, project_id] if group == "character" && action == "list" => {
            character::character_list(&config, project_id).await
        }
        [group, action, project_id, rest @ ..] if group == "character" && action == "create" => {
            character::character_create(&config, project_id, rest).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "update" =>
        {
            character::character_update(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, character_id] if group == "character" && action == "delete" => {
            character::character_delete(&config, project_id, character_id).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "voice-set" =>
        {
            character::character_voice_set(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "voice-design-test" =>
        {
            character::character_voice_design_test(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, character_id, rest @ ..]
            if group == "character" && action == "voice-clone-test" =>
        {
            character::character_voice_clone_test(&config, project_id, character_id, rest).await
        }
        [group, action, project_id, rest @ ..] if group == "asset" && action == "list" => {
            asset_post::asset_list(&config, project_id, rest).await
        }
        [group, action, audio_path] if group == "asset" && action == "meta" => {
            asset_post::asset_meta(audio_path).await
        }
        [group, action, audio_path, rest @ ..] if group == "asset" && action == "qa" => {
            asset_post::asset_qa(audio_path, rest).await
        }
        [group, action, audio_path] if group == "asset" && action == "takes" => {
            asset_post::asset_takes(audio_path).await
        }
        [group, action, project_id, scene_slug, row_index, audio_path]
            if group == "asset" && action == "use" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            asset_post::asset_use(&config, project_id, scene_slug, row_index, audio_path).await
        }
        [group, action, subaction, project_id, scene_slug]
            if group == "compose" && action == "render" && subaction == "scene" =>
        {
            compose::compose_render_scene(&config, project_id, scene_slug).await
        }
        [group, action, project_id, rest @ ..] if group == "compose" && action == "final" => {
            compose::compose_final(&config, project_id, rest).await
        }
        [group, action, project_id, rest @ ..] if group == "storyboard" && action == "rewrite" => {
            llm::storyboard_rewrite(&config, project_id, rest).await
        }
        [group, action, project_id, rest @ ..] if group == "storyboard" && action == "review" => {
            llm::storyboard_rewrite(&config, project_id, rest).await
        }
        [group, action, project_id, scene_slug, rest @ ..]
            if group == "llm" && action == "draft-scene" =>
        {
            llm::llm_draft_scene(&config, project_id, scene_slug, rest).await
        }
        [group, action, audio_path, num_peaks] if group == "audio" && action == "peaks" => {
            let num_peaks = num_peaks
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid peak count: {}", num_peaks)))?;
            compose::audio_peaks(audio_path, num_peaks).await
        }
        [group, action, audio_path] if group == "audio" && action == "duration" => {
            compose::audio_duration(audio_path).await
        }
        [group, action, audio_path, near_ms] if group == "audio" && action == "zero-crossings" => {
            let near_ms = near_ms
                .parse::<u64>()
                .map_err(|_| Error::Other(format!("invalid near_ms: {}", near_ms)))?;
            compose::audio_zero_crossings(audio_path, near_ms).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "tts-custom" => {
            generate::generate_tts_custom(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "tts-design" => {
            generate::generate_tts_design(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "tts-clone" => {
            generate::generate_tts_clone(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "sfx" => {
            generate::generate_direct_sfx(&config, rest).await
        }
        [group, action, rest @ ..] if group == "generate" && action == "music" => {
            generate::generate_direct_music(&config, rest).await
        }
        [group, action, project_id, source_path, rest @ ..]
            if group == "post" && action == "import" =>
        {
            asset_post::post_import(&config, project_id, source_path, rest).await
        }
        [group, action, input_path, rest @ ..] if group == "post" && action == "process" => {
            asset_post::post_process(input_path, rest).await
        }
        [group, action, input_path, rest @ ..] if group == "post" && action == "normalize" => {
            asset_post::post_normalize(input_path, rest).await
        }
        [group, action, input_path, output_path] if group == "post" && action == "resample" => {
            asset_post::post_resample(input_path, output_path).await
        }
        [group, action, input_path, rest @ ..] if group == "post" && action == "upscale" => {
            asset_post::post_upscale(&config, input_path, rest).await
        }
        [group, action] if group == "setup" && action == "status" => {
            server_setup::setup_status(&config).await
        }
        [group, action] if group == "setup" && action == "hardware" => {
            server_setup::setup_hardware().await
        }
        [group, action, render_path] if group == "compose" && action == "meta" => {
            compose::compose_meta(render_path).await
        }
        [group, action, subaction, project_id, scene_slug, row_index]
            if group == "generate" && action == "row" && subaction == "scene" =>
        {
            let row_index = row_index
                .parse::<usize>()
                .map_err(|_| Error::Other(format!("invalid row index: {}", row_index)))?;
            generate_scene::generate_row(&config, project_id, scene_slug, row_index).await
        }
        [group, action, subaction, project_id, scene_slug]
            if group == "generate" && action == "all" && subaction == "scene" =>
        {
            generate_scene::generate_all(&config, project_id, scene_slug).await
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
  pharaoh project archive <project_id> [--output <path>]
  pharaoh scene list <project_id>
  pharaoh scene get <project_id> <scene_slug_or_id>
  pharaoh scene create <project_id> --title <title> [--slug <slug>] [--index <n>]
  pharaoh scene update <project_id> <scene_slug_or_id> [--status draft|generating|assets_ready|composed|rendered]
  pharaoh script read <project_id> <scene_slug>
  pharaoh script write <project_id> <scene_slug> <script.csv|script.json>
  pharaoh script fountain-read <project_id> <scene_slug>
  pharaoh script fountain-write <project_id> <scene_slug> <script.fountain|-> [--compile true|false]
  pharaoh script update-row <project_id> <scene_slug> <row_index> [--prompt <text>] [--instruct <text>] [--file <path>]
  pharaoh script spatialize <project_id> <scene_slug> <row_index> [--azimuth <deg>] [--elevation <deg>] [--path <json>] [--space <slug>] [--wet <0-1>] [--clear]
  pharaoh script import <project_id> <fountain_file> [--dry-run] [--prefix <slug-prefix>] [--start-index <n>] [--character-prefix CHAR_]
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
  pharaoh compose meta <render_wav>
  pharaoh compose final <project_id> [--crossfade <ms>] [--target-lufs <n>]
  pharaoh llm draft-scene <project_id> <scene_slug> [--model <name>] [--api-key-env <var>] [--write-fountain true|false] [--compile true|false]
  pharaoh storyboard review <project_id> [--model <name>] [--api-key-env <var>]
  pharaoh storyboard rewrite <project_id> [--model <name>] [--api-key-env <var>]
  pharaoh audio peaks <audio_path> <num_peaks>
  pharaoh audio duration <audio_path>
  pharaoh audio zero-crossings <audio_path> <near_ms>
  pharaoh post import <project_id> <source_audio> [--label <text>]
  pharaoh post process <input_wav> [--start-ms <n>] [--end-ms <n>] [--gain-db <n>] [--fade-in-ms <n>] [--fade-out-ms <n>] [--fade-in-curve tri|qsin|qua] [--fade-out-curve tri|qsin|qua]
  pharaoh post normalize <input_wav> [--target-lufs -16]
  pharaoh post resample <input_wav> <output_wav>
  pharaoh post upscale <input_wav> [--model basic|speech] [--steps 50] [--guidance 3.5] [--seed 0]
  pharaoh setup status
  pharaoh setup hardware
  pharaoh generate row scene <project_id> <scene_slug> <row_index>
  pharaoh generate all scene <project_id> <scene_slug>"
}
