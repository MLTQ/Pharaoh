import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon, PeaksWave, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { deriveSlug, useProjectStore } from "../../store/projectStore";
import { useAudioStore } from "../../store/audioStore";
import {
  getWaveformPeaks,
  listGeneratedAudioAssets,
  processClipAsset,
  readScript,
  updateScriptRow,
} from "../../lib/tauriCommands";
import type { AssetKind, GeneratedAudioAsset, ScriptRow } from "../../lib/types";

const KIND_COLOR: Record<AssetKind, string> = {
  tts: "var(--tts)",
  sfx: "var(--sfx)",
  music: "var(--music)",
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatMs(ms: number | null | undefined): string {
  if (!ms) return "--:--";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function rowLabel(row: ScriptRow, index: number): string {
  const who = row.character || row.track || row.type;
  const text = (row.prompt || row.instruct || row.notes || "Untitled cue").slice(0, 72);
  return `${index + 1}. ${row.type} · ${who} · ${text}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface CropWaveformProps {
  peaks: number[] | null;
  durationMs: number | null;
  startMs: number;
  endMs: number;
  color: string;
  fallbackSeed: number;
  onStartChange: (ms: number) => void;
  onEndChange: (ms: number) => void;
}

const CropWaveform: React.FC<CropWaveformProps> = ({
  peaks,
  durationMs,
  startMs,
  endMs,
  color,
  fallbackSeed,
  onStartChange,
  onEndChange,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const duration = durationMs ?? 0;
  const active = duration > 0;
  const minGapMs = Math.min(100, Math.max(10, duration * 0.01));
  const startPct = active ? (clamp(startMs, 0, duration) / duration) * 100 : 0;
  const endPct = active ? (clamp(endMs, 0, duration) / duration) * 100 : 100;

  const msFromPointer = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !active) return 0;
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
    return Math.round(pct * duration);
  };

  const startDrag = (handle: "start" | "end", e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (clientX: number) => {
      const next = msFromPointer(clientX);
      if (handle === "start") onStartChange(clamp(next, 0, Math.max(0, endMs - minGapMs)));
      else onEndChange(clamp(next, Math.min(duration, startMs + minGapMs), duration));
    };
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        minHeight: 82,
        border: "1px solid var(--line-1)",
        background: "var(--bg-0)",
        borderRadius: 2,
        padding: 10,
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {peaks ? (
        <PeaksWave peaks={peaks} width={1000} height={70} color={color} opacity={0.9} />
      ) : (
        <Wave width={1000} height={70} seed={fallbackSeed} count={180} color={color} opacity={0.75} />
      )}
      {active && (
        <>
          <div style={{ position: "absolute", inset: `0 ${100 - startPct}% 0 0`, background: "rgba(0,0,0,0.34)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", inset: `0 0 0 ${endPct}%`, background: "rgba(0,0,0,0.34)", pointerEvents: "none" }} />
          {(["start", "end"] as const).map((handle) => {
            const pct = handle === "start" ? startPct : endPct;
            return (
              <div
                key={handle}
                onPointerDown={(e) => startDrag(handle, e)}
                title={handle === "start" ? "Drag crop start" : "Drag crop end"}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${pct}%`,
                  width: 18,
                  transform: "translateX(-50%)",
                  cursor: "ew-resize",
                  display: "flex",
                  alignItems: "stretch",
                  justifyContent: "center",
                  touchAction: "none",
                }}
              >
                <div style={{ width: 2, background: "var(--fg-1)", boxShadow: `0 0 12px ${color}` }} />
                <div style={{
                  position: "absolute",
                  top: 6,
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: "var(--fg-1)",
                  border: `1px solid ${color}`,
                }} />
              </div>
            );
          })}
          <div style={{
            position: "absolute",
            left: `${startPct}%`,
            right: `${100 - endPct}%`,
            bottom: 5,
            height: 2,
            background: color,
            boxShadow: `0 0 10px ${color}`,
            pointerEvents: "none",
          }} />
        </>
      )}
    </div>
  );
};

