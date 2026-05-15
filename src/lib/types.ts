// ── Project data model ──────────────────────────────────────────────────────

/**
 * A single emotional state entry in a character's vocal palette.
 * Each entry has its own Qwen3 VoiceDesign-generated reference clip used
 * as the conditioning signal for Chatterbox Turbo 0-shot cloning.
 */
export interface PaletteEntry {
  /** Slug key used in script.csv `emotion` column (e.g. "neutral", "sardonic") */
  emotion: string;
  /** Human-readable display label */
  label: string;
  /**
   * Short emotional direction applied on top of the character's base voice description.
   * e.g. "Flat, controlled fear. Each word measured." — NOT a full voice description.
   * Combined with VoiceAssignment.base_voice_description at generation time.
   */
  direction: string;
  /** Absolute path to the locked reference .wav (null = not yet generated/approved) */
  ref_audio_path: string | null;
  ref_transcript: string | null;
  qa_status: "unreviewed" | "approved";
}

export interface VoiceAssignment {
  model: "CustomVoice" | "VoiceDesign" | "Clone" | "FineTuned" | "Chatterbox";
  speaker: string | null;
  instruct_default: string | null;
  /** Legacy single-reference path (used by Clone tab). */
  ref_audio_path: string | null;
  ref_transcript: string | null;
  /**
   * Full Qwen3 VoiceDesign description that defines this character's vocal identity.
   * Used as the foundation for all palette take generation — each palette entry's
   * `direction` is appended to this when calling /generate/voice_design.
   */
  base_voice_description: string;
  /** Named emotional states for the Chatterbox Turbo palette workflow. */
  emotional_palette: PaletteEntry[];
}

export interface Character {
  id: string;
  name: string;
  description: string;
  voice_assignment: VoiceAssignment;
}

export interface LlmConfig {
  provider: "anthropic" | "openai" | "local";
  model: string;
  api_key_env: string;
}

export interface Project {
  id: string;
  title: string;
  logline: string;
  synopsis: string;
  tone: string;
  global_audio_notes: string;
  target_duration_minutes: number;
  created_at: string;
  updated_at: string;
  characters: Character[];
  llm_config: LlmConfig;
}

export interface AppConfig {
  tts_url: string;
  sfx_url: string;
  music_url: string;
  post_url: string;
  chatterbox_url: string;
  tts_public: boolean;
  sfx_public: boolean;
  music_public: boolean;
  chatterbox_public: boolean;
  projects_dir: string;
  models_dir: string;
  woosh_dir: string;
  single_model_mode: boolean;
}

export interface AllServerHealth {
  tts: ServerHealth | null;
  sfx: ServerHealth | null;
  music: ServerHealth | null;
  post: ServerHealth | null;
  chatterbox: ServerHealth | null;
}

export interface ServerHealth {
  status: string;
  model_loaded: boolean;
  model_variant: string;
  vram_mb: number;
  stub: boolean;
  audioldm_ready?: boolean;
  audioldm_error?: string;
  audioldm_model?: string;
  audioldm_local_dir?: string;
  audioldm_engine?: string;
  audioldm_cuda?: boolean | null;
  audioldm_loaded?: boolean;
  audiosr_ready?: boolean;
  audiosr_error?: string;
  audiosr_cli?: string;
}

// ── Storyboard ──────────────────────────────────────────────────────────────

export type SceneStatus = "draft" | "generating" | "assets_ready" | "composed" | "rendered";

export interface Scene {
  id: string;
  index: number;
  slug: string;
  title: string;
  description: string;
  location: string;
  characters: string[];
  notes: string;
  connects_from: string | null;
  connects_to: string | null;
  status: SceneStatus;
}

// ── Script CSV ──────────────────────────────────────────────────────────────

export type TrackType = "DIALOGUE" | "SFX" | "BED" | "MUSIC" | "DIRECTION";

export interface ScriptRow {
  scene: string;
  track: string;
  type: TrackType;
  character: string;
  prompt: string;
  file: string;            // empty = unresolved
  start_ms: string;        // empty = unplaced
  duration_ms: string;
  loop: string;
  pan: string;
  gain_db: string;
  instruct: string;
  fade_in_ms: string;
  fade_out_ms: string;
  reverb_send: string;
  /** Palette emotion key for Chatterbox routing (e.g. "neutral", "tense"). Empty = use default. */
  emotion: string;
  notes: string;
  gain_envelope: string;  // JSON-encoded EnvelopePoint[], empty string = no envelope
}

// ── Asset sidecar ───────────────────────────────────────────────────────────

export type QaStatus = "unreviewed" | "approved" | "rejected";

export interface SidecarMeta {
  model: string;
  model_variant: string;
  prompt: string;
  instruct: string | null;
  speaker: string | null;
  language: string | null;
  seed: number;
  temperature: number;
  top_p: number;
  duration_target_ms: number | null;
  duration_actual_ms: number;
  sample_rate: number;
  generated_at: string;
  parent: string | null;
  take_index: number;
  qa_status: QaStatus;
  qa_notes: string;
}

