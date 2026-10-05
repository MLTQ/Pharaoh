// invoke routes through transport.ts: Tauri IPC on the host, the Gruve share
// server's HTTP mirror for mesh/browser viewers. Same args, same results.
import { invoke } from "./transport";
import type {
  Project,
  EmotionRecipe,
  Scene,
  ScriptRow,
  AppConfig,
  AllServerHealth,
  GeneratedAudioAsset,
  Character,
  LibraryCharacterSummary,
  SpatialSpace,
  DissectOptions,
  DissectImport,
  DissectStatus,
  DissectImportSummary,
  EpisodeChapter,
  M4bOptions,
  RebuildOptions,
  RebuildPlan,
  RebuildStatus,
  M4bExport,
} from "./types";

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
  /** The act the scene belongs to (its row on the Pyramid). */
  act?: string;
}): Promise<Scene> => invoke("create_scene", { ...args, act: args.act ?? null });

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
    /** Breeze: natural-language direction for the delivery; makes a clone a directed take. */
    instruct?: string;
    /** Breeze: how strongly to follow the direction (default 4 with a direction). */
    cfg_scale?: number;
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
    backend?: "moss" | "woosh" | "audioldm";
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
    /** YuE2: no singing — the planned vocal line goes to an instrument. Defaults to true. */
    instrumental?: boolean;
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

// ── Audio recording (CPAL / CoreAudio) ──────────────────────────────────────

export interface AudioDevice {
  name: string;
  channels: number;
  sample_rates: number[];
  is_default: boolean;
}

export interface RecordingResult {
  path: string;
  duration_ms: number;
}

/** List all CoreAudio input devices. Default device is first. */
export const listAudioInputs = (): Promise<AudioDevice[]> =>
  invoke("list_audio_inputs");

/**
 * Open a CPAL stream on `deviceName` and start writing to `outputPath`.
 * Emits `recording:peak` events { peak_db, rms_db } ~30 Hz while recording.
 */
export const startRecording = (args: {
  deviceName: string;
  outputPath: string;
  mono: boolean;
  sampleRate: number;
}): Promise<void> =>
  invoke("start_recording", {
    deviceName: args.deviceName,
    outputPath: args.outputPath,
    mono: args.mono,
    sampleRate: args.sampleRate,
  });

/** Stop recording, finalize the WAV. Returns path + duration_ms. */
export const stopRecording = (): Promise<RecordingResult> =>
  invoke("stop_recording");

// ── RVC voice conversion ─────────────────────────────────────────────────────

/** A trained RVC model file found in characters/{id}/rvc/. */
export interface RvcModelInfo {
  name: string;
  pth_path: string;
  index_path: string | null;
  size_bytes: number;
}

/** Parameters for a single RVC conversion job. */
export interface RvcConvertParams {
  input_path: string;
  output_path: string;
  model_path: string;
  index_path: string | null;
  /** Semitones of pitch shift. Default 0. */
  pitch_shift: number;
  /** Pitch extraction method. "rmvpe" is highest quality. */
  f0_method: string;
  /** 0–1: retrieval index strength. Lower preserves paralinguistic tags. */
  index_rate: number;
  /** 0–7: median filter radius on pitch curve. Default 3. */
  filter_radius: number;
  /** 0–1: blend of input/output RMS. Default 0.25. */
  rms_mix_rate: number;
  /** 0–0.5: protection for voiceless consonants. Default 0.33. */
  protect: number;
}

/** Corpus build status returned by get_corpus_status. */
export interface CorpusStatus {
  file_count: number;
  total_duration_ms: number;
  corpus_dir: string;
  /** True when total_duration_ms >= 5 minutes (300_000 ms). */
  ready_for_training: boolean;
}

/** List trained RVC .pth models for a character. */
export const listRvcModels = (args: {
  projectId: string;
  characterId: string;
}): Promise<RvcModelInfo[]> =>
  invoke("list_rvc_models", { projectId: args.projectId, characterId: args.characterId });

/**
 * Submit a convert job to the RVC server.
 * Returns job_id immediately. Poll getRvcJob() until status === "complete".
 */
