// Generate takes for a series sound cue (theme, stinger, bed…). Jobs use the
// synthetic project id "_series" and slug `__series_sound__<series>__<cue>`,
// like the character library's "_library": the backend finds no script to
// bind, so the take just lands in `_series/<id>/sound/<cue>/`.
import { prepareSeriesSoundDir, submitMusicText2Music, submitSfxT2a } from "./tauriCommands";
import { useJobStore } from "../store/jobStore";
import { useModelStore } from "../store/modelStore";
import type { Job, SoundCue } from "./types";

export const SERIES_PROJECT_ID = "_series";

export function seriesSoundSlug(seriesId: string, cueId: string): string {
  return `__series_sound__${seriesId}__${cueId}`;
}

/** Theme, stinger, bumper and music go to the music server; bed and sfx to SFX. */
export function cueEngine(cue: SoundCue): "music" | "sfx" {
  return cue.kind === "bed" || cue.kind === "sfx" ? "sfx" : "music";
}

export async function generateSeriesSound(seriesId: string, cue: SoundCue): Promise<string> {
  const dir = await prepareSeriesSoundDir(seriesId, cue.id);
  const sceneSlug = seriesSoundSlug(seriesId, cue.id);
  const output_path = `${dir}/take_${Date.now()}.wav`;
  const seed = Math.floor(Math.random() * 99999);
  const engine = cueEngine(cue);
  const prompt = cue.prompt.trim() || cue.label;
  let jobId: string;
  if (engine === "music") {
    jobId = await submitMusicText2Music({
      projectId: SERIES_PROJECT_ID, sceneSlug, rowIndex: 0,
      params: {
        caption: prompt, lyrics: "", duration_seconds: cue.duration_seconds || 15,
        key: "", language: "en", lm_model_size: "1.7B", diffusion_steps: 60,
        thinking_mode: false, reference_audio_path: "", seed, batch_size: 1,
        output_path, instrumental: true,
      },
    });
  } else {
    // Same engine choice as scene SFX: MOSS when served, else Woosh / AudioLDM by length.
    const moss = useModelStore.getState().health.sfx?.engine === "moss";
    const secs = cue.duration_seconds || (cue.kind === "bed" ? 20 : 3);
    const backend = moss ? "moss" : secs > 5 ? "audioldm" : "woosh";
    jobId = await submitSfxT2a({
      projectId: SERIES_PROJECT_ID, sceneSlug, rowIndex: 0,
      params: {
        prompt,
        duration_seconds: backend === "moss" ? Math.min(secs, 30) : secs,
        model_variant: backend === "moss" ? "MOSS-SFX-v2" : backend === "audioldm" ? "AudioLDM-M-Full" : "Woosh-DFlow",
        backend,
        steps: backend === "moss" ? 100 : backend === "audioldm" ? 200 : 4,
        seed,
        cfg_scale: backend === "woosh" ? 4.5 : undefined,
        guidance_scale: backend === "audioldm" ? 2.5 : undefined,
        negative_prompt: backend === "audioldm" ? "speech, talking, music, melody, low quality, distorted, clipped, noisy artifacts" : undefined,
        num_waveforms_per_prompt: backend === "audioldm" ? 1 : undefined,
        output_path,
      },
    });
  }
  const job: Job = {
    id: jobId, model: engine,
    description: `Series ${cue.kind} · ${cue.label || cue.id}`,
    status: "running", progress: 0, eta: "starting",
    started_at: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false }),
    scene_id: null, scene_slug: sceneSlug, row_index: 0,
    output_path: null, peaks: null, qa_status: "unreviewed", error: null,
  };
  useJobStore.getState().addJob(job);
  return jobId;
}
