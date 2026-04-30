use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAssignment {
    pub model: String,
    pub speaker: Option<String>,
    pub instruct_default: Option<String>,
    pub ref_audio_path: Option<String>,
    pub ref_transcript: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Character {
    pub id: String,
    pub name: String,
    pub description: String,
    pub voice_assignment: VoiceAssignment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    pub api_key_env: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub title: String,
    pub logline: String,
    pub tone: String,
    pub global_audio_notes: String,
    pub target_duration_minutes: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub characters: Vec<Character>,
    pub llm_config: LlmConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SceneStatus {
    Draft,
    Generating,
    AssetsReady,
    Composed,
    Rendered,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub id: String,
    pub index: u32,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub characters: Vec<String>,
    pub notes: String,
    pub connects_from: Option<String>,
    pub connects_to: Option<String>,
    pub status: SceneStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Storyboard {
    pub scenes: Vec<Scene>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum TrackType {
    Dialogue,
    Sfx,
    Bed,
    Music,
    Direction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptRow {
    pub scene: String,
    pub track: String,
    #[serde(rename = "type")]
    pub track_type: String,
    pub character: String,
    pub prompt: String,
    pub file: String,
    pub start_ms: String,
    pub duration_ms: String,
    pub r#loop: String,
    pub pan: String,
    pub gain_db: String,
    pub instruct: String,
    pub fade_in_ms: String,
    pub fade_out_ms: String,
    pub reverb_send: String,
    pub notes: String,
}
