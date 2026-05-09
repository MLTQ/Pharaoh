import React, { useEffect, useMemo, useState } from "react";
import { Icon, PeaksWave, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { RichDirector, SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import { deriveSlug, useProjectStore } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import { listGeneratedAudioAssets } from "../../lib/tauriCommands";
import { usePeaksStore } from "../../store/peaksStore";
import type { GeneratedAudioAsset, Job, MockScene } from "../../lib/types";

const AUDIO_LDM_NEGATIVE = "speech, talking, music, melody, low quality, distorted, clipped, noisy artifacts";

const WOOOSH_VARIANTS = [
  { id: "Woosh-DFlow", label: "Woosh-DFlow" },
];

const AUDIOLDM_VARIANTS = [
  { id: "AudioLDM-M-Full", label: "AudioLDM-M-Full · upstream default" },
  { id: "AudioLDM-S-Full-V2", label: "AudioLDM-S-Full-V2 · smaller" },
  { id: "AudioLDM-S-Full", label: "AudioLDM-S-Full" },
  { id: "AudioLDM-L-Full", label: "AudioLDM-L-Full" },
  { id: "AudioLDM-M-Text-FT", label: "AudioLDM-M-Text-FT" },
  { id: "AudioLDM-S-Text-FT", label: "AudioLDM-S-Text-FT" },
];

interface SFXPanelProps {
  scenes: MockScene[];
  defaultScene: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function selectedSlug(sceneNo: string, scenes: MockScene[]): string | null {
  const scene = scenes.find((s) => s.no === sceneNo);
  if (!scene) return null;
  return scene.slug ?? deriveSlug(scene.no, scene.title);
}

function nowSeed(): number {
  return Math.floor(Math.random() * 99999);
}

function formatDuration(ms: number | null): string {
  if (!ms) return "--:--";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function NumberControl({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        <span className="hint">{hint}</span>
      </div>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function GeneratedJobRow({ job, index }: { job: Job; index: number }) {
  const running = job.status === "running" || job.status === "pending";
  const failed = job.status === "failed";
  return (
    <div style={{
      border: "1px solid var(--line-1)",
      background: "var(--bg-2)",
      borderRadius: 2,
      padding: 12,
      display: "grid",
      gridTemplateColumns: "84px 1fr auto",
      gap: 12,
      alignItems: "center",
    }}>
      <div>
        {job.peaks ? (
          <PeaksWave peaks={job.peaks} width={84} height={28} color="var(--sfx)" opacity={0.85} />
        ) : (
          <Wave width={84} height={28} seed={job.id.charCodeAt(0)} count={24} color="var(--sfx)" opacity={running ? 0.45 : 0.75} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
          <span>take {index + 1}</span>
          <span>·</span>
          <span>{job.status}</span>
          {running && <span style={{ color: "var(--sfx)" }}>{Math.round(job.progress)}%</span>}
        </div>
        <div style={{ marginTop: 4, fontSize: 11.5, color: failed ? "var(--sfx)" : "var(--fg-1)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }} title={failed ? job.error ?? undefined : job.description}>
          {failed ? `failed - ${job.error ?? "unknown error"}` : job.description}
        </div>
      </div>
      {!running && !failed && <PlayButton path={job.output_path} size={12} />}
    </div>
  );
}

function GeneratedAssetRow({ asset, peaks }: { asset: GeneratedAudioAsset; peaks: number[] | undefined }) {
  return (
    <div style={{
      border: "1px solid var(--line-1)",
      background: "var(--bg-2)",
      borderRadius: 2,
      padding: 12,
      display: "grid",
      gridTemplateColumns: "84px 1fr auto",
      gap: 12,
      alignItems: "center",
    }}>
      <div>
        {peaks ? (
          <PeaksWave peaks={peaks} width={84} height={28} color="var(--sfx)" opacity={0.85} />
        ) : (
          <Wave width={84} height={28} seed={asset.name.charCodeAt(0)} count={24} color="var(--sfx)" opacity={0.75} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: "var(--fg-1)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }} title={asset.audio_path}>
          {basename(asset.audio_path)}
        </div>
        <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", textTransform: "uppercase" }}>
          {asset.model} · {formatDuration(asset.duration_ms)}
        </div>
      </div>
      <PlayButton path={asset.audio_path} size={12} />
    </div>
  );
}

export const SFXPanel: React.FC<SFXPanelProps> = ({ scenes, defaultScene }) => {
  const [scene, setScene] = useState(defaultScene);
  const [value, setValue] = useState("");
  const [duration, setDuration] = useState(3.0);
  const [backend, setBackend] = useState<"woosh" | "audioldm">("woosh");
  const [modelVariant, setModelVariant] = useState("Woosh-DFlow");
  const [steps, setSteps] = useState(4);
  const [seed, setSeed] = useState(nowSeed());
  const [cfgScale, setCfgScale] = useState(4.5);
  const [guidanceScale, setGuidanceScale] = useState(2.5);
  const [numWaveforms, setNumWaveforms] = useState(1);
  const [negativePrompt, setNegativePrompt] = useState(AUDIO_LDM_NEGATIVE);
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAudioAsset[]>([]);
  const [assetPeaks, setAssetPeaks] = useState<Record<string, number[]>>({});
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { submitSfx } = useGenerateJob();
  const { jobs } = useJobStore();
  const { realProjectId, setActiveScene } = useProjectStore();

  const sceneSlug = selectedSlug(scene, scenes);
  const sceneJobs = useMemo(
    () => jobs
      .filter((j) => j.model === "sfx" && j.scene_slug === sceneSlug)
      .reverse(),
    [jobs, sceneSlug],
  );
  const completedJobPaths = new Set(sceneJobs.map((j) => j.output_path).filter(Boolean));
  const persistedOnly = generatedAssets.filter((asset) => !completedJobPaths.has(asset.audio_path));

  useEffect(() => {
    setScene(defaultScene);
  }, [defaultScene]);

  // Stable signature: only changes when an SFX job for this scene settles.
  const completedJobsKey = useMemo(
    () => jobs
      .filter((j) => j.scene_slug === sceneSlug && j.model === "sfx" && (j.status === "complete" || j.status === "failed"))
      .map((j) => `${j.id}:${j.status}`)
      .join("|"),
    [jobs, sceneSlug],
  );

  useEffect(() => {
    if (!realProjectId || !sceneSlug) return;
    listGeneratedAudioAssets(realProjectId)
      .then((assets) => {
        setGeneratedAssets(assets.filter((asset) => {
          const model = asset.model.toLowerCase();
          return asset.kind === "sfx"
            && asset.scene_slug === sceneSlug
            && (model.startsWith("woosh") || model.startsWith("audioldm"));
        }));
      })
      .catch(() => {});
  }, [realProjectId, sceneSlug, completedJobsKey]);

  const fetchPeaks = usePeaksStore((s) => s.fetchPeaks);
  useEffect(() => {
    for (const asset of generatedAssets) {
      if (assetPeaks[asset.audio_path]) continue;
      fetchPeaks(asset.audio_path, 84)
        .then((peaks) => setAssetPeaks((prev) => ({ ...prev, [asset.audio_path]: peaks })))
        .catch(() => {});
    }
  }, [generatedAssets, assetPeaks, fetchPeaks]);

  const chooseScene = (next: string) => {
    setScene(next);
    setActiveScene(next);
  };

  const chooseBackend = (next: "woosh" | "audioldm") => {
    setBackend(next);
    if (next === "audioldm") {
      setDuration(Math.max(duration, 10));
      setSteps(200);
      setModelVariant("AudioLDM-M-Full");
    } else {
      setDuration(Math.min(duration, 5));
      setSteps(4);
      setModelVariant("Woosh-DFlow");
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    setActiveScene(scene);
    try {
      await submitSfx({
        prompt: value,
        durationSeconds: duration,
        backend,
        modelVariant,
        steps,
        seed,
        cfgScale: backend === "woosh" ? cfgScale : undefined,
        guidanceScale: backend === "audioldm" ? guidanceScale : undefined,
        negativePrompt: backend === "audioldm" ? negativePrompt : undefined,
        numWaveformsPerPrompt: backend === "audioldm" ? numWaveforms : undefined,
      });
      setSeed(nowSeed());
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="panel-view">
      <div className="panel-main">
        <div className="panel-header">
          <div className="panel-header-left">
            <span className="eyebrow sfx">sfx-v3 · {backend === "audioldm" ? "audioldm soundscape" : "woosh foley"}</span>
            <span className="ttl">Sound Design</span>
            <span className="desc">
              Use Woosh for short, sharp foley. Use AudioLDM for long ambiences and minute-scale soundscapes.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button
              className="btn"
              style={{ borderColor: "var(--sfx-d)", color: "var(--sfx)", background: "color-mix(in oklch, var(--sfx) 10%, transparent)" }}
              onClick={handleGenerate}
              disabled={generating || !value.trim()}
            >
              <Icon name="sparkle" style={{ width: 14, height: 14 }} />
              {generating ? "Submitting..." : `Generate · ${duration.toFixed(1)}s`}
            </button>
            {genError && <span style={{ fontSize: 10, color: "var(--sfx)", maxWidth: 240, textAlign: "right" }}>{genError}</span>}
          </div>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={chooseScene} accent="var(--sfx)" onSend={() => setActiveScene(scene)} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · prompt</div>
        <RichDirector value={value} setValue={setValue} accent="var(--sfx)" />

        <div className="field-row" style={{ marginTop: 18 }}>
          <div className="field">
            <div className="field-label">
              <span>Backend</span>
              <span className="hint">{backend === "audioldm" ? "long ambience" : "short foley"}</span>
            </div>
            <select className="input" value={backend} onChange={(e) => chooseBackend(e.target.value as "woosh" | "audioldm")}>
              <option value="woosh">Woosh · short foley</option>
              <option value="audioldm">AudioLDM · long soundscape</option>
            </select>
          </div>
          <div className="field">
            <div className="field-label">
              <span>Model</span>
              <span className="hint">{backend === "audioldm" ? "checkpoint" : "flow model"}</span>
            </div>
            <select className="input" value={modelVariant} onChange={(e) => setModelVariant(e.target.value)}>
              {(backend === "audioldm" ? AUDIOLDM_VARIANTS : WOOOSH_VARIANTS).map((variant) => (
                <option key={variant.id} value={variant.id}>{variant.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <NumberControl label="Duration" hint={backend === "woosh" ? "best under 5s" : "supports long beds"} min={backend === "audioldm" ? 5 : 0.5} max={backend === "audioldm" ? 300 : 8} step={0.5} value={duration} onChange={(next) => setDuration(next || 1)} />
          <NumberControl label="Steps" hint={backend === "audioldm" ? "DDIM steps" : "Euler steps"} min={1} max={backend === "audioldm" ? 400 : 16} step={1} value={steps} onChange={(next) => setSteps(Math.max(1, Math.floor(next || 1)))} />
          <div className="field">
            <div className="field-label">
              <span>Seed</span>
              <span className="hint">deterministic</span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input className="input" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
              <button className="btn btn-sm" onClick={() => setSeed(nowSeed())}>roll</button>
            </div>
          </div>
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          {backend === "woosh" ? (
            <NumberControl label="CFG scale" hint="prompt strength" min={0} max={12} step={0.1} value={cfgScale} onChange={(next) => setCfgScale(next || 0)} />
          ) : (
            <>
              <NumberControl label="Guidance" hint="prompt strength" min={1} max={12} step={0.1} value={guidanceScale} onChange={(next) => setGuidanceScale(next || 1)} />
              <NumberControl label="Candidates" hint="CUDA ranks >1" min={1} max={4} step={1} value={numWaveforms} onChange={(next) => setNumWaveforms(Math.max(1, Math.floor(next || 1)))} />
            </>
          )}
        </div>

        {backend === "audioldm" && (
          <div style={{ marginTop: 12 }}>
            <div className="field-label" style={{ marginBottom: 6 }}>
              <span>Negative prompt</span>
              <span className="hint">AudioLDM only</span>
            </div>
            <textarea
              className="textarea"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              style={{ minHeight: 62, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5 }}
            />
          </div>
        )}

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Generated for {sceneSlug ?? "scene"} · {sceneJobs.length + persistedOnly.length}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sceneJobs.map((job, i) => <GeneratedJobRow key={job.id} job={job} index={i} />)}
          {persistedOnly.map((asset) => <GeneratedAssetRow key={asset.audio_path} asset={asset} peaks={assetPeaks[asset.audio_path]} />)}
          {sceneJobs.length === 0 && persistedOnly.length === 0 && (
            <div style={{
              padding: 24,
              textAlign: "center",
              border: "1px dashed var(--line-2)",
              borderRadius: "var(--r)",
              fontSize: 11,
              color: "var(--fg-4)",
              lineHeight: 1.6,
            }}>
              No SFX takes generated for this scene yet.
            </div>
          )}
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section">
          <h3>Parameter map</h3>
          <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.65 }}>
            Woosh uses duration, steps, seed, and CFG scale. AudioLDM uses duration, model, DDIM steps, guidance, seed, candidate count, and negative prompt.
          </div>
        </div>
        <div className="panel-side-section">
          <h3>Backend notes</h3>
          <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.65 }}>
            AudioLDM native rounds duration to 2.5 second increments. Candidate ranking requires CUDA; on CPU or Apple Silicon the server forces one candidate.
          </div>
        </div>
      </div>
    </div>
  );
};