export const submitRvcConvert = (params: RvcConvertParams): Promise<string> =>
  invoke("submit_rvc_convert", { params });

/**
 * Submit a training job to the RVC server.
 * Scans characters/{characterId}/rvc_corpus/ for WAV files automatically.
 * Returns job_id. Training takes 10–20 min on GPU.
 */
export const submitRvcTrain = (args: {
  projectId: string;
  characterId: string;
  characterName: string;
  epochs?: number;
}): Promise<string> =>
  invoke("submit_rvc_train", {
    projectId: args.projectId,
    characterId: args.characterId,
    characterName: args.characterName,
    epochs: args.epochs ?? null,
  });

/** After a training job completes, fetch the model into the character's
 *  rvc/ folder (remote server). Returns the local .pth path. */
export const finishRvcTrain = (args: {
  projectId: string;
  characterId: string;
  characterName: string;
  jobId: string;
}): Promise<string> => invoke("finish_rvc_train", args);

/**
 * Voice-lock a finished take through the character's RVC model. Returns the
 * RVC job id (completion arrives as a job-complete event, model "rvc"), or
 * null when the line doesn't qualify (lock off, or an expressive line on
 * "calm" lines only).
 */
export const submitVoiceLock = (args: {
  projectId: string;
  characterId: string;
  rvc: import("./types").RvcConfig;
  inputPath: string;
  text: string;
  direction: string;
}): Promise<string | null> => invoke("submit_voice_lock", args);

/** Status of a job on the RVC server. */
export interface RvcJobResponse {
  status: "pending" | "running" | "complete" | "failed";
  /** 0..1 */
  progress: number;
  output_path: string | null;
  error: string | null;
  /** Current stage description, e.g. "Training… 42/100 steps". */
  message: string | null;
}

/** Poll a job on the RVC server. */
export const getRvcJob = (jobId: string): Promise<RvcJobResponse> =>
  invoke("get_rvc_job", { jobId });

/**
 * Count WAV files in characters/{characterId}/rvc_corpus/ and sum duration.
 * Reads duration from sidecar .meta.json files.
 */
export const getCorpusStatus = (args: {
  projectId: string;
  characterId: string;
}): Promise<CorpusStatus> =>
  invoke("get_corpus_status", { projectId: args.projectId, characterId: args.characterId });

/** One emotion's share of the RVC corpus. */
export interface EmotionCorpusCount {
  emotion: string;
  count: number;
}

/** The character's active RVC model plus the corpus it was trained from. */
export interface RvcModelDetail {
  name: string;
  pth_path: string;
  index_path: string | null;
  pth_size_bytes: number;
  /** RFC 3339 mtime of the .pth file. */
  trained_at: string;
  corpus_count: number;
  corpus_duration_ms: number;
}

/** Count corpus WAVs per emotion, to show which states are under-represented. */
export const getCorpusEmotionCounts = (args: {
  projectId: string;
  characterId: string;
}): Promise<EmotionCorpusCount[]> =>
  invoke("get_corpus_emotion_counts", {
    projectId: args.projectId,
    characterId: args.characterId,
  });

/** Delete every corpus WAV and sidecar. Returns the number removed. */
export const clearCorpus = (args: {
  projectId: string;
  characterId: string;
}): Promise<number> =>
  invoke("clear_corpus", { projectId: args.projectId, characterId: args.characterId });

/** The character's trained RVC model, or null if not trained yet. */
export const getRvcModelInfo = (args: {
  projectId: string;
  characterId: string;
}): Promise<RvcModelDetail | null> =>
  invoke("get_rvc_model_info", {
    projectId: args.projectId,
    characterId: args.characterId,
  });

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

// ── Character library ───────────────────────────────────────────────────────
//
// Library lives at <projects_dir>/_library/characters/<library_id>/ and uses
// the same bundle layout as in-project characters. Fork-and-pull sync model:
// import = copy library → project, save = copy project → library. Each project
// character carries library_id + library_version so a future drift indicator
// (Pharaoh-wpk) can flag divergence.

export const listLibraryCharacters = (): Promise<LibraryCharacterSummary[]> =>
  invoke("list_library_characters");

