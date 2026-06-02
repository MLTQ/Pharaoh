use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaletteEntry {
    /// Slug key matching script.csv `emotion` column (e.g. "neutral", "sardonic")
    pub emotion: String,
    /// Human-readable display label
    pub label: String,
    /// Short emotional direction appended to base_voice_description at generation time.
    /// e.g. "Flat, controlled fear. Each word measured." — NOT a full voice description.
    #[serde(default)]
    pub direction: String,
    /// Absolute path to locked reference .wav (None = not yet generated/approved).
    /// This is the "gold" — whichever of `ref_audio_sources` (or a concat-derived
    /// file) is currently used by Chatterbox for cloning this emotion.
    pub ref_audio_path: Option<String>,
    /// All uploaded / generated takes for this emotion. The gold (`ref_audio_path`)
    /// is normally one of these. Empty list = single-source legacy state — read code
    /// in `commands::character` lifts `ref_audio_path` into this on read so the UI
    /// only ever has to look at one shape.
    #[serde(default)]
    pub ref_audio_sources: Vec<String>,
    pub ref_transcript: Option<String>,
    /// "unreviewed" | "approved"
    pub qa_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAssignment {
    /// Legacy field — kept for back-compat reads from existing project.json.
    /// New code should derive the badge/UI hint from data shape
    /// (palette length, presence of rvc, production_pipeline).
    pub model: String,
    pub speaker: Option<String>,
    pub instruct_default: Option<String>,
    /// "Gold" character reference — whichever of `ref_audio_sources` (or a
    /// concat-derived file) Chatterbox should use for 0-shot cloning.
    pub ref_audio_path: Option<String>,
    /// All uploaded / generated takes available for this character's voice.
    /// The gold (`ref_audio_path`) is normally one of these. Lifted from
    /// `ref_audio_path` on read for legacy data.
    #[serde(default)]
    pub ref_audio_sources: Vec<String>,
    pub ref_transcript: Option<String>,
    /// Full Qwen3 VoiceDesign description defining this character's vocal identity.
    /// Palette take generation prepends this to each entry's `direction`.
    #[serde(default)]
    pub base_voice_description: String,
    /// Named emotional states for the Chatterbox Turbo palette workflow.
    #[serde(default)]
    pub emotional_palette: Vec<PaletteEntry>,
    /// Which production pipeline runs per dialogue line.
    /// "chatterbox" (default) skips RVC. "chatterbox+rvc" runs RVC after Chatterbox.
    /// Replaces the overloaded legacy `model` enum as the only thing that affects
    /// per-line generation.
    #[serde(default = "default_production_pipeline")]
    pub production_pipeline: String,
    /// Nested RVC config. None when RVC is not configured for this character.
    /// Legacy flat `rvc_*` fields below are lifted into this struct on load
    /// by [`VoiceAssignment::consolidate_legacy_rvc`].
    #[serde(default)]
    pub rvc: Option<RvcConfig>,

    // ── Legacy flat fields ──────────────────────────────────────────────────
    // Read from older project.json files, never written back. Always consolidated
    // into the nested `rvc` field on load.
    #[serde(default, skip_serializing)]
    pub rvc_model_path: Option<String>,
    #[serde(default, skip_serializing)]
    pub rvc_index_path: Option<String>,
    #[serde(default, skip_serializing)]
    pub rvc_pitch_shift: i32,
    #[serde(default = "default_rvc_index_rate", skip_serializing)]
    pub rvc_index_rate: f32,
    #[serde(default = "default_rvc_protect", skip_serializing)]
    pub rvc_protect: f32,
    #[serde(default, skip_serializing)]
    pub rvc_enabled: bool,
}

/// Nested RVC configuration for a character. Stage 4 of the voice pipeline.
///
/// `corpus_count` and `corpus_duration_ms` are transient — recomputed from
/// the on-disk `rvc_corpus/` directory whenever a project is loaded, never
/// trusted on read. They're persisted only so the on-disk shape stays
/// round-trippable; the UI reads fresh values on each `get_project`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RvcConfig {
    /// Absolute path to the trained `.pth` weights file. None = model not yet trained.
    #[serde(default)]
    pub model_path: Option<String>,
    /// Absolute path to the FAISS `.index` file alongside the model.
    #[serde(default)]
    pub index_path: Option<String>,
    /// Pitch shift in semitones applied at inference time. Range -12..=12.
    #[serde(default)]
    pub pitch_shift: i32,
    /// Retrieval index influence (0..=1). Default 0.5.
    #[serde(default = "default_rvc_index_rate")]
    pub index_rate: f32,
    /// Voiceless consonant protection (0..=0.5). Default 0.33.
    #[serde(default = "default_rvc_protect")]
    pub protect: f32,
    /// When true, production dialogue lines pass through RVC after Chatterbox.
    /// Mirrors `VoiceAssignment::production_pipeline == "chatterbox+rvc"`; kept
    /// here for the existing RvcModelStage toggle. Future cleanup: collapse.
    #[serde(default)]
    pub enabled: bool,
    /// Number of WAV files in the corpus dir at last load (transient).
    #[serde(default)]
    pub corpus_count: u32,
    /// Total corpus duration in milliseconds at last load (transient).
    #[serde(default)]
    pub corpus_duration_ms: u64,
}

