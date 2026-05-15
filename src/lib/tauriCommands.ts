import { invoke } from "@tauri-apps/api/core";
import type { Project, Scene, ScriptRow, AppConfig, AllServerHealth, GeneratedAudioAsset } from "./types";

// ── Project ──────────────────────────────────────────────────────────────────

export const getProjectsDir = (): Promise<string> =>
  invoke("get_projects_dir");

export const createProject = (args: {
  title: string;
  logline?: string;
  tone?: string;
}): Promise<Project> => invoke("create_project", args);

export const openProject = (projectId: string): Promise<Project> =>
  invoke("open_project", { projectId });

export const getProject = (projectId: string): Promise<Project> =>
  invoke("get_project", { projectId });

export const listProjects = (): Promise<Project[]> =>
  invoke("list_projects");

export const updateProject = (project: Project): Promise<Project> =>
  invoke("update_project", { project });

// ── Scenes ───────────────────────────────────────────────────────────────────

export const createScene = (args: {
  projectId: string;
  title: string;
  description?: string;
  location?: string;
  index: number;
}): Promise<Scene> => invoke("create_scene", args);

export const updateScene = (args: {
  projectId: string;
  scene: Scene;
}): Promise<Scene> => invoke("update_scene", args);

export const getScene = (args: {
  projectId: string;
  sceneId: string;
}): Promise<Scene> => invoke("get_scene", args);

export const listScenes = (projectId: string): Promise<Scene[]> =>
  invoke("list_scenes", { projectId });

// ── Script CSV ───────────────────────────────────────────────────────────────

export const readScript = (args: {
  projectId: string;
  sceneSlug: string;
}): Promise<ScriptRow[]> => invoke("read_script", args);

export const writeScript = (args: {
  projectId: string;
  sceneSlug: string;
  rows: ScriptRow[];
}): Promise<void> => invoke("write_script", args);

export const updateScriptRow = (args: {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  fields: Partial<Record<string, string>>;
}): Promise<ScriptRow> => invoke("update_script_row", args);

/** Read the scene's script.fountain (the prose source of truth for the
 *  Fountain editor). Returns null if no file exists yet for that scene. */
export const readFountain = (args: {
  projectId: string;
  sceneSlug: string;
}): Promise<string | null> => invoke("read_fountain", args);

/** Persist the scene's prose to script.fountain (atomic write via .tmp +
 *  rename). Called on commit by FountainEditor; CSV is regenerated separately. */
export const writeFountain = (args: {
  projectId: string;
  sceneSlug: string;
  text: string;
}): Promise<void> => invoke("write_fountain", args);

// ── Inference ────────────────────────────────────────────────────────────────

export interface ServerHealth {
  status: string;
  model_loaded: boolean;
  model_variant: string;
  vram_mb: number;
  stub: boolean;
}

export const getAppConfig = (): Promise<AppConfig> =>
  invoke("get_app_config");

export const saveAppConfig = (config: AppConfig): Promise<void> =>
  invoke("save_app_config", { config });

export const getServerHealthAll = (): Promise<AllServerHealth> =>
  invoke("get_server_health_all");

export const checkServerHealth = (model: "tts" | "sfx" | "music" | "post"): Promise<ServerHealth> =>
  invoke("check_server_health", { model });

export const updateServerConfig = (cfg: {
  ttsUrl?: string;
  sfxUrl?: string;
  musicUrl?: string;
  postUrl?: string;
}): Promise<void> => invoke("update_server_config", cfg);

export const submitTtsCustomVoice = (args: {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  params: {
    text: string;
    speaker: string;
    language: string;
    instruct: string;
    seed: number;
    temperature: number;
    top_p: number;
    max_new_tokens: number;
    output_path: string;
  };
}): Promise<string> => invoke("submit_tts_custom_voice", args);

export const submitTtsVoiceClone = (args: {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  params: {
    text: string;
    ref_audio_path: string;
    ref_transcript: string;
    language: string;
    icl_mode: boolean;
    seed: number;
    temperature: number;
    top_p: number;
    max_new_tokens: number;
    output_path: string;
  };
}): Promise<string> => invoke("submit_tts_voice_clone", args);