export const saveCharacterToLibrary = (args: {
  projectId: string;
  characterId: string;
}): Promise<LibraryCharacterSummary> =>
  invoke("save_character_to_library", args);

export const importCharacterFromLibrary = (args: {
  projectId: string;
  libraryId: string;
  /** Optional override for the project-local character name (e.g. "Alex (Younger)"). */
  newName?: string;
}): Promise<Character> =>
  invoke("import_character_from_library", args);

export const deleteLibraryCharacter = (libraryId: string): Promise<void> =>
  invoke("delete_library_character", { libraryId });

export const getLibraryCharacter = (libraryId: string): Promise<Character> =>
  invoke("get_library_character", { libraryId });

/**
 * Create or update a library character directly (no project context).
 * If `character.library_id` is null/undefined, the backend allocates a new
 * UUID. Always returns the saved Character with `library_id` + `library_version`
 * set and paths absolutized.
 */
export const saveLibraryCharacter = (character: Character): Promise<Character> =>
  invoke("save_library_character", { character });

/**
 * Pull the canonical library version into a project, overwriting the project
 * character's bundle and inline record. The project-local `id` is preserved
 * (so script.csv rows stay valid). Destructive — callers must confirm intent.
 *
 * Errors if the character has no `library_id` or the library entry no longer
 * exists.
 */
export const pullCharacterFromLibrary = (args: {
  projectId: string;
  characterId: string;
}): Promise<Character> =>
  invoke("pull_character_from_library", args);

// ── Character file export/import (Pharaoh-tlt4) ────────────────────────────

export interface CharacterExportResult {
  output_path: string;
  bytes: number;
  file_count: number;
}

/**
 * Package a library character into a single `.pharaoh-character` file (zip).
 * - `include_corpus = false` (default) excludes the raw RVC training WAVs
 *   to keep file size manageable; the trained RVC model + index are always
 *   included.
 */
export const exportLibraryCharacter = (args: {
  libraryId: string;
  outputPath: string;
  includeCorpus: boolean;
}): Promise<CharacterExportResult> =>
  invoke("export_library_character", args);

/**
 * Import a `.pharaoh-character` file into the local library. Always allocates
 * a fresh `library_id` — never replaces an existing local entry. Returns the
 * new library summary so the UI can select it.
 */
export const importLibraryCharacterFromFile = (filePath: string): Promise<LibraryCharacterSummary> =>
  invoke("import_library_character_from_file", { filePath });

export interface ImportedAudioPath {
  absolute_path: string;
}

/**
 * Copy an external audio file into a library character's bundle so the file
 * lives alongside generated content (paths inside the bundle are relative,
 * so the character stays portable).
 *
 * Use cases:
 *   - clone-from-file as the character's single voice reference (slot="design")
 *   - clone-from-file as a specific emotion's palette reference (slot="palette",
 *     dest_name="<emotion>.wav")
 *   - generic recording import (slot="imports")
 */
export const importAudioIntoLibraryBundle = (args: {
  libraryId: string;
  sourcePath: string;
  slot: "design" | "palette" | "imports";
  destName: string;
}): Promise<ImportedAudioPath> =>
  invoke("import_audio_into_library_bundle", args);

/**
 * Concatenate multiple audio files into a single normalized WAV inside the
 * library bundle. N=1 is a fast-path copy; N>=2 uses ffmpeg's concat filter.
 * A `<dest>.sources.json` sidecar is written next to the output for provenance.
 */
export const concatAudioIntoLibraryBundle = (args: {
  libraryId: string;
  sourcePaths: string[];
  slot: "design" | "palette" | "imports";
  destName: string;
}): Promise<ImportedAudioPath> =>
  invoke("concat_audio_into_library_bundle", args);

export interface CorpusImportResult {
  copied_count: number;
  skipped_count: number;
  total_duration_ms: number;
  corpus_dir: string;
}

/**
 * Bulk-import real audio recordings into a library character's RVC corpus.
 * Each file is normalized to 48kHz mono 16-bit WAV. Files that fail to
 * convert are skipped (counted, not fatal). Use case: training RVC on real
 * actor recordings.
 */
