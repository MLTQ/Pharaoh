import React, { useEffect, useMemo, useState } from "react";
import { Icon, PeaksWave, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { RichDirector, SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import { deriveSlug, useProjectStore } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import { getWaveformPeaks, listGeneratedAudioAssets } from "../../lib/tauriCommands";
import type { GeneratedAudioAsset, Job, MockScene } from "../../lib/types";

interface MusicPanelProps {
  scenes: MockScene[];
  defaultScene: string;
}

function selectedSlug(sceneNo: string, scenes: MockScene[]): string | null {
  const scene = scenes.find((s) => s.no === sceneNo);
  if (!scene) return null;
  return scene.slug ?? deriveSlug(scene.no, scene.title);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
      <input className="input" type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function MusicJobRow({ job, index }: { job: Job; index: number }) {
  const running = job.status === "running" || job.status === "pending";
  const failed = job.status === "failed";
  return (
    <div style={{ border: "1px solid var(--line-1)", background: "var(--bg-2)", borderRadius: 2, padding: 12, display: "grid", gridTemplateColumns: "92px 1fr auto", gap: 12, alignItems: "center" }}>
      <div>
        {job.peaks ? (
          <PeaksWave peaks={job.peaks} width={92} height={30} color="var(--music)" opacity={0.85} />
        ) : (
          <Wave width={92} height={30} seed={job.id.charCodeAt(0)} count={28} color="var(--music)" opacity={running ? 0.45 : 0.75} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
          <span>cue {index + 1}</span>
          <span>·</span>
          <span>{job.status}</span>
          {running && <span style={{ color: "var(--music)" }}>{Math.round(job.progress)}%</span>}
        </div>
        <div style={{ marginTop: 4, fontSize: 11.5, color: failed ? "var(--sfx)" : "var(--fg-1)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }} title={failed ? job.error ?? undefined : job.description}>
          {failed ? `failed - ${job.error ?? "unknown error"}` : job.description}
        </div>
      </div>
      {!running && !failed && <PlayButton path={job.output_path} size={12} />}
    </div>
  );
}

function MusicAssetRow({ asset, peaks }: { asset: GeneratedAudioAsset; peaks: number[] | undefined }) {
  return (
    <div style={{ border: "1px solid var(--line-1)", background: "var(--bg-2)", borderRadius: 2, padding: 12, display: "grid", gridTemplateColumns: "92px 1fr auto", gap: 12, alignItems: "center" }}>
      <div>
        {peaks ? (
          <PeaksWave peaks={peaks} width={92} height={30} color="var(--music)" opacity={0.85} />
        ) : (
          <Wave width={92} height={30} seed={asset.name.charCodeAt(0)} count={28} color="var(--music)" opacity={0.7} />
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

export const MusicPanel: React.FC<MusicPanelProps> = ({ scenes, defaultScene }) => {
  const [scene, setScene] = useState(defaultScene);
  const [caption, setCaption] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [duration, setDuration] = useState(30);
  const [bpm, setBpm] = useState(90);
  const [keySig, setKeySig] = useState("");
  const [lmModelSize, setLmModelSize] = useState("1.7B");
  const [diffusionSteps, setDiffusionSteps] = useState(60);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [referenceAudioPath, setReferenceAudioPath] = useState("");
  const [batchSize, setBatchSize] = useState(1);
  const [seed, setSeed] = useState(Math.floor(Math.random() * 99999));
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAudioAsset[]>([]);
  const [assetPeaks, setAssetPeaks] = useState<Record<string, number[]>>({});
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { submitMusic } = useGenerateJob();
  const { jobs } = useJobStore();
  const { realProjectId, setActiveScene } = useProjectStore();

  const sceneSlug = selectedSlug(scene, scenes);
  const sceneJobs = useMemo(
    () => jobs.filter((j) => j.model === "music" && j.scene_slug === sceneSlug).reverse(),
    [jobs, sceneSlug],
  );
  const completedJobPaths = new Set(sceneJobs.map((j) => j.output_path).filter(Boolean));
  const persistedOnly = generatedAssets.filter((asset) => !completedJobPaths.has(asset.audio_path));

  useEffect(() => {
    setScene(defaultScene);
  }, [defaultScene]);

  useEffect(() => {
    if (!realProjectId || !sceneSlug) return;
    listGeneratedAudioAssets(realProjectId)
      .then((assets) => {
        setGeneratedAssets(assets.filter((asset) =>
          asset.kind === "music"
          && asset.scene_slug === sceneSlug
          && asset.model.toLowerCase().startsWith("ace-step")
        ));
      })
      .catch(() => {});
  }, [realProjectId, sceneSlug, jobs]);

  useEffect(() => {
    for (const asset of generatedAssets) {
      if (assetPeaks[asset.audio_path]) continue;
      getWaveformPeaks(asset.audio_path, 120)
        .then((peaks) => setAssetPeaks((prev) => ({ ...prev, [asset.audio_path]: peaks })))
        .catch(() => {});
    }
  }, [generatedAssets, assetPeaks]);

  const chooseScene = (next: string) => {
    setScene(next);
    setActiveScene(next);
  };

  const handleGenerate = async () => {
    if (!caption.trim()) {
      setGenError("Add a score direction first.");
      return;
    }
    setGenerating(true);
    setGenError(null);
    setActiveScene(scene);
    try {
      await submitMusic({
        caption: caption.trim(),
        lyrics,
        durationSeconds: duration,
        bpm,
        key: keySig,
        lmModelSize,
        diffusionSteps,
        thinkingMode,
        referenceAudioPath,
        batchSize,
        seed,
      });
      setSeed(Math.floor(Math.random() * 99999));
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
            <span className="eyebrow music">score-v2 · ace-step</span>
            <span className="ttl">Score Composition</span>
            <span className="desc">
              Compose cues against the selected scene. Caption, lyrics, timing, and diffusion controls map directly to ACE-Step.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button className="btn" style={{ borderColor: "var(--music-d)", color: "var(--music)", background: "color-mix(in oklch, var(--music) 10%, transparent)" }} onClick={handleGenerate} disabled={generating || !caption.trim()}>
              <Icon name="sparkle" style={{ width: 14, height: 14 }} />
              {generating ? "Submitting..." : "Compose cue"}
            </button>
            {genError && <span style={{ fontSize: 10, color: "var(--sfx)", maxWidth: 240, textAlign: "right" }}>{genError}</span>}
          </div>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={chooseScene} accent="var(--music)" onSend={() => setActiveScene(scene)} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · caption</div>
        <RichDirector value={caption} setValue={setCaption} accent="var(--music)" />

        <div style={{ marginTop: 12 }}>
          <div className="field-label" style={{ marginBottom: 6 }}>
            <span>Lyrics</span>
            <span className="hint">optional; leave empty for instrumental/textless score</span>
          </div>
          <textarea className="textarea" value={lyrics} onChange={(e) => setLyrics(e.target.value)} style={{ minHeight: 76, fontSize: 12, lineHeight: 1.5 }} />
        </div>

        <div className="field-row" style={{ marginTop: 18 }}>
          <NumberControl label="Duration" hint="seconds" min={5} max={300} step={1} value={duration} onChange={(next) => setDuration(next || 30)} />
          <NumberControl label="BPM" hint="optional tempo" min={20} max={240} step={1} value={bpm} onChange={(next) => setBpm(next || 90)} />
          <div className="field">
            <div className="field-label"><span>Key</span><span className="hint">optional</span></div>
            <input className="input" value={keySig} onChange={(e) => setKeySig(e.target.value)} placeholder="Am, Db, etc." />
          </div>
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field">
            <div className="field-label"><span>LM model</span><span className="hint">ACE-Step</span></div>
            <select className="input" value={lmModelSize} onChange={(e) => setLmModelSize(e.target.value)}>
              <option value="1.7B">1.7B</option>
              <option value="3.5B">3.5B</option>
            </select>
          </div>
          <NumberControl label="Diffusion steps" hint="quality / time" min={10} max={200} step={1} value={diffusionSteps} onChange={(next) => setDiffusionSteps(Math.max(1, Math.floor(next || 60)))} />
          <NumberControl label="Batch size" hint="candidates" min={1} max={4} step={1} value={batchSize} onChange={(next) => setBatchSize(Math.max(1, Math.floor(next || 1)))} />
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="field-label" style={{ marginBottom: 6 }}>
            <span>Reference audio path</span>
            <span className="hint">optional cover/style anchor</span>
          </div>
          <input className="input" value={referenceAudioPath} onChange={(e) => setReferenceAudioPath(e.target.value)} placeholder="/path/to/reference.wav" />
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field">
            <div className="field-label"><span>Seed</span><span className="hint">deterministic</span></div>
            <div style={{ display: "flex", gap: 6 }}>
              <input className="input" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
              <button className="btn btn-sm" onClick={() => setSeed(Math.floor(Math.random() * 99999))}>roll</button>
            </div>
          </div>
          <div className="field">
            <div className="field-label"><span>Thinking mode</span><span className="hint">ACE-Step flag</span></div>
            <div className="toggle-group">
              <button className={!thinkingMode ? "active" : ""} onClick={() => setThinkingMode(false)}>off</button>
              <button className={thinkingMode ? "active" : ""} onClick={() => setThinkingMode(true)}>on</button>
            </div>
          </div>
        </div>

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Generated for {sceneSlug ?? "scene"} · {sceneJobs.length + persistedOnly.length}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sceneJobs.map((job, i) => <MusicJobRow key={job.id} job={job} index={i} />)}
          {persistedOnly.map((asset) => <MusicAssetRow key={asset.audio_path} asset={asset} peaks={assetPeaks[asset.audio_path]} />)}
          {sceneJobs.length === 0 && persistedOnly.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", border: "1px dashed var(--line-2)", borderRadius: "var(--r)", fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6 }}>
              No score cues generated for this scene yet.
            </div>
          )}
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section">
          <h3>Parameter map</h3>
          <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.65 }}>
            Caption, lyrics, duration, BPM, key, LM model size, diffusion steps, thinking mode, seed, and batch size are sent to ACE-Step.
          </div>
        </div>
      </div>
    </div>
  );
};