export interface GeneratedAudioAsset {
  audio_path: string;
  meta_path: string;
  scene_slug: string;
  kind: AssetKind;
  name: string;
  duration_ms: number | null;
  sample_rate: number;
  model: string;
  model_variant: string | null;
  prompt: string;
  generated_at: string;
  parent: string | null;
  qa_status: QaStatus;
}

// ── Jobs (frontend state) ───────────────────────────────────────────────────

export type ModelKind = "tts" | "sfx" | "music" | "post";
export type JobStatus = "pending" | "running" | "complete" | "failed";

export type QaJobStatus = "unreviewed" | "approved" | "rejected";

export interface Job {
  id: string;
  model: ModelKind;
  description: string;
  status: JobStatus;
  progress: number;       // 0–100
  eta: string;
  started_at: string;
  scene_id: string | null;
  scene_slug: string | null;
  row_index: number | null;
  output_path: string | null;
  peaks: number[] | null; // waveform peaks fetched after completion
  qa_status: QaJobStatus; // defaults to "unreviewed" on job creation
  error: string | null;
}

// ── Asset browser items ─────────────────────────────────────────────────────

export type AssetKind = "tts" | "sfx" | "music";
export type AssetState = "unresolved" | "gen" | "resolved";

export interface AssetItem {
  id: string;
  kind: AssetKind;
  scene: string;
  name: string;
  sub: string;
  state: AssetState;
  file_path: string | null;
  peaks: number[] | null;
}

// ── UI state ────────────────────────────────────────────────────────────────

export type ViewId =
  | "pyramid" | "composition" | "bible" | "characters"
  | "tts" | "sfx" | "music"
  | "clip-studio" | "upscale" | "final"
  | "settings" | "models";

// ── Workspace mode (rail-level navigation) ──────────────────────────────────
//
// The rail is a workspace switcher (mode I'm in); the sidebar is contextual to
// that workspace. Each ViewId belongs to exactly one workspace.

export type WorkspaceId = "pyramid" | "story" | "scenes" | "polish" | "app";

export const WORKSPACE_OF: Record<ViewId, WorkspaceId> = {
  pyramid:        "pyramid",
  bible:          "story",
  characters:     "story",
  composition:    "scenes",
  tts:            "scenes",
  sfx:            "scenes",
  music:          "scenes",
  "clip-studio":  "polish",
  upscale:        "polish",
  final:          "polish",
  models:         "app",
  settings:       "app",
};

// Used when the rail switches workspace and we have no remembered last-view
export const WORKSPACE_DEFAULT_VIEW: Record<WorkspaceId, ViewId> = {
  pyramid: "pyramid",
  story:   "bible",
  scenes:  "composition",
  polish:  "clip-studio",
  app:     "settings",
};

export type RightTab = "agent" | "assets" | "jobs";
export type ColorTemp = "forest" | "warm" | "neutral";
export type Density = "comfortable" | "compact";

export interface AgentLogEntry {
  who: string;
  body: string;
  t: string;
}

// ── Mock data types (matching Pharoh mockup) ─────────────────────────────────

/** A single point on a clip's gain envelope. t_frac is 0..1 (fraction of clip duration). */
export interface EnvelopePoint {
  t_frac: number;  // 0..1
  db: number;      // gain in dBFS, typically -40..+6
}

export interface MockTrackClip {
  start: number;
  len: number;
  label: string;
  take: number;
  row_index?: number;   // script CSV row; set when derived from real project
  audioPath?: string;   // absolute path to audio file for waveform peaks
  gainDb: number;               // parsed from row.gain_db, default 0
  gainEnvelope: EnvelopePoint[]; // parsed from row.gain_envelope, default []
}

export interface MockTrack {
  id: string;
  kind: "dialogue" | "sfx" | "bed" | "music";
  name: string;
  clips: MockTrackClip[];
}

export interface MockSceneNode {
  k: "tts" | "sfx" | "music";
  n: number;
}

export interface MockScene {
  no: string;
  rev: string;
  title: string;
  desc: string;
  script: string;
  status: "rendered" | "ready" | "gen" | "draft";
  duration: string;
  nodes: MockSceneNode[];
  slug?: string; // real slug from Rust, overrides deriveSlug when present
}

export interface MockCastMember {
  id: string;
  name: string;
  voice: string;
  scenes: number;
}

export interface MockProject {
  title: string;
  subtitle: string;
  logline: string;
  synopsis: string;
  season: string;
  episode: string;
  runtime: string;
  genre: string;
  creator: string;
  revision: string;
  lastSync: string;
}

export interface MockAssets {
  dialogue: AssetItem[];
  sfx: AssetItem[];
  music: AssetItem[];
}