export const importAudioFilesIntoCorpus = (args: {
  libraryId: string;
  sourcePaths: string[];
}): Promise<CorpusImportResult> =>
  invoke("import_audio_files_into_corpus", args);

// ── Spatial spaces (room IR catalog) ─────────────────────────────────────────

/**
 * List the curated room presets from `assets/spaces/spaces.json`, each
 * stamped with `available` based on whether its IR file is on disk.
 * Frontend renders this as the SpatializeModal's Space dropdown — entries
 * with `available=false` show up greyed with a hint to run
 * `inference/download_spatial_assets.sh`.
 */
export const listSpatialSpaces = (): Promise<SpatialSpace[]> =>
  invoke("list_spatial_spaces");

// ── Dissect: voices from an existing recording ──────────────────────────────

/** Start separating + diarizing a recording. Poll `dissectStatus` with the returned import id. */
export const dissectSubmit = (sourcePath: string, options?: DissectOptions): Promise<DissectImport> =>
  invoke("dissect_submit", { sourcePath, options: options ?? null });

export const dissectStatus = (importId: string): Promise<DissectStatus> =>
  invoke("dissect_status", { importId });

/** Stop a running import (the server stops at its next checkpoint). */
export const dissectCancel = (importId: string): Promise<DissectImport> =>
  invoke("dissect_cancel", { importId });

/** Re-run a failed or cancelled import in place with its original options. */
export const dissectRetry = (importId: string): Promise<DissectImport> =>
  invoke("dissect_retry", { importId });

/** Audition file for a span of a stem (cut on demand, cached per import). */
export const dissectClip = (importId: string, stem: string, start: number, end: number): Promise<string> =>
  invoke("dissect_clip", { importId, stem, start, end });

export interface EmotionClip {
  speaker: string; start: number; end: number; text: string;
  /** Recipe score, or cosine similarity for "more like this". */
  fit: number;
  top: string; top_score: number;
  scores: Record<string, number>;
  /** Share of the reader's belief on the seven classes; low = it couldn't tell. */
  clarity: number;
  /** Delivery against the character's average: "loud", "slow", "breathy"… */
  traits: string[];
  /** A clear example of the recipe, not merely its best available match. */
  strong: boolean;
}
export interface EmotionClips {
  tagged: boolean;
  /** Tagged before delivery features existed: re-read for recipes' delivery targets and "more like this". */
  needs_update: boolean;
  recipe: EmotionRecipe | null;
  clips: EmotionClip[];
  utterances: number;
}
export interface EmotionJobStatus { import_id: string; done: boolean; progress: number; message: string; error: string | null }

/** Tag an import's dialogue with emotions (imports dissected before tagging existed). Returns a job id. */
export const dissectTagEmotions = (importId: string): Promise<string> =>
  invoke("dissect_tag_emotions", { importId });
export const dissectEmotionStatus = (jobId: string): Promise<EmotionJobStatus> =>
  invoke("dissect_emotion_status", { jobId });
/** A character's best real clips for a palette emotion (its recipe, or the built-in one for its name). */
export const dissectEmotionClips = (importId: string, speakerIds: string[], emotion: string, recipe?: EmotionRecipe | null, limit?: number): Promise<EmotionClips> =>
  invoke("dissect_emotion_clips", { importId, speakerIds, emotion, recipe: recipe ?? null, limit });
/** The character's clips whose delivery is most like the one starting at `start`. */
export const dissectSimilarClips = (importId: string, speakerIds: string[], start: number, limit?: number): Promise<EmotionClip[]> =>
  invoke("dissect_similar_clips", { importId, speakerIds, start, limit });

export interface PaletteFill { emotion: string; added: number; found: number; gold_set: boolean; best_text: string }
export interface PaletteBuild { filled: PaletteFill[]; missing: string[]; approved: number; untagged: string[] }
/** Fill a Library character's emotional palette from its dissected performance (saves it). */
export const buildPaletteFromRecording = (libraryId: string, replaceGold?: boolean, perEmotion?: number): Promise<{ report: PaletteBuild; character: import("./types").Character }> =>
  invoke("build_palette_from_recording", { libraryId, replaceGold: replaceGold ?? false, perEmotion });