export const ClipStudioView: React.FC = () => {
  const { realProjectId, scenes, activeSceneNo } = useProjectStore();
  const [assets, setAssets] = useState<GeneratedAudioAsset[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Record<string, number[]>>({});
  const [filter, setFilter] = useState<"all" | AssetKind>("all");
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState<number | null>(null);
  const [gainDb, setGainDb] = useState(0);
  const [fadeInMs, setFadeInMs] = useState(0);
  const [fadeOutMs, setFadeOutMs] = useState(0);
  const [normalize, setNormalize] = useState(false);
  const [normalizeLufs, setNormalizeLufs] = useState(-16);
  const [highpassHz, setHighpassHz] = useState(0);
  const [lowpassHz, setLowpassHz] = useState(0);
  const [targetScene, setTargetScene] = useState(activeSceneNo);
  const [scriptRows, setScriptRows] = useState<ScriptRow[]>([]);
  const [targetRowIndex, setTargetRowIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const playAudio = useAudioStore((state) => state.play);

  const selected = assets.find((asset) => asset.audio_path === selectedPath) ?? assets[0] ?? null;
  const visibleAssets = useMemo(
    () => assets.filter((asset) => filter === "all" || asset.kind === filter),
    [assets, filter],
  );
  const targetSceneMeta = scenes.find((scene) => scene.no === targetScene) ?? scenes[0] ?? null;
  const targetSceneSlug = targetSceneMeta ? (targetSceneMeta.slug ?? deriveSlug(targetSceneMeta.no, targetSceneMeta.title)) : "";
  const assignableRows = scriptRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.type !== "DIRECTION");
  const selectedDuration = selected?.duration_ms ?? null;
  const safeEndMs = endMs ?? selectedDuration ?? 0;
  const selectedColor = selected ? KIND_COLOR[selected.kind] : "var(--fg-1)";

  const refreshAssets = () => {
    if (!realProjectId) return;
    listGeneratedAudioAssets(realProjectId)
      .then((next) => {
        setAssets(next);
        setSelectedPath((current) => current ?? next[0]?.audio_path ?? null);
      })
      .catch((e) => setError(String(e)));
  };

  useEffect(refreshAssets, [realProjectId]);

  useEffect(() => {
    if (!selected) return;
    setStartMs(0);
    setEndMs(selected.duration_ms);
  }, [selected?.audio_path]);

  useEffect(() => {
    if (!selected || peaks[selected.audio_path]) return;
    getWaveformPeaks(selected.audio_path, 220)
      .then((next) => setPeaks((prev) => ({ ...prev, [selected.audio_path]: next })))
      .catch(() => {});
  }, [selected?.audio_path]);

  useEffect(() => {
    if (!realProjectId || !targetSceneMeta) {
      setScriptRows([]);
      return;
    }
    readScript({ projectId: realProjectId, sceneSlug: targetSceneSlug })
      .then((rows) => {
        setScriptRows(rows);
        setTargetRowIndex((current) => {
          if (current != null && rows[current] && rows[current].type !== "DIRECTION") return current;
          const first = rows.findIndex((row) => row.type !== "DIRECTION");
          return first >= 0 ? first : null;
        });
      })
      .catch(() => setScriptRows([]));
  }, [realProjectId, targetSceneSlug]);

  const playSelection = () => {
    if (!selected) return;
    playAudio(
      selected.audio_path,
      Math.max(0, startMs) / 1000,
      safeEndMs > startMs ? safeEndMs / 1000 : null,
    );
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName.toLowerCase();
      if (target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select") return;
      event.preventDefault();
      playSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected?.audio_path, startMs, safeEndMs]);

  const saveClip = async (sendToScene: boolean) => {
    if (!selected) return;
    if (safeEndMs > 0 && safeEndMs <= startMs) {
      setError("Clip end must be after clip start.");
      return;
    }
    setBusy(true);
    setError(null);
    setLastOutput(null);
    try {
      const output = await processClipAsset({
        inputPath: selected.audio_path,
        startMs,
        endMs: safeEndMs > 0 ? safeEndMs : null,
        gainDb,
        fadeInMs,
        fadeOutMs,
        normalizeLufs: normalize ? normalizeLufs : null,
        highpassHz: highpassHz > 0 ? highpassHz : null,
        lowpassHz: lowpassHz > 0 ? lowpassHz : null,
      });
      setLastOutput(output);
      refreshAssets();

      if (sendToScene && realProjectId && targetSceneSlug && targetRowIndex != null) {
        const duration = safeEndMs > startMs ? safeEndMs - startMs : selected.duration_ms ?? "";
        await updateScriptRow({
          projectId: realProjectId,
          sceneSlug: targetSceneSlug,
          rowIndex: targetRowIndex,
          fields: {
            file: output,
            duration_ms: String(duration),
            fade_in_ms: String(fadeInMs),
            fade_out_ms: String(fadeOutMs),
          },
        });
        const rows = await readScript({ projectId: realProjectId, sceneSlug: targetSceneSlug });
        setScriptRows(rows);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--bg-1)" }}>
      <div style={{ height: "100%", width: "100%", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)" }}>
        <div style={{ borderRight: "1px solid var(--line-1)", background: "var(--bg-1)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "22px 18px 14px", borderBottom: "1px solid var(--line-1)" }}>
            <div className="eyebrow" style={{ marginBottom: 5 }}>Post</div>
            <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0 }}>Clip Studio</h1>
            <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.55, marginTop: 7 }}>
              Trim generated takes, apply practical cleanup, save child assets, or assign the result to a scene row.
            </div>
          </div>

          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-1)", display: "flex", gap: 6 }}>
            {(["all", "tts", "sfx", "music"] as const).map((kind) => (
              <button
                key={kind}
                className={`btn btn-sm${filter === kind ? " btn-primary" : ""}`}
                onClick={() => setFilter(kind)}
                style={{ textTransform: "uppercase", fontSize: 9.5 }}
              >
                {kind}
              </button>
            ))}
            <button className="btn btn-sm" onClick={refreshAssets} style={{ marginLeft: "auto" }}>refresh</button>
          </div>

          <div style={{ overflowY: "auto", minHeight: 0 }}>
            {visibleAssets.length === 0 ? (
              <div style={{ padding: 18, color: "var(--fg-4)", fontSize: 12, lineHeight: 1.6 }}>
                No generated assets found yet. Generate or upscale audio first; Clip Studio indexes WAV sidecars in scene asset folders.
              </div>
            ) : visibleAssets.map((asset, index) => {
              const color = KIND_COLOR[asset.kind];
              const active = selected?.audio_path === asset.audio_path;
              return (
                <button
                  key={asset.audio_path}
                  onClick={() => setSelectedPath(asset.audio_path)}
                  style={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: "72px 1fr auto",
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
                      <PeaksWave peaks={peaks[asset.audio_path]} width={72} height={28} color={color} opacity={0.85} />
                    ) : (
                      <Wave width={72} height={28} seed={index + 10} count={20} color={color} opacity={0.7} />
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{asset.name}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", marginTop: 3, textTransform: "uppercase" }}>
                      {asset.kind} · {asset.scene_slug} · {formatMs(asset.duration_ms)}
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
            <div style={{ color: "var(--fg-4)", fontSize: 13 }}>Select a generated sound to edit.</div>
          ) : (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ border: "1px solid var(--line-1)", background: "var(--bg-1)", borderRadius: 3, padding: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: KIND_COLOR[selected.kind], boxShadow: `0 0 8px ${KIND_COLOR[selected.kind]}` }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }}>{basename(selected.audio_path)}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)", marginTop: 3 }}>
                      {selected.sample_rate || "?"} Hz · {formatMs(selected.duration_ms)} · {selected.model}
                    </div>
                  </div>
                  <span style={{ flex: 1 }} />
                  <PlayButton path={selected.audio_path} size={14} />
                </div>

                <CropWaveform
                  peaks={peaks[selected.audio_path] ?? null}
                  durationMs={selectedDuration}
                  startMs={startMs}
                  endMs={safeEndMs}
                  color={selectedColor}
                  fallbackSeed={selected.name.charCodeAt(0)}
                  onStartChange={setStartMs}
                  onEndChange={setEndMs}
                />

                <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, flex: 1 }}>
                    {selected.prompt || "No prompt recorded."}
                  </div>
                  <button className="btn btn-sm" onClick={playSelection} title="Preview crop from the left handle. Space also previews.">
                    <Icon name="play" style={{ width: 11, height: 11 }} />
                    play crop
                  </button>
                </div>
              </div>

              <div style={{ border: "1px solid var(--line-1)", borderRadius: 3, padding: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Start ms</div>
                  <input className="input" type="number" min={0} max={selectedDuration ?? undefined} value={startMs} onChange={(e) => setStartMs(Math.max(0, Number(e.target.value)))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>End ms</div>
                  <input className="input" type="number" min={0} max={selectedDuration ?? undefined} value={safeEndMs} onChange={(e) => setEndMs(Math.max(0, Number(e.target.value)))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Gain dB</div>
                  <input className="input" type="number" min={-24} max={24} step={0.5} value={gainDb} onChange={(e) => setGainDb(Number(e.target.value))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Fade in ms</div>
                  <input className="input" type="number" min={0} value={fadeInMs} onChange={(e) => setFadeInMs(Math.max(0, Number(e.target.value)))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Fade out ms</div>
                  <input className="input" type="number" min={0} value={fadeOutMs} onChange={(e) => setFadeOutMs(Math.max(0, Number(e.target.value)))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Highpass Hz</div>
                  <input className="input" type="number" min={0} value={highpassHz} onChange={(e) => setHighpassHz(Math.max(0, Number(e.target.value)))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Lowpass Hz</div>
                  <input className="input" type="number" min={0} value={lowpassHz} onChange={(e) => setLowpassHz(Math.max(0, Number(e.target.value)))} />
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Normalize LUFS</div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
                    <input className="input" type="number" min={-30} max={-8} step={0.5} value={normalizeLufs} disabled={!normalize} onChange={(e) => setNormalizeLufs(Number(e.target.value))} />
                  </div>
                </label>
              </div>

              <div style={{ border: "1px solid var(--line-1)", borderRadius: 3, padding: 18, display: "grid", gridTemplateColumns: "minmax(180px, 0.4fr) minmax(280px, 1fr)", gap: 12 }}>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Target scene</div>
                  <select className="select" value={targetScene} onChange={(e) => setTargetScene(e.target.value)}>
                    {scenes.map((scene) => <option key={scene.no} value={scene.no}>{scene.no} · {scene.title}</option>)}
                  </select>
                </label>
                <label>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>Target row</div>
                  <select
                    className="select"
                    value={targetRowIndex ?? ""}
                    onChange={(e) => setTargetRowIndex(e.target.value === "" ? null : Number(e.target.value))}
                  >
                    {assignableRows.length === 0 && <option value="">No assignable rows</option>}
                    {assignableRows.map(({ row, index }) => <option key={index} value={index}>{rowLabel(row, index)}</option>)}
                  </select>
                </label>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => saveClip(false)}>
                  <Icon name="fit" style={{ width: 14, height: 14 }} />
                  {busy ? "Processing..." : "Save child asset"}
                </button>
                <button className="btn" disabled={busy || targetRowIndex == null} onClick={() => saveClip(true)}>
                  <Icon name="timeline" style={{ width: 14, height: 14 }} />
                  Save and send to row
                </button>
                <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
                  Processing uses local ffmpeg and writes a new sidecar-indexed WAV next to the source.
                </span>
              </div>

              {lastOutput && (
                <div style={{ border: "1px solid var(--st-rendered)", borderRadius: 3, padding: 12, color: "var(--st-rendered)", fontSize: 12, overflowWrap: "anywhere" }}>
                  Clip written: <code>{lastOutput}</code>
                  <span style={{ marginLeft: 10 }}><PlayButton path={lastOutput} size={12} /></span>
                </div>
              )}

              {error && (
                <div style={{ border: "1px solid var(--sfx)", borderRadius: 3, padding: 12, color: "var(--fg-2)", fontSize: 12, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                  <div style={{ color: "var(--sfx)", marginBottom: 6 }}>Clip Studio could not process the asset:</div>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 11 }}>{error}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
