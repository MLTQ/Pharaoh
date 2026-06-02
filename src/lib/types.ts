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

/**
 * RVC (Retrieval-based Voice Conversion) model configuration for a character.
 *
 * Stage 4 of the character voice pipeline. After the emotional palette corpus
 * is generated (Stage 3), an RVC model is trained on that Chatterbox output
 * to lock voice consistency across all production lines.
 *
 * Pipeline: Chatterbox (clone + tags) → AudioSR → RVC → final WAV
 */
export interface RvcConfig {
  /**
   * Absolute path to the trained .pth model file.
   * Null = model not yet trained (Stage 4 incomplete).
   */
  model_path: string | null;
  /**
   * Absolute path to the FAISS .index file (built alongside the model).
   * Optional but strongly recommended — improves fidelity to training voice.
   */
  index_path: string | null;
  /**
   * Pitch shift applied at inference time, in semitones.
   * Useful for aging a character voice without re-recording.
   * Range: -12 to +12. Default: 0.
   */
  pitch_shift: number;
  /**
   * Retrieval index strength (0–1).
   * Lower values preserve paralinguistic events ([sigh], [chuckle]) better;
   * higher values enforce stronger voice identity from training data.
   * Default: 0.5 — balanced for Chatterbox-sourced corpora.
   */
  index_rate: number;
  /**
   * Voiceless consonant protection (0–0.5).
   * Prevents RVC from converting unvoiced sounds (t, s, k, f) which would
   * cause lisping artefacts. Default: 0.33.
   */
  protect: number;
  /**
   * Whether to run the RVC pass on every production line.
   * When false, lines use Chatterbox output directly (no consistency pass).
   * Flip to false when debugging or when the model needs retraining.
   */
  enabled: boolean;
  /**
   * Number of WAV files in the rvc_corpus/ directory at last count.
   * Used by the UI to show corpus build progress without a filesystem scan.
   */
  corpus_count: number;
  /** Total duration of corpus audio in milliseconds (from sidecar files). */
  corpus_duration_ms: number;
}

export interface VoiceAssignment {
  /**
   * Legacy field — overloaded enum for "how was the ref made" + "what runs at
   * production time". Kept for back-compat reads from existing project.json.
   * New code should derive the UI badge from data shape (palette length,
   * presence of `rvc`, value of `production_pipeline`) rather than reading this.
   */
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
  /**
   * Which production pipeline runs per dialogue line.
   * - "chatterbox": Chatterbox only, no RVC pass.
   * - "chatterbox+rvc": Chatterbox followed by RVC voice conversion.
   *
   * Replaces the overloaded legacy `model` enum as the only thing that affects
   * per-line generation. Defaults to "chatterbox" for new characters.
   */
  production_pipeline: "chatterbox" | "chatterbox+rvc";
  /**
   * Stage 4 voice pipeline: RVC model trained on the Chatterbox corpus.
   * Undefined/null when RVC has not been configured for this character.
   * Present (even with model_path null) once the user opens Stage 4.
   *
   * `corpus_count` / `corpus_duration_ms` are recomputed by the backend on
   * every `get_project` call by scanning the rvc_corpus/ directory, so the
   * UI sees fresh values without an extra request.
   */
  rvc?: RvcConfig | null;
}

// ── Voice pipeline stage types ───────────────────────────────────────────────

/**
 * The four progressive stages of the character voice pipeline.
 *
 * Each stage unlocks the next. Stages can be completed in order only:
 *   Voice (1) → Palette (2) → Corpus (3) → Model (4)
 *
 * Characters without a trained model still work — they use Chatterbox-only
 * generation. The pipeline is aspirational, not a gate.
 */
export type VoicePipelineStage = 1 | 2 | 3 | 4;

/** Per-character pipeline completion status, derived from VoiceAssignment. */
export interface VoicePipelineStatus {
  /** Stage 1: base_voice_description written + ≥1 approved design take. */
  stage1Done: boolean;
  /** Stage 2: ≥2 emotional palette entries with approved references. */
  stage2Done: boolean;
  /** Number of WAV files in rvc_corpus/. */
  corpusCount: number;
  /** Target corpus size (default 50). */
  corpusTarget: number;
  /** Total corpus audio duration in ms. */
  corpusDurationMs: number;
  /** Stage 3 complete: corpus has ≥5 min of audio (300_000 ms). */
  stage3Done: boolean;
  /** Stage 4 complete: RVC model .pth file exists on disk. */
  stage4Done: boolean;
  /** Whether the RVC pass is enabled for production generation. */
  rvcEnabled: boolean;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  voice_assignment: VoiceAssignment;
  /**
   * Bumped whenever the on-disk character shape changes. Migration runs on
   * every project load (Rust `migrate_project_in_place`); the UI should treat
   * this as informational only — it never has to migrate itself.
   * Absent in pre-migration project.json — defaults to 1.
   */
  schema_version: number;
  /**
   * UUID of the library entry this character was imported from, or null for
   * project-only characters that have never been pushed to the library.
   */
  library_id?: string | null;
  /**
   * ISO-8601 timestamp from the library entry at the time of import or push.
   * Used by the drift indicator (Pharaoh-wpk) to flag project ↔ library divergence.
   */
  library_version?: string | null;
}