export const submitTtsVoiceDesign = (args: {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  params: {
    text: string;
    voice_description: string;
    language: string;
    seed: number;
    temperature: number;
    top_p: number;
    max_new_tokens: number;
    output_path: string;
  };
}): Promise<string> => invoke("submit_tts_voice_design", args);

export const submitSfxT2a = (args: {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  params: {
    prompt: string;
    duration_seconds: number;
    model_variant: string;
    backend?: "woosh" | "audioldm";
    steps: number;
    seed: number;
    cfg_scale?: number;
    guidance_scale?: number;
    negative_prompt?: string;
    num_waveforms_per_prompt?: number;
    output_path: string;
  };
}): Promise<string> => invoke("submit_sfx_t2a", args);

export const submitMusicText2Music = (args: {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  params: {
    caption: string;
    lyrics: string;
    duration_seconds: number;
    bpm?: number;
    key: string;
    language: string;
    lm_model_size: string;
    diffusion_steps: number;
    thinking_mode: boolean;
    reference_audio_path: string;
    seed: number;
    batch_size: number;
    output_path: string;
  };
}): Promise<string> => invoke("submit_music_text2music", args);

// ── Sidecar ──────────────────────────────────────────────────────────────────

export interface SidecarMeta {
  model: string;
  model_variant: string | null;
  prompt: string;
  instruct: string | null;
  speaker: string | null;
  language: string | null;
  seed: number;
  temperature: number | null;
  top_p: number | null;
  duration_target_ms: number | null;
  duration_actual_ms: number | null;
  sample_rate: number;
  generated_at: string;
  parent: string | null;
  take_index: number;
  qa_status: "unreviewed" | "approved" | "rejected";
  qa_notes: string;
}

export const writeSidecar = (audioPath: string, meta: SidecarMeta): Promise<void> =>
  invoke("write_sidecar", { audioPath, meta });

export const readSidecar = (audioPath: string): Promise<SidecarMeta | null> =>
  invoke("read_sidecar", { audioPath });

export const getTakes = (baseAudioPath: string): Promise<SidecarMeta[]> =>
  invoke("get_takes", { baseAudioPath });

export interface PaletteTakeFile {
  path: string;
  sidecar: SidecarMeta | null;
}

/** Scan the palette directory on disk for all WAV files belonging to an emotion.
 *  Returns takes generated by MCP or other tools that bypass the in-memory job store. */
export const listPaletteTakes = (args: {
  projectId: string;
  characterId: string;
  emotion: string;
}): Promise<PaletteTakeFile[]> =>
  invoke("list_palette_takes", args);

export const listGeneratedAudioAssets = (projectId: string): Promise<GeneratedAudioAsset[]> =>
  invoke("list_generated_audio_assets", { projectId });

export const updateSidecarQa = (args: {
  audioPath: string;
  qaStatus: string;
  qaNotes: string;
}): Promise<void> => invoke("update_sidecar_qa", args);

// ── Audio utilities ──────────────────────────────────────────────────────────

export const getWaveformPeaks = (path: string, numPeaks: number): Promise<number[]> =>
  invoke("get_waveform_peaks", { path, numPeaks });

/** High-resolution peaks for a sub-range [startMs, endMs] of an audio file.
 *  Used by the zoomed waveform view to stay sharp at high zoom levels. */
export const getWindowPeaks = (
  path: string,
  startMs: number,
  endMs: number,
  numPeaks: number,
): Promise<number[]> =>
  invoke("get_window_peaks", { path, startMs, endMs, numPeaks });

export const getDurationMs = (path: string): Promise<number> =>
  invoke("get_duration_ms", { path });

export const findZeroCrossings = (path: string, nearMs: number): Promise<number[]> =>
  invoke("find_zero_crossings", { path, nearMs });

export const processClipAsset = (args: {
  inputPath: string;
  startMs: number;
  endMs?: number | null;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  fadeInCurve?: string;
  fadeOutCurve?: string;
  normalizeLufs?: number | null;
  highpassHz?: number | null;
  lowpassHz?: number | null;
}): Promise<string> => invoke("process_clip_asset", { params: args });

