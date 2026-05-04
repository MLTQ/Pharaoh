import { invoke } from "@tauri-apps/api/core";
import type { Project, Scene, ScriptRow, AppConfig, AllServerHealth } from "./types";

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

export const checkServerHealth = (model: "tts" | "sfx" | "music"): Promise<ServerHealth> =>
  invoke("check_server_health", { model });

export const updateServerConfig = (cfg: {
  ttsUrl?: string;
  sfxUrl?: string;
  musicUrl?: string;
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
    steps: number;
    seed: number;
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

export const updateSidecarQa = (args: {
  audioPath: string;
  qaStatus: string;
  qaNotes: string;
}): Promise<void> => invoke("update_sidecar_qa", args);

// ── Audio utilities ──────────────────────────────────────────────────────────

export const getWaveformPeaks = (path: string, numPeaks: number): Promise<number[]> =>
  invoke("get_waveform_peaks", { path, numPeaks });

export const getDurationMs = (path: string): Promise<number> =>
  invoke("get_duration_ms", { path });

export const findZeroCrossings = (path: string, nearMs: number): Promise<number[]> =>
  invoke("find_zero_crossings", { path, nearMs });

// ── Audio engine (ffmpeg) ────────────────────────────────────────────────────

/** Normalize a clip in-place to targetLufs LUFS; returns path to .norm.wav file. */
export const normalizeClip = (path: string, targetLufs: number): Promise<string> =>
  invoke("normalize_clip", { path, targetLufs });

/** Resample a WAV file to 48 kHz stereo WAV at outputPath. */
export const resampleTo48k = (path: string, outputPath: string): Promise<void> =>
  invoke("resample_to_48k", { path, outputPath });

/** Render a scene to render.wav by mixing all placed script rows via ffmpeg filter_complex.
 *  Returns the output file path. */
export const renderScene = (projectId: string, sceneSlug: string): Promise<string> =>
  invoke("render_scene", { projectId, sceneSlug });