impl VoiceAssignment {
    /// Lift legacy flat `rvc_*` fields into the nested [`RvcConfig`] when present.
    /// Idempotent — safe to call on already-migrated VoiceAssignments.
    /// Called on every project load before the UI sees the data.
    pub fn consolidate_legacy_rvc(&mut self) {
        let has_legacy = self.rvc_model_path.is_some()
            || self.rvc_index_path.is_some()
            || self.rvc_enabled
            || self.rvc_pitch_shift != 0;
        if self.rvc.is_none() && has_legacy {
            self.rvc = Some(RvcConfig {
                model_path: self.rvc_model_path.take(),
                index_path: self.rvc_index_path.take(),
                pitch_shift: self.rvc_pitch_shift,
                index_rate: self.rvc_index_rate,
                protect: self.rvc_protect,
                enabled: self.rvc_enabled,
                corpus_count: 0,
                corpus_duration_ms: 0,
            });
        }
        // Reset legacy fields so a manual save doesn't accidentally round-trip them
        // (skip_serializing already prevents that, but clean state is friendlier).
        self.rvc_model_path = None;
        self.rvc_index_path = None;
        self.rvc_pitch_shift = 0;
        self.rvc_enabled = false;

        // Back-fill production_pipeline from legacy rvc enable state if unset.
        if self.production_pipeline.is_empty() {
            self.production_pipeline = if self.rvc.as_ref().is_some_and(|r| r.enabled) {
                "chatterbox+rvc".to_string()
            } else {
                "chatterbox".to_string()
            };
        }
    }
}

fn default_production_pipeline() -> String {
    "chatterbox".to_string()
}

fn default_character_schema_version() -> u32 {
    1
}

/// Latest character schema version. Migration brings characters up to this.
/// - 2 (Pharaoh-rjr + 82v): nested `RvcConfig`, `production_pipeline` field.
/// - 3 (Pharaoh-1qp): in-bundle voice paths stored relative on disk.
pub const CURRENT_CHARACTER_SCHEMA: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Character {
    pub id: String,
    pub name: String,
    pub description: String,
    pub voice_assignment: VoiceAssignment,
    /// Bumped whenever the character data shape changes. Migration in
    /// `commands/project.rs::migrate_project` brings older characters up.
    /// Absent in legacy project.json — defaults to 1.
    #[serde(default = "default_character_schema_version")]
    pub schema_version: u32,
    /// If this character was imported from the library, the originating
    /// library entry's UUID. None for project-only characters that have
    /// never been promoted to the library.
    #[serde(default)]
    pub library_id: Option<String>,
    /// ISO-8601 timestamp of the library entry at the time of the last
    /// import or push. Used by the future drift indicator (Pharaoh-wpk)
    /// to decide whether the project version diverges from the library.
    #[serde(default)]
    pub library_version: Option<String>,
}

