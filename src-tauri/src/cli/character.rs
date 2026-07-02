//! `pharaoh character ...` commands: character CRUD, voice assignment, and
//! headless voice design/clone probe generation against the TTS server.

use std::path::PathBuf;

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use super::generate::{submit_tts_clone_and_finalize, submit_tts_design_and_finalize};
use super::helpers::{
    flag_opt, flag_parse, flag_string, load_project, parse_flags, print_json, random_seed,
    save_project,
};
use crate::error::{Error, Result};
use crate::models::{Character, TtsVoiceCloneRequest, TtsVoiceDesignRequest, VoiceAssignment};

/// Build the standard "character not found" error with a
/// `pharaoh character list` hint.
fn character_not_found(character_id: &str, project_id: &str) -> Error {
    Error::Other(format!(
        "character {} not found in project {} — run `pharaoh character list {}` to see character ids",
        character_id, project_id, project_id
    ))
}

pub(super) async fn character_list(
    config: &crate::models::AppConfig,
    project_id: &str,
) -> Result<()> {
    let project = load_project(config, project_id)?;
    print_json(&project.characters)
}

pub(super) async fn character_create(
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
            ref_audio_sources: vec![],
            ref_transcript: flag_opt(&flags, "ref_transcript"),
            base_voice_description: String::new(),
            emotional_palette: vec![],
            production_pipeline: "chatterbox".to_string(),
            rvc: None,
            rvc_model_path: None,
            rvc_index_path: None,
            rvc_pitch_shift: 0,
            rvc_index_rate: 0.5,
            rvc_protect: 0.33,
            rvc_enabled: false,
        },
        schema_version: crate::models::CURRENT_CHARACTER_SCHEMA,
        library_id: None,
        library_version: None,
    };
    project.characters.push(character.clone());
    save_project(config, project)?;
    print_json(&character)
}

pub(super) async fn character_update(
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
        .ok_or_else(|| character_not_found(character_id, project_id))?;
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

pub(super) async fn character_delete(
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
        return Err(character_not_found(character_id, project_id));
    }
    save_project(config, project)?;
    print_json(&json!({ "deleted": character_id }))
}

pub(super) async fn character_voice_set(
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
        .ok_or_else(|| character_not_found(character_id, project_id))?;
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

pub(super) async fn character_voice_design_test(
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
        .ok_or_else(|| character_not_found(character_id, project_id))?;
    let text = flag_string(&flags, "text", "And then she said - nothing at all.");
    let voice_description = flag_opt(&flags, "voice_description")
        .or_else(|| character.voice_assignment.instruct_default.clone())
        .ok_or_else(|| {
            Error::Other(format!(
                "missing --voice-description and character {} has no default voice direction",
                character_id
            ))
        })?;
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

pub(super) async fn character_voice_clone_test(
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
        .ok_or_else(|| character_not_found(character_id, project_id))?;
    let ref_audio_path = flag_opt(&flags, "ref_audio_path")
        .or_else(|| character.voice_assignment.ref_audio_path.clone())
        .ok_or_else(|| {
            Error::Other(format!(
                "missing --ref-audio-path and character {} has no reference audio assigned",
                character_id
            ))
        })?;
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