export interface CorpusFromRecording { added: number; skipped: number; seconds: number; by_emotion: Record<string, number>; untagged: string[] }
/** Fill a character's RVC corpus with its own clean lines from its dissected recording(s). */
export const corpusFromDissect = (projectId: string, characterId: string, minutes?: number): Promise<CorpusFromRecording> =>
  invoke("corpus_from_dissect", { projectId, characterId, minutes });

/** The transcript belonging to a reference clip (sidecar or Dissect manifest), or null when unknown. */
export const referenceTranscript = (clipPath: string): Promise<string | null> =>
  invoke("reference_transcript", { clipPath });

/** Copy a found sound into a scene's assets (sidecar-indexed WAV). Returns its path. */
export const dissectExtractSound = (request: {
  import_id: string;
  stem: string;
  start: number;
  end: number;
  name: string;
  kind: string;
  project_id: string;
  scene_slug: string;
  labels?: string[];
}): Promise<string> => invoke("dissect_extract_sound", { request });

export const listDissectImports = (): Promise<DissectImportSummary[]> =>
  invoke("list_dissect_imports");

export const deleteDissectImport = (importId: string): Promise<void> =>
  invoke("delete_dissect_import", { importId });

/**
 * Copy a speaker's chosen clips into a Library character (existing via
 * `library_id`, or new via `new_name`). Rejected unless `rights_confirmed`.
 */
export const dissectAssignSpeaker = (request: {
  import_id: string;
  speaker_id: string;
  candidate_ids: string[];
  gold_candidate_id?: string | null;
  library_id?: string | null;
  new_name?: string | null;
  rights_confirmed: boolean;
  rights_statement?: string | null;
  performer?: string | null;
}): Promise<Character> => invoke("dissect_assign_speaker", { request });

// ── Audiobook (.m4b) export ──────────────────────────────────────────────────

/** Chapters (one per scene) the next .m4b export will write, from the last episode render. */
export const getEpisodeChapters = (projectId: string): Promise<EpisodeChapter[]> =>
  invoke("get_episode_chapters", { projectId });

/** The project's remembered cover image, if one has been set. */
export const getProjectCover = (projectId: string): Promise<string | null> =>
  invoke("get_project_cover", { projectId });

/** Encode output/final.wav as a chaptered .m4b audiobook with tags and cover art. */
export const exportEpisodeM4b = (args: {
  projectId: string;
  outputPath: string;
  options?: M4bOptions;
}): Promise<M4bExport> =>
  invoke("export_episode_m4b", { projectId: args.projectId, outputPath: args.outputPath, options: args.options ?? null });

// ── Rebuild: dissected recording → project ──────────────────────────────────

/** What a rebuild would create (scenes, characters, rows, disk) — no side effects. */
export const dissectRebuildPlan = (importId: string, options?: RebuildOptions): Promise<RebuildPlan> =>
  invoke("dissect_rebuild_plan", { importId, options: options ?? null });

/** Start building a project from a finished import. Returns a job id for `dissectRebuildStatus`. */
export const dissectRebuildStart = (importId: string, options: RebuildOptions): Promise<string> =>
  invoke("dissect_rebuild_start", { importId, options });

export const dissectRebuildStatus = (jobId: string): Promise<RebuildStatus> =>
  invoke("dissect_rebuild_status", { jobId });

// ── Scene layout ─────────────────────────────────────────────────────────────

/** What `layout_scene_rows` did. */
export interface LayoutReport {
  placed: number;
  kept: number;
  /** Rows with no audio yet (generate them first). */
  missing_audio: number;
  scene_ms: number;
}

/**
 * Place a scene's generated rows on the timeline in script order: lines with
 * a short gap, effects where cued, beds under the scene (looped), music from
 * its cue. Rows already placed keep their place unless `replace`.
 */
export const layoutSceneRows = (args: { projectId: string; sceneSlug: string; replace?: boolean }): Promise<LayoutReport> =>
  invoke("layout_scene_rows", { projectId: args.projectId, sceneSlug: args.sceneSlug, replace: args.replace ?? false });

// ── Takes of a line ──────────────────────────────────────────────────────────

