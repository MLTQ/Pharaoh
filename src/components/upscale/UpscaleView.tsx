import React, { useEffect, useState } from "react";
import { Icon, PeaksWave, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { useProjectStore } from "../../store/projectStore";
import {
  getWaveformPeaks,
  listGeneratedAudioAssets,
  upscaleAudioAsset,
} from "../../lib/tauriCommands";
import { useJobStore } from "../../store/jobStore";
import type { AssetKind, GeneratedAudioAsset, Job } from "../../lib/types";

const KIND_COLOR: Record<AssetKind, string> = {
  tts: "var(--tts)",
  sfx: "var(--sfx)",
  music: "var(--music)",
};

const AUDIOSR_SETUP = "PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh";

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

function now() {
  return new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
      <code style={{
        flex: 1,
        display: "block",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        background: "var(--bg-0)",
        border: "1px solid var(--line-1)",
        borderRadius: 2,
        padding: "7px 10px",
        color: "var(--fg-1)",
        userSelect: "text",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}>
        {command}
      </code>
      <button
        className="btn btn-sm"
        onClick={() => {
          navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          });
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

export const UpscaleView: React.FC = () => {
  const { realProjectId } = useProjectStore();
  const { addJob, updateJob } = useJobStore();
  const [assets, setAssets] = useState<GeneratedAudioAsset[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const [filter, setFilter] = useState<"all" | AssetKind>("all");
  const [modelName, setModelName] = useState<"basic" | "speech">("basic");
  const [steps, setSteps] = useState(50);
  const [guidance, setGuidance] = useState(3.5);
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);

  const selected = assets.find((a) => a.audio_path === selectedPath) ?? assets[0] ?? null;
  const visibleAssets = assets.filter((a) => filter === "all" || a.kind === filter);

  const refresh = () => {
    if (!realProjectId) return;
    listGeneratedAudioAssets(realProjectId)
      .then((next) => {
        setAssets(next);
        setSelectedPath((current) => current ?? next[0]?.audio_path ?? null);
      })
      .catch((e) => setError(String(e)));
  };

  useEffect(refresh, [realProjectId]);

  useEffect(() => {
    if (!selected || peaks[selected.audio_path]) return;
    getWaveformPeaks(selected.audio_path, 160)
      .then((p) => setPeaks((prev) => ({ ...prev, [selected.audio_path]: p })))
      .catch(() => {});
  }, [selected?.audio_path]);

  const runUpscale = async () => {
    if (!selected) return;
    const jobId = `audiosr-${Date.now()}`;
    const job: Job = {
      id: jobId,
      model: "post",
      description: `AudioSR · ${basename(selected.audio_path)}`,
      status: "running",
      progress: 0,
      eta: "starting",
      started_at: now(),
      scene_id: null,
      scene_slug: selected.scene_slug,
      row_index: null,
      output_path: null,
      peaks: null,
      qa_status: "unreviewed",
      error: null,
    };

    addJob(job);
    setBusy(true);
    setError(null);
    setLastOutput(null);
    try {
      const output = await upscaleAudioAsset({
        inputPath: selected.audio_path,
        jobId,
        modelName,
        ddimSteps: steps,
        guidanceScale: guidance,
        seed,
      });
      const outputPeaks = await getWaveformPeaks(output, 120).catch(() => null);
      updateJob(jobId, {
        status: "complete",
        progress: 100,
        eta: "done",
        output_path: output,
        peaks: outputPeaks,
      });
      setLastOutput(output);
      refresh();
    } catch (e) {
      const message = String(e);
      updateJob(jobId, {
        status: "failed",
        eta: "failed",
        error: message,
      });
      setError(message);
    } finally {
      setBusy(false);
    }
  };
  const showSetupCommand = error?.includes("AudioSR CLI not found")
    || error?.includes("No module named 'pkg_resources'")
    || error?.includes("NotOpenSSLWarning");

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--bg-1)" }}>
      <div style={{ height: "100%", width: "100%", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(300px, 420px) minmax(0, 1fr)" }}>
        <div style={{
          borderRight: "1px solid var(--line-1)",
          background: "var(--bg-1)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}>
          <div style={{ padding: "22px 18px 14px", borderBottom: "1px solid var(--line-1)" }}>
            <div className="eyebrow" style={{ marginBottom: 5 }}>Post</div>
            <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0 }}>Audio Upscale</h1>
            <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.55, marginTop: 7 }}>
              Select any generated take and run AudioSR to produce a 48 kHz enhanced child asset.
            </div>
          </div>

          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-1)", display: "flex", gap: 6 }}>
            {(["all", "tts", "sfx", "music"] as const).map((k) => (
              <button
                key={k}
                className={`btn btn-sm${filter === k ? " btn-primary" : ""}`}
                onClick={() => setFilter(k)}
                style={{ textTransform: "uppercase", fontSize: 9.5 }}
              >
                {k}
              </button>
            ))}
            <button className="btn btn-sm" onClick={refresh} style={{ marginLeft: "auto" }}>
              refresh
            </button>
          </div>

          <div style={{ overflowY: "auto", minHeight: 0 }}>
            {visibleAssets.length === 0 ? (
              <div style={{ padding: 18, color: "var(--fg-4)", fontSize: 12, lineHeight: 1.6 }}>
                No generated assets found yet. Generate dialogue, SFX, or music first; this page indexes WAV sidecars in scene asset folders.
              </div>
            ) : visibleAssets.map((asset, i) => {
              const color = KIND_COLOR[asset.kind];
              const active = selected?.audio_path === asset.audio_path;
              return (
                <button
                  key={asset.audio_path}
                  onClick={() => setSelectedPath(asset.audio_path)}
                  style={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: "68px 1fr auto",
                    gap: 10,
                    alignItems: "center",
                    textAlign: "left",
                    padding: "11px 14px",
                    border: 0,
                    borderBottom: "1px solid var(--line-1)",
                    borderLeft: active ? `2px solid ${color}` : "2px solid transparent",
                    background: active ? `color-mix(in oklch, ${color} 9%, var(--bg-1))` : "transparent",
                    color: "var(--fg-1)",
                    cursor: "pointer",
                  }}
                >
                  <div>
                    {peaks[asset.audio_path] ? (
                      <PeaksWave peaks={peaks[asset.audio_path]} width={68} height={26} color={color} opacity={0.85} />
                    ) : (
                      <Wave width={68} height={26} seed={i + 70} count={18} color={color} opacity={0.7} />
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {asset.name}
                    </div>
                    <div style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9.5,
                      color: "var(--fg-4)",
                      marginTop: 3,
                      textTransform: "uppercase",
                    }}>
                      {asset.kind} · {asset.scene_slug} · {formatDuration(asset.duration_ms)}
                    </div>
                  </div>
                  <PlayButton path={asset.audio_path} size={11} />
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ overflowY: "auto", overflowX: "hidden", padding: "28px 34px", minWidth: 0 }}>
          {!selected ? (
            <div style={{ color: "var(--fg-4)", fontSize: 13 }}>Select a generated sound to upscale.</div>
          ) : (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{
                border: "1px solid var(--line-1)",
                background: "var(--bg-1)",
                borderRadius: 3,
                padding: 18,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: KIND_COLOR[selected.kind],
                    boxShadow: `0 0 8px ${KIND_COLOR[selected.kind]}`,
                  }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{basename(selected.audio_path)}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)", marginTop: 3 }}>
                      {selected.sample_rate || "?"} Hz · {formatDuration(selected.duration_ms)} · {selected.model}
                    </div>
                  </div>
                  <span style={{ flex: 1 }} />
                  <PlayButton path={selected.audio_path} size={14} />
                </div>

                <div style={{ minHeight: 66, border: "1px solid var(--line-1)", background: "var(--bg-0)", borderRadius: 2, padding: 10, overflow: "hidden" }}>
                  {peaks[selected.audio_path] ? (
                    <PeaksWave peaks={peaks[selected.audio_path]} width={920} height={54} color={KIND_COLOR[selected.kind]} opacity={0.9} />
                  ) : (
                    <Wave width={920} height={54} seed={selected.name.charCodeAt(0)} count={150} color={KIND_COLOR[selected.kind]} opacity={0.75} />
                  )}
                </div>

                <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, marginTop: 12 }}>
                  {selected.prompt || "No prompt recorded."}
                </div>
              </div>

              <div style={{
                border: "1px solid var(--line-1)",
                background: "var(--bg-1)",
                borderRadius: 3,
                padding: 18,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: 12,
              }}>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Model</div>
                  <select className="select" value={modelName} onChange={(e) => setModelName(e.target.value as "basic" | "speech")}>
                    <option value="basic">basic · SFX/music/general</option>
                    <option value="speech">speech · dialogue</option>
                  </select>
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>DDIM steps</div>
                  <input className="input" type="number" min={10} max={150} value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Guidance</div>
                  <input className="input" type="number" min={1} max={8} step={0.1} value={guidance} onChange={(e) => setGuidance(Number(e.target.value))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Seed</div>
                  <input className="input" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
                </label>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  className="btn btn-primary"
                  onClick={runUpscale}
                  disabled={busy}
                  style={{
                    borderColor: "var(--sfx)",
                    color: "var(--sfx)",
                    background: "color-mix(in oklch, var(--sfx) 10%, transparent)",
                  }}
                >
                  <Icon name="waves" style={{ width: 14, height: 14 }} />
                  {busy ? "Upscaling…" : "Upscale selected"}
                </button>
                <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
                  AudioSR can be slow; long beds may take several minutes.
                </span>
              </div>

              {lastOutput && (
                <div style={{ border: "1px solid var(--st-rendered)", borderRadius: 3, padding: 12, color: "var(--st-rendered)", fontSize: 12, overflowWrap: "anywhere" }}>
                  Upscaled asset written: <code style={{ overflowWrap: "anywhere" }}>{lastOutput}</code>
                  <span style={{ marginLeft: 10 }}><PlayButton path={lastOutput} size={12} /></span>
                </div>
              )}

              {error && (
                <div style={{ border: "1px solid var(--sfx)", borderRadius: 3, padding: 12, color: "var(--fg-2)", fontSize: 12, lineHeight: 1.6, overflow: "hidden" }}>
                  <div style={{ color: "var(--sfx)", marginBottom: 8 }}>AudioSR could not run:</div>
                  <pre style={{
                    margin: 0,
                    maxHeight: 360,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    lineHeight: 1.55,
                  }}>{error}</pre>
                  {showSetupCommand && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ color: "var(--fg-3)", marginBottom: 6 }}>Install or refresh the optional AudioSR environment:</div>
                      <CopyableCommand command={AUDIOSR_SETUP} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