export const importAudioAsset = (args: {
  projectId: string;
  sourcePath: string;
  label?: string | null;
}): Promise<string> => invoke("import_audio_asset", { params: args });

// ── Audio engine (ffmpeg) ────────────────────────────────────────────────────

/** Normalize a clip in-place to targetLufs LUFS; returns path to .norm.wav file. */
export const normalizeClip = (path: string, targetLufs: number): Promise<string> =>
  invoke("normalize_clip", { path, targetLufs });

/** Resample a WAV file to 48 kHz stereo WAV at outputPath. */
export const resampleTo48k = (path: string, outputPath: string): Promise<void> =>
  invoke("resample_to_48k", { path, outputPath });

/** Render a scene to render.wav by mixing all placed script rows via ffmpeg filter_complex.
 *  Returns the output file path. `targetLufs` defaults to -16 (podcast/streaming). */
export const renderScene = (
  projectId: string,
  sceneSlug: string,
  targetLufs?: number,
): Promise<string> =>
  invoke("render_scene", { projectId, sceneSlug, targetLufs: targetLufs ?? null });

/** Concatenate scene render.wav files into output/final.wav with crossfades and
 *  episode-level master chain. Renders any missing scenes on demand. */
export const renderEpisode = (args: {
  projectId: string;
  crossfadeMs: number;
  targetLufs?: number;
  sceneSlugs?: string[]; // optional override; defaults to storyboard order
}): Promise<string> =>
  invoke("render_episode", {
    projectId: args.projectId,
    crossfadeMs: args.crossfadeMs,
    targetLufs: args.targetLufs ?? null,
    sceneSlugs: args.sceneSlugs ?? null,
  });

export interface RenderMeta {
  render_path: string;
  target_lufs: number;
  integrated_lufs: number;
  true_peak_dbtp: number;
  loudness_range_lu: number;
  threshold_lufs: number;
  duration_seconds: number;
  measured_at: string;
}

/** Read render.meta.json next to render.wav (written by render_scene). */
export const readRenderMeta = (renderPath: string): Promise<RenderMeta | null> =>
  invoke("read_render_meta", { renderPath });

// ── Setup integrity ─────────────────────────────────────────────────────────

export interface ToolStatus {
  ok: boolean;
  version: string | null;
  hint: string;
}
export interface SetupReport {
  ffmpeg: ToolStatus;
  sox: ToolStatus;
  render_ready: boolean;
}

/** Detect required CLI tools (ffmpeg, sox). Called once at app start so the
 *  frontend can show an install banner instead of letting the user discover
 *  a missing tool only when a render fails. */
export const checkSetup = (): Promise<SetupReport> =>
  invoke("check_setup");

// ── LLM (Anthropic) ─────────────────────────────────────────────────────────

export interface DraftSceneArgs {
  projectTitle: string;
  logline: string;
  synopsis: string;
  tone: string;
  characters: Array<{ name: string; description: string; voiceDirection?: string }>;
  sceneTitle: string;
  sceneDescription: string;
  sceneLocation: string;
  previousFountain?: string;
  model?: string;
  apiKeyEnv?: string;
}

export interface DraftSceneResult {
  fountain: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export const draftScene = (args: DraftSceneArgs): Promise<DraftSceneResult> => {
  // Translate camelCase to snake_case for the Rust struct
  const toRust = {
    project_title: args.projectTitle,
    logline: args.logline,
    synopsis: args.synopsis,
    tone: args.tone,
    characters: args.characters.map((c) => ({
      name: c.name,
      description: c.description,
      voice_direction: c.voiceDirection ?? null,
    })),
    scene_title: args.sceneTitle,
    scene_description: args.sceneDescription,
    scene_location: args.sceneLocation,
    previous_fountain: args.previousFountain ?? null,
    model: args.model ?? null,
    api_key_env: args.apiKeyEnv ?? null,
  };
  return invoke("draft_scene", { args: toRust });
};

// ── Neural audio enhancement ────────────────────────────────────────────────

export const upscaleAudioAsset = (args: {
  inputPath: string;
  jobId?: string;
  modelName: "basic" | "speech";
  ddimSteps: number;
  guidanceScale: number;
  seed: number;
}): Promise<string> => invoke("upscale_audio_asset", args);