/** One take of a script line: a generation plus the versions made from it. */
export interface RowTake {
  key: string;
  /** The version that would be placed (newest in the group). */
  path: string;
  versions: string[];
  model: string;
  seed: number | null;
  instruct: string | null;
  qa_notes: string;
  generated_at: string | null;
  rating: number | null;
  in_use: boolean;
}

/** Every take of a row on disk (older sessions included). */
export const rowTakes = (args: { projectId: string; sceneSlug: string; rowIndex: number }): Promise<RowTake[]> =>
  invoke("row_takes", args);

/** Rate a take 1–5 (null clears). Stored in the scene's take_ratings.json. */
export const rateTake = (args: { projectId: string; sceneSlug: string; key: string; rating: number | null }): Promise<void> =>
  invoke("rate_take", args);

// ── Cast housekeeping ────────────────────────────────────────────────────────

/** An unnamed rebuild voice and the named character from the same dissected speaker. */
export interface CastMatch {
  from_id: string;
  from_name: string;
  into_id: string;
  into_name: string;
  speaker_id: string;
  lines: number;
}

export interface MergeReport {
  rows_moved: number;
  scenes_touched: number;
  merged: string[];
}

export const castMatches = (projectId: string): Promise<CastMatch[]> =>
  invoke("cast_matches", { projectId });

/** Move every line of `fromIds` onto `intoId` and remove the merged characters. */
export const mergeCharacters = (args: { projectId: string; fromIds: string[]; intoId: string }): Promise<MergeReport> =>
  invoke("merge_characters", args);

export const exportCastPack = (args: { projectId: string; characterIds: string[]; outputPath: string; includeCorpus?: boolean }): Promise<{ characters: string[]; bytes: number }> =>
  invoke("export_cast_pack", { ...args, includeCorpus: args.includeCorpus ?? false });

/** Add a .pharaoh-cast pack's characters to a project (clashing names get "(2)"). */
export const importCastPack = (args: { projectId: string; filePath: string }): Promise<import("./types").Character[]> =>
  invoke("import_cast_pack", args);

export interface CastImportReport {
  added: { id: string; name: string; file: string }[];
  failed: { file: string; error: string }[];
}

/** Import several .pharaoh-cast packs and/or .pharaoh-character files into a
 *  project at once. Single characters also land in the Library, linked. */
export const importCastFiles = (args: { projectId: string; filePaths: string[] }): Promise<CastImportReport> =>
  invoke("import_cast_files", args);

// ── Prose → script ──────────────────────────────────────────────────────────

export interface ProseScriptStats {
  scenes: number;
  narration_lines: number;
  dialogue_lines: number;
  intros_added: number;
  tags_named: number;
  cues: number;
  speakers: string[];
  unknown: number;
}

export interface ProseScriptResult {
  fountain: string;
  stats: ProseScriptStats;
  /** "claude" or "heuristic". */
  mode: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  /** Speakers not in the cast; importing creates them. */
  new_characters: string[];
  /** Why Claude wasn't used, if it was asked for. */
  note: string | null;
}

/** A prose chapter as a Fountain script: narration, dialogue, cues, and the
 *  narrator naming each voice after its first line in a scene. */
export const proseToScript = (args: {
  text: string;
  cast: { name: string; description: string }[];
  narrator?: string;
  intros?: boolean;
  heuristic?: boolean;
  model?: string;
  apiKeyEnv?: string;
}): Promise<ProseScriptResult> =>
  invoke("prose_to_script", {
    args: {
      text: args.text,
      cast: args.cast,
      narrator: args.narrator ?? null,
      intros: args.intros ?? true,
      heuristic: args.heuristic ?? false,
      model: args.model ?? null,
      api_key_env: args.apiKeyEnv ?? null,
    },
  });

/** Add a Fountain script's scenes (and new speakers) to a project. */
export const importScriptText = (args: { projectId: string; fountain: string; dryRun?: boolean }): Promise<{
  scenes_added?: { id: string; slug: string; title: string; rows: number }[];
  characters_added?: { id: string; name: string }[];
}> => invoke("import_script_text", { projectId: args.projectId, fountain: args.fountain, dryRun: args.dryRun ?? false });