/// Lightweight summary of a library character used by `list_library_characters`.
/// Avoids loading the full Character + scanning RVC corpus for every entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryCharacterSummary {
    /// Library-scoped UUID (also the bundle directory name).
    pub library_id: String,
    pub name: String,
    pub description: String,
    /// Number of palette entries with an approved reference.
    pub palette_count: u32,
    /// True if a trained RVC model file exists in the bundle.
    pub has_rvc_model: bool,
    /// ISO-8601 timestamp of the library entry's last save.
    pub library_version: String,
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
    pub post_url: String,
    pub chatterbox_url: String,
    pub mcp_url: String,
    /// Base URL of the RVC voice-conversion server (default port 18006).
    pub rvc_url: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            tts_url: "http://127.0.0.1:18001".to_string(),
            sfx_url: "http://127.0.0.1:18002".to_string(),
            music_url: "http://127.0.0.1:18003".to_string(),
            post_url: "http://127.0.0.1:18004".to_string(),
            chatterbox_url: "http://127.0.0.1:18005".to_string(),
            mcp_url: "http://127.0.0.1:18000".to_string(),
            rvc_url: "http://127.0.0.1:18006".to_string(),
        }
    }
}

fn default_post_url() -> String {
    "http://127.0.0.1:18004".to_string()
}

fn default_chatterbox_url() -> String {
    "http://127.0.0.1:18005".to_string()
}

fn default_mcp_url() -> String {
    "http://127.0.0.1:18000".to_string()
}

fn default_rvc_url() -> String {
    "http://127.0.0.1:18006".to_string()
}

fn default_rvc_index_rate() -> f32 {
    0.5
}

fn default_rvc_protect() -> f32 {
    0.33
}

fn default_single_model_mode() -> bool {
    false
}

fn default_inference_host() -> String {
    "http://127.0.0.1".to_string()
}

fn default_split_inference_servers() -> bool {
    false
}

// ── Persistent app config ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub tts_url: String,
    pub sfx_url: String,
    pub music_url: String,
    #[serde(default = "default_post_url")]
    pub post_url: String,
    #[serde(default = "default_chatterbox_url")]
    pub chatterbox_url: String,
    #[serde(default = "default_mcp_url")]
    pub mcp_url: String,
    /// Base URL of the RVC voice-conversion server (default port 18006).
    #[serde(default = "default_rvc_url")]
    pub rvc_url: String,
    /// Bind inference servers to 0.0.0.0 (LAN) vs 127.0.0.1 (local only)
    pub tts_public: bool,
    pub sfx_public: bool,
    pub music_public: bool,
    #[serde(default)]
    pub chatterbox_public: bool,
    pub projects_dir: String,
    pub models_dir: String,
    /// Path to the cloned Woosh repo (https://github.com/SonyResearch/Woosh)
    #[serde(default)]
    pub woosh_dir: String,
    /// When true, auto-unload other heavy models before starting any generation job.
    #[serde(default = "default_single_model_mode")]
    pub single_model_mode: bool,
    /// Shared scheme+host (no port) for all inference servers when split_inference_servers=false.
    /// e.g. "http://192.168.1.42" — each server appends its own default port.
    #[serde(default = "default_inference_host")]
    pub inference_host: String,
    /// When false (default), all server URLs derive from inference_host + port.
    /// When true, each server has its own independently-configurable URL.
    #[serde(default = "default_split_inference_servers")]
    pub split_inference_servers: bool,
}

