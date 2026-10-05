import { useProjectStore, deriveSlug } from "../store/projectStore";
import { useJobStore } from "../store/jobStore";
import { useUiStore } from "../store/uiStore";
import { useModelStore } from "../store/modelStore";
import {
  submitTtsCustomVoice,
  submitTtsVoiceClone,
  submitChatterboxClone,
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

/**
 * How a character's lines are voiced:
 *  - "breeze"     — Breeze TTS 2 serves the TTS port: clone the gold clip (or the
 *                   line's palette reference) and perform the line's direction.
 *  - "chatterbox" — Chatterbox clone, for cloned voices when Breeze isn't installed.
 *
 * Voice lock (RVC) is separate: it runs after either engine on calm lines
 * when the character has it on (see jobStore).
 *  - "preset"     — no reference clip: the TTS server's named speaker.
 */
export type DialogueEngine = "breeze" | "chatterbox" | "preset";

export function dialogueEngine(char: Character | undefined): DialogueEngine {
  const va = char?.voice_assignment;
  if (!va?.ref_audio_path) return "preset";
  if (useModelStore.getState().health.tts?.engine === "breeze") return "breeze";
  return (va.production_pipeline ?? "chatterbox").startsWith("chatterbox") ? "chatterbox" : "preset";
}

/** The direction Breeze performs for a line: the palette emotion's written
 *  direction, plus the line's own note when it says more than the emotion's name. */
export function breezeDirection(char: Character | undefined, note: string | undefined): string {
  const n = (note ?? "").trim();
  const entry = paletteEntryFor(char, n);
  const justTheName = !!entry && (n.toLowerCase() === entry.emotion.toLowerCase() || n.toLowerCase() === entry.label.toLowerCase());
  return [justTheName ? "" : n, entry?.direction ?? ""].filter(Boolean).join(" ").trim()
    || (char?.voice_assignment.instruct_default ?? "").trim();
}

/** A character speaks in its cloned voice when it has a gold reference clip
 *  and a Chatterbox pipeline; otherwise Qwen CustomVoice's preset speaker. */
export function clonesVoice(char: Character | undefined): boolean {
  const va = char?.voice_assignment;
  return !!va?.ref_audio_path && (va.production_pipeline ?? "chatterbox").startsWith("chatterbox");
}

/**
 * The palette entry a delivery note asks for: an exact emotion key/label, or
 * a note mentioning one ("angrily, through gritted teeth" → angry). Only
 * entries with a reference count.
 */
export function paletteEntryFor(char: Character | undefined, note: string | undefined) {
  const n = (note ?? "").trim().toLowerCase();
  if (!char || !n) return undefined;
  const entries = (char.voice_assignment.emotional_palette ?? []).filter((e) => e.ref_audio_path);
  const exact = entries.find((e) => e.emotion.toLowerCase() === n || e.label.toLowerCase() === n);
  if (exact) return exact;
  // Word stems: "angrily" / "anger" ~ "angry", "sadly" ~ "sad", "afraid" ~ "afraid".
  const SYNONYMS: Record<string, string> = {
    furious: "angry", irate: "angry", annoyed: "angry", livid: "angry", rage: "angry", raging: "angry",
    terrified: "afraid", scared: "afraid", frightened: "afraid", fearful: "afraid", fearfully: "afraid", panicked: "afraid",
    joyful: "happy", cheerful: "happy", glad: "happy", delighted: "happy", cheerfully: "happy",
    sorrowful: "sad", grieving: "sad", tearful: "sad", miserable: "sad", tearfully: "sad",
    hushed: "whisper", quietly: "whisper", softly: "tender", gently: "tender", warmly: "tender",
    sarcastic: "sardonic", sarcastically: "sardonic", dry: "sardonic", dryly: "sardonic",
    thrilled: "excited", eager: "excited", eagerly: "excited",
  };
  const words = n.split(/[^a-z]+/).filter(Boolean).map((w) => SYNONYMS[w] ?? w);
  const strip = (w: string) => w.replace(/(ily|ly|ness|ed|ing|er|y)$/, "");
  const stem = (w: string) => strip(strip(w)).slice(0, 5);
  return entries.find((e) => {
    const k = stem(e.emotion.toLowerCase());
    return k.length >= 3 && words.some((w) => {
      const v = stem(w);
      return v.length >= 3 && (v.startsWith(k) || k.startsWith(v));
    });
  });
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
    topP?: number;
    maxNewTokens?: number;
    rowIndex?: number;
    /** Chatterbox only: 0–1 expressiveness (0.5 = like the reference). */
    exaggeration?: number;
    /** Chatterbox only: palette emotion (key, label, or a delivery note that
     *  names one); its reference replaces the gold clip. */
    emotion?: string;
  }): Promise<SubmitResult> {
    const { projectId, pDir, sceneSlug } = resolveContext();
    const ts = Date.now();
    const char = params.character;
    const stem = (char?.id ?? params.speaker).toLowerCase();
    const speaker = params.speaker || char?.voice_assignment.speaker || "Vivian";
    const instruct = params.instruct ?? char?.voice_assignment.instruct_default ?? "";

    const engine = dialogueEngine(char);
    const palette = engine !== "preset" ? paletteEntryFor(char, params.emotion) : undefined;
    const refPath = palette?.ref_audio_path ?? char?.voice_assignment.ref_audio_path ?? "";
    const absRef = (p: string) => (p.startsWith("/") ? p : `${pDir}/${projectId}/characters/${char!.id}/${p}`);
    const direction = engine === "breeze" ? breezeDirection(char, params.emotion ?? params.instruct) : (params.emotion ?? params.instruct ?? "");
    const jobId = char && engine === "breeze"
      ? await submitTtsVoiceClone({
          projectId, sceneSlug, rowIndex: params.rowIndex ?? 0,
          params: {
            text: params.text,  // [laugh]-style tags are translated server-side
            ref_audio_path: absRef(refPath),
            ref_transcript: (palette ? palette.ref_transcript : char.voice_assignment.ref_transcript) ?? "",
            language: "en", icl_mode: false,
            seed: params.seed ?? Math.floor(Math.random() * 99999),
            temperature: 0.7, top_p: 0.9, max_new_tokens: 2048,
            output_path: makeOutputPath(pDir, projectId, sceneSlug, `${stem}_${ts}.wav`),
            instruct: direction,
          },
        })
      : char && engine === "chatterbox"
      ? await submitChatterboxClone({
          projectId, sceneSlug, rowIndex: params.rowIndex ?? 0,
          params: {
            text: params.text,
            // Relative bundle paths live under the project's copy of the character.
            ref_audio_path: refPath.startsWith("/") ? refPath : `${pDir}/${projectId}/characters/${char.id}/${refPath}`,
            ref_transcript: (palette ? palette.ref_transcript : char.voice_assignment.ref_transcript) ?? "",
            exaggeration: params.exaggeration ?? 0.5,
            cfg_weight: 0.5,
            seed: params.seed ?? Math.floor(Math.random() * 99999),
            output_path: makeOutputPath(pDir, projectId, sceneSlug, `${stem}_${ts}.wav`),
          },
        })
      : await submitTtsCustomVoice({
      projectId, sceneSlug, rowIndex: params.rowIndex ?? 0,
      params: {
        text: params.text,
        speaker,
        language: "en",
        instruct,
        seed: params.seed ?? Math.floor(Math.random() * 99999),
        temperature: params.temperature ?? 0.7,
        top_p: params.topP ?? 0.9,
        max_new_tokens: params.maxNewTokens ?? 2048,
        output_path: makeOutputPath(pDir, projectId, sceneSlug, `${stem}_${ts}.wav`),
      },
    });

    const voiceLock = char && engine !== "preset" && char.voice_assignment.rvc?.enabled
      ? { character_id: char.id, rvc: char.voice_assignment.rvc, text: params.text, direction }
      : undefined;
    const job: Job = {
      id: jobId,
      model: "tts",
      description: `${char?.name ?? params.speaker}${palette ? ` (${palette.label})` : ""} · "${params.text.replace(/\[.*?\]/g, "").trim().slice(0, 45)}${params.text.length > 45 ? "…" : ""}"`,
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
      audiosr: !!char?.voice_assignment.audiosr,
      project_id: projectId,
      voice_lock: voiceLock,
      followups: [...(voiceLock ? ["voice lock"] : []), ...(char?.voice_assignment.audiosr ? ["AudioSR"] : [])],
    };
    addJob(job);
    triggerAgentActive();
    return { jobId };
  }

  async function submitSfx(params: {
    prompt: string;
    durationSeconds?: number;
    backend?: "woosh" | "audioldm";
    modelVariant?: string;
    steps?: number;
    seed?: number;
    cfgScale?: number;
    guidanceScale?: number;
    negativePrompt?: string;
    numWaveformsPerPrompt?: number;
    rowIndex?: number;
  }): Promise<SubmitResult> {
    const { projectId, pDir, sceneSlug } = resolveContext();
    const ts = Date.now();
    const durationSeconds = params.durationSeconds ?? 3.0;
    const backend = params.backend ?? (durationSeconds > 5 ? "audioldm" : "woosh");
    const modelVariant = params.modelVariant
      ?? (backend === "audioldm" ? "AudioLDM-M-Full" : "Woosh-DFlow");

    const jobId = await submitSfxT2a({
      projectId, sceneSlug, rowIndex: params.rowIndex ?? 0,
      params: {
        prompt: params.prompt,
        duration_seconds: durationSeconds,
        model_variant: modelVariant,
        backend,
        steps: params.steps ?? (backend === "audioldm" ? 200 : 4),
        seed: params.seed ?? Math.floor(Math.random() * 99999),
        cfg_scale: params.cfgScale ?? (backend === "woosh" ? 4.5 : undefined),
        guidance_scale: params.guidanceScale ?? (backend === "audioldm" ? 2.5 : undefined),
        negative_prompt: params.negativePrompt ?? (backend === "audioldm" ? "speech, talking, music, melody, low quality, distorted, clipped, noisy artifacts" : undefined),
        num_waveforms_per_prompt: params.numWaveformsPerPrompt ?? (backend === "audioldm" ? 1 : undefined),
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
    lmModelSize?: string;
    diffusionSteps?: number;
    thinkingMode?: boolean;
    referenceAudioPath?: string;
    batchSize?: number;
    seed?: number;
    rowIndex?: number;
    instrumental?: boolean;
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
        lm_model_size: params.lmModelSize ?? "1.7B",
        diffusion_steps: params.diffusionSteps ?? 60,
        thinking_mode: params.thinkingMode ?? false,
        reference_audio_path: params.referenceAudioPath ?? "",
        seed: params.seed ?? Math.floor(Math.random() * 99999),
        batch_size: params.batchSize ?? 1,
        output_path: makeOutputPath(pDir, projectId, sceneSlug, `music_${ts}.wav`),
        instrumental: params.instrumental ?? true,
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
