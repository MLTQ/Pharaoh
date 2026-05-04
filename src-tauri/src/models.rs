use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use std::sync::RwLock;

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
    #[serde(default)]
    pub synopsis: String,
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

// ── Inference / job models ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerHealth {
    pub status: String,
    pub model_loaded: bool,
    pub model_variant: String,
    pub vram_mb: u64,
    pub stub: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobStatus {
    pub job_id: String,
    pub status: String,
    pub progress: f32,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub tts_url: String,
    pub sfx_url: String,
    pub music_url: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            tts_url: "http://127.0.0.1:18001".to_string(),
            sfx_url: "http://127.0.0.1:18002".to_string(),
            music_url: "http://127.0.0.1:18003".to_string(),
        }
    }
}

// ── Persistent app config ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub tts_url: String,
    pub sfx_url: String,
    pub music_url: String,
    /// Bind inference servers to 0.0.0.0 (LAN) vs 127.0.0.1 (local only)
    pub tts_public: bool,
    pub sfx_public: bool,
    pub music_public: bool,
    pub projects_dir: String,
    pub models_dir: String,
    /// Path to the cloned Woosh repo (https://github.com/SonyResearch/Woosh)
    #[serde(default)]
    pub woosh_dir: String,
}

impl AppConfig {
    pub fn with_home(home: &std::path::Path) -> Self {
        Self {
            tts_url: "http://127.0.0.1:18001".to_string(),
            sfx_url: "http://127.0.0.1:18002".to_string(),
            music_url: "http://127.0.0.1:18003".to_string(),
            tts_public: false,
            sfx_public: false,
            music_public: false,
            projects_dir: home.join("pharaoh-projects").to_string_lossy().into_owned(),
            models_dir: home.join("pharaoh-models").to_string_lossy().into_owned(),
            woosh_dir: home.join("Code").join("Woosh").to_string_lossy().into_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllServerHealth {
    pub tts: Option<ServerHealth>,
    pub sfx: Option<ServerHealth>,
    pub music: Option<ServerHealth>,
}

pub struct AppState {
    pub http: reqwest::Client,
    pub server_config: RwLock<ServerConfig>,
    pub app_config: RwLock<AppConfig>,
    pub config_path: std::path::PathBuf,
}

impl AppState {
    pub fn new(config_path: std::path::PathBuf, app_config: AppConfig) -> Self {
        let server_config = ServerConfig {
            tts_url: app_config.tts_url.clone(),
            sfx_url: app_config.sfx_url.clone(),
            music_url: app_config.music_url.clone(),
        };
        Self {
            http: reqwest::Client::new(),
            server_config: RwLock::new(server_config),
            app_config: RwLock::new(app_config),
            config_path,
        }
    }
}

// ── TTS request models ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsCustomVoiceRequest {
    pub text: String,
    pub speaker: String,
    pub language: String,
    pub instruct: String,
    pub seed: i64,
    pub temperature: f32,
    pub top_p: f32,
    pub max_new_tokens: u32,
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsVoiceDesignRequest {
    pub text: String,
    pub voice_description: String,
    pub language: String,
    pub seed: i64,
    pub temperature: f32,
    pub top_p: f32,
    pub max_new_tokens: u32,
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsVoiceCloneRequest {
    pub text: String,
    pub ref_audio_path: String,
    pub ref_transcript: String,
    pub language: String,
    pub icl_mode: bool,
    pub seed: i64,
    pub temperature: f32,
    pub top_p: f32,
    pub max_new_tokens: u32,
    pub output_path: String,
}

// ── SFX request models ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SfxT2ARequest {
    pub prompt: String,
    pub duration_seconds: f32,
    pub model_variant: String,
    pub steps: u32,
    pub seed: i64,
    pub output_path: String,
}

// ── Music request models ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MusicText2MusicRequest {
    pub caption: String,
    pub lyrics: String,
    pub duration_seconds: f32,
    pub bpm: Option<u32>,
    pub key: String,
    pub language: String,
    pub lm_model_size: String,
    pub diffusion_steps: u32,
    pub thinking_mode: bool,
    pub reference_audio_path: String,
    pub seed: i64,
    pub batch_size: u32,
    pub output_path: String,
}

// ── Sidecar model ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarMeta {
    pub model: String,
    pub model_variant: Option<String>,
    pub prompt: String,
    pub instruct: Option<String>,
    pub speaker: Option<String>,
    pub language: Option<String>,
    pub seed: i64,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub duration_target_ms: Option<u64>,
    pub duration_actual_ms: Option<u64>,
    pub sample_rate: u32,
    pub generated_at: DateTime<Utc>,
    pub parent: Option<String>,
    pub take_index: u32,
    pub qa_status: String,
    pub qa_notes: String,
}

// ── Progress event payloads (emitted to frontend) ────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobProgressEvent {
    pub job_id: String,
    pub model: String,
    pub status: String,
    pub progress: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobCompleteEvent {
    pub job_id: String,
    pub model: String,
    pub output_path: String,
    pub project_id: String,
    pub scene_slug: String,
    pub row_index: usize,
    pub duration_ms: Option<u64>,
    pub bound_to_script: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobFailedEvent {
    pub job_id: String,
    pub model: String,
    pub error: String,
}

// ── Script row ───────────────────────────────────────────────────────────

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