/**
 * Compact summary of a library character, returned by `listLibraryCharacters`.
 * Avoids loading the full Character + scanning RVC corpus for each list entry.
 */
export interface LibraryCharacterSummary {
  library_id: string;
  name: string;
  description: string;
  /** Number of palette entries with an approved reference. */
  palette_count: number;
  /** True if a trained RVC `.pth` model file exists in the bundle. */
  has_rvc_model: boolean;
  /** ISO-8601 timestamp of the library entry's last save. */
  library_version: string;
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
  rvc_url: string;
  tts_public: boolean;
  sfx_public: boolean;
  music_public: boolean;
  chatterbox_public: boolean;
  projects_dir: string;
  models_dir: string;
  woosh_dir: string;
  single_model_mode: boolean;
  /** Base URL (scheme + host, no port) shared by all inference servers when split_inference_servers is false. */
  inference_host: string;
  /** When true, each server has its own URL field. When false, all derive from inference_host + default port. */
  split_inference_servers: boolean;
}

export interface AllServerHealth {
  tts: ServerHealth | null;
  sfx: ServerHealth | null;
  music: ServerHealth | null;
  post: ServerHealth | null;
  chatterbox: ServerHealth | null;
  rvc: ServerHealth | null;
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
  /**
   * Spatial azimuth in degrees [0, 360). 0 = directly in front of the listener,
   * 90 = right, 180 = behind, 270 = left. Empty string = no spatialization
   * (clip uses the legacy `pan` field for L/R amplitude panning instead).
   */
  spatial_azimuth: string;
  /**
   * Spatial elevation in degrees [-90, +90]. 0 = ear level, +90 = directly
   * above, -90 = directly below. Only meaningful when spatial_azimuth is set.
   */
  spatial_elevation: string;
  /**
   * JSON-encoded waypoint trajectory for moving sources:
   * `[{t_frac: 0.0, az: 0, el: 0}, {t_frac: 1.0, az: 360, el: 0}, ...]`.
   * Empty string = static position (use spatial_azimuth/elevation).
   */
  spatial_path: string;
  /**
   * Slug of a room preset from `assets/spaces/spaces.json`, e.g.
   * "cathedral", "cave", "opera-house". Empty = dry (no reverb).
   * Independent of position — a clip can have a room without binaural
   * placement and vice versa. Wet amount = reverb_send if set, else the
   * manifest's default_wet for the chosen space.
   */
  spatial_space: string;
}

/** Curated room IR preset from spaces.json. */
export interface SpatialSpace {
  slug: string;
  label: string;
  description: string;
  /** Filename inside assets/spaces/, or null for the "dry" baseline. */
  file: string | null;
  /** "dry" | "stereo" | "binaural" — how the IR is encoded. */
  type: string;
  source: string | null;
  url: string | null;
  license: string | null;
  /** Default wet/dry mix in [0, 1] when reverb_send isn't set. */
  default_wet: number;
  /** True only when the IR file actually exists on disk (or type === "dry"). */
  available: boolean;
}

/** A single waypoint on a spatial trajectory. */
export interface SpatialWaypoint {
  t_frac: number;  // 0..1
  az: number;      // degrees, 0..360
  el: number;      // degrees, -90..+90
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
  | "pyramid" | "composition" | "bible" | "characters" | "library"
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
  library:        "story",
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
  /** True when the source row has spatial_azimuth or spatial_path set —
   *  used by the timeline clip to render a small compass-rose glyph. */
  hasSpatial?: boolean;
  /** Snapshot of the static spatial position so the glyph can show the
   *  current placement direction without re-reading the row. */
  spatialAz?: number;
  spatialEl?: number;
  /** Selected room IR slug, e.g. "cathedral". Used by the timeline clip
   *  to render a small text tag alongside the spatial glyph. */
  spaceSlug?: string;
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
