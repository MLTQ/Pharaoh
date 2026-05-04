import { useProjectStore, deriveSlug } from "../store/projectStore";
import { useJobStore } from "../store/jobStore";
import { useUiStore } from "../store/uiStore";
import {
  submitTtsCustomVoice,
  submitSfxT2a,
  submitMusicText2Music,
} from "../lib/tauriCommands";
import type { Character, Job } from "../lib/types";

function now() {
  return new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function makeOutputPath(projectsDir: string, projectId: string, sceneSlug: string, filename: string) {
  return `${projectsDir}/${projectId}/scenes/${sceneSlug}/assets/${filename}`;
}

interface SubmitResult {
  jobId: string;
}

export function useGenerateJob() {
  const { realProjectId, projectsDir, activeSceneNo, activeSceneSlug, scenes } = useProjectStore();
  const { addJob } = useJobStore();
  const { triggerAgentActive } = useUiStore();

  function resolveContext(): { projectId: string; sceneSlug: string; pDir: string } {
    if (!realProjectId || !projectsDir) throw new Error("No project open — open a project first");
    const scene = scenes.find((s) => s.no === activeSceneNo) ?? scenes[0];
    if (!scene) throw new Error("No scenes in this project — add a scene first");
    const sceneSlug = activeSceneSlug ?? deriveSlug(scene.no, scene.title);
    return { projectId: realProjectId, pDir: projectsDir, sceneSlug };
  }

  async function submitTts(params: {
    text: string;
    speaker: string;
    character?: Character;
    instruct?: string;
    seed?: number;
    temperature?: number;
    rowIndex?: number;
  }): Promise<SubmitResult> {
    const { projectId, pDir, sceneSlug } = resolveContext();
    const ts = Date.now();
    const char = params.character;
    const stem = (char?.id ?? params.speaker).toLowerCase();
    const speaker = params.speaker || char?.voice_assignment.speaker || "Vivian";
    const instruct = params.instruct ?? char?.voice_assignment.instruct_default ?? "";

    const jobId = await submitTtsCustomVoice({
      projectId, sceneSlug, rowIndex: params.rowIndex ?? 0,
      params: {
        text: params.text,
        speaker,
        language: "en",
        instruct,
        seed: params.seed ?? Math.floor(Math.random() * 99999),
        temperature: params.temperature ?? 0.7,
        top_p: 0.9,
        max_new_tokens: 2048,
        output_path: makeOutputPath(pDir, projectId, sceneSlug, `${stem}_${ts}.wav`),
      },
    });

    const job: Job = {
      id: jobId,
      model: "tts",
      description: `${char?.name ?? params.speaker} · "${params.text.replace(/\[.*?\]/g, "").trim().slice(0, 45)}${params.text.length > 45 ? "…" : ""}"`,
      status: "running",
      progress: 0,
      eta: "starting",
      started_at: now(),
      scene_id: null,
      scene_slug: sceneSlug,
      row_index: params.rowIndex ?? 0,
      output_path: null,
      peaks: null,
      qa_status: "unreviewed",
      error: null,
    };
    addJob(job);
    triggerAgentActive();
    return { jobId };
  }

  async function submitSfx(params: {
    prompt: string;
    durationSeconds?: number;
    modelVariant?: string;
    steps?: number;
    seed?: number;
    rowIndex?: number;
  }): Promise<SubmitResult> {
    const { projectId, pDir, sceneSlug } = resolveContext();
    const ts = Date.now();

    const jobId = await submitSfxT2a({
      projectId, sceneSlug, rowIndex: params.rowIndex ?? 0,
      params: {
        prompt: params.prompt,
        duration_seconds: params.durationSeconds ?? 3.0,
        model_variant: params.modelVariant ?? "Woosh-DFlow",
        steps: params.steps ?? 4,
        seed: params.seed ?? Math.floor(Math.random() * 99999),
        output_path: makeOutputPath(pDir, projectId, sceneSlug, `sfx_${ts}.wav`),
      },
    });

    const job: Job = {
      id: jobId, model: "sfx",
      description: `SFX · "${params.prompt.slice(0, 50)}${params.prompt.length > 50 ? "…" : ""}"`,
      status: "running", progress: 0, eta: "starting", started_at: now(),
      scene_id: null, scene_slug: sceneSlug, row_index: params.rowIndex ?? 0,
      output_path: null, peaks: null, qa_status: "unreviewed", error: null,
    };
    addJob(job);
    triggerAgentActive();
    return { jobId };
  }

  async function submitMusic(params: {
    caption: string;
    lyrics?: string;
    durationSeconds?: number;
    bpm?: number;
    key?: string;
    seed?: number;
    rowIndex?: number;
  }): Promise<SubmitResult> {
    const { projectId, pDir, sceneSlug } = resolveContext();
    const ts = Date.now();

    const jobId = await submitMusicText2Music({
      projectId, sceneSlug, rowIndex: params.rowIndex ?? 0,
      params: {
        caption: params.caption,
        lyrics: params.lyrics ?? "",
        duration_seconds: params.durationSeconds ?? 30.0,
        bpm: params.bpm,
        key: params.key ?? "",
        language: "en",
        lm_model_size: "1.7B",
        diffusion_steps: 60,
        thinking_mode: false,
        reference_audio_path: "",
        seed: params.seed ?? Math.floor(Math.random() * 99999),
        batch_size: 1,
        output_path: makeOutputPath(pDir, projectId, sceneSlug, `music_${ts}.wav`),
      },
    });

    const job: Job = {
      id: jobId, model: "music",
      description: `Score · "${params.caption.slice(0, 50)}${params.caption.length > 50 ? "…" : ""}"`,
      status: "running", progress: 0, eta: "starting", started_at: now(),
      scene_id: null, scene_slug: sceneSlug, row_index: params.rowIndex ?? 0,
      output_path: null, peaks: null, qa_status: "unreviewed", error: null,
    };
    addJob(job);
    triggerAgentActive();
    return { jobId };
  }

  return { submitTts, submitSfx, submitMusic };
}