impl AppConfig {
    pub fn with_home(home: &std::path::Path) -> Self {
        Self {
            tts_url: "http://127.0.0.1:18001".to_string(),
            sfx_url: "http://127.0.0.1:18002".to_string(),
            music_url: "http://127.0.0.1:18003".to_string(),
            post_url: default_post_url(),
            chatterbox_url: default_chatterbox_url(),
            mcp_url: default_mcp_url(),
            rvc_url: default_rvc_url(),
            tts_public: false,
            sfx_public: false,
            music_public: false,
            chatterbox_public: false,
            projects_dir: home.join("pharaoh-projects").to_string_lossy().into_owned(),
            models_dir: home.join("pharaoh-models").to_string_lossy().into_owned(),
            woosh_dir: home
                .join("Code")
                .join("Woosh")
                .to_string_lossy()
                .into_owned(),
            single_model_mode: false,
            inference_host: default_inference_host(),
            split_inference_servers: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllServerHealth {
    pub tts: Option<ServerHealth>,
    pub sfx: Option<ServerHealth>,
    pub music: Option<ServerHealth>,
    pub post: Option<ServerHealth>,
    pub chatterbox: Option<ServerHealth>,
    pub mcp: Option<ServerHealth>,
    /// Health of the RVC voice-conversion server.
    pub rvc: Option<ServerHealth>,
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
            post_url: app_config.post_url.clone(),
            chatterbox_url: app_config.chatterbox_url.clone(),
            mcp_url: app_config.mcp_url.clone(),
            rvc_url: app_config.rvc_url.clone(),
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
    pub backend: Option<String>,
    pub steps: u32,
    pub seed: i64,
    pub cfg_scale: Option<f32>,
    pub guidance_scale: Option<f32>,
    pub negative_prompt: Option<String>,
    pub num_waveforms_per_prompt: Option<u32>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedAudioAsset {
    pub audio_path: String,
    pub meta_path: String,
    pub scene_slug: String,
    pub kind: String,
    pub name: String,
    pub duration_ms: Option<u64>,
    pub sample_rate: u32,
    pub model: String,
    pub model_variant: Option<String>,
    pub prompt: String,
    pub generated_at: DateTime<Utc>,
    pub parent: Option<String>,
    pub qa_status: String,
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
    /// Palette emotion key for Chatterbox routing (e.g. "neutral", "tense"). Empty = use default.
    #[serde(default)]
    pub emotion: String,
    pub notes: String,
    #[serde(default)]
    pub gain_envelope: String,
    /// Spatial azimuth in degrees [0, 360). 0 = directly in front of the listener,
    /// 90 = right, 180 = behind, 270 = left. Empty string = no spatialization
    /// (clip uses the legacy `pan` field for L/R amplitude panning instead).
    #[serde(default)]
    pub spatial_azimuth: String,
    /// Spatial elevation in degrees [-90, +90]. 0 = ear level, +90 = directly
    /// above, -90 = directly below. Only meaningful when `spatial_azimuth` is set.
    #[serde(default)]
    pub spatial_elevation: String,
    /// JSON-encoded waypoint trajectory for moving sources, shape:
    /// `[{t_frac: 0.0, az: 0, el: 0}, {t_frac: 1.0, az: 360, el: 0}, ...]`.
    /// Empty string = static position (use spatial_azimuth/elevation as the
    /// fixed point). When non-empty, the render path segments the clip into
    /// ~100ms chunks, renders each at the interpolated (az, el), and
    /// acrossfade-concats them back together for a continuous moving source.
    #[serde(default)]
    pub spatial_path: String,
    /// Slug of a room preset from `assets/spaces/spaces.json`, e.g.
    /// `"cathedral"`, `"cave"`, `"opera-house"`. Empty = dry (no room
    /// reverb). Independent of spatial_azimuth/elevation — a clip can have
    /// a room without binaural placement, and vice versa. Render chain
    /// applies the room IR via ffmpeg's `afir` convolution filter after
    /// the sofalizer step (if any). Wet amount comes from `reverb_send`
    /// or, if empty, the manifest's `default_wet` for the chosen space.
    #[serde(default)]
    pub spatial_space: String,
}
