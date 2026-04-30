// ── Project data model ──────────────────────────────────────────────────────

export interface VoiceAssignment {
  model: "CustomVoice" | "VoiceDesign" | "Clone" | "FineTuned";
  speaker: string | null;
  instruct_default: string | null;
  ref_audio_path: string | null;
  ref_transcript: string | null;
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
  tone: string;
  global_audio_notes: string;
  target_duration_minutes: number;
  created_at: string;
  updated_at: string;
  characters: Character[];
  llm_config: LlmConfig;
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
  notes: string;
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

// ── Jobs (frontend state) ───────────────────────────────────────────────────

export type ModelKind = "tts" | "sfx" | "music";
export type JobStatus = "pending" | "running" | "complete" | "failed";

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

export type ViewId = "pyramid" | "composition" | "bible" | "tts" | "sfx" | "music";
export type RightTab = "agent" | "assets" | "jobs";
export type ColorTemp = "forest" | "warm" | "neutral";
export type Density = "comfortable" | "compact";

export interface AgentLogEntry {
  who: string;
  body: string;
  t: string;
}

// ── Mock data types (matching Pharoh mockup) ─────────────────────────────────

export interface MockTrackClip {
  start: number;
  len: number;
  label: string;
  take: number;
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
