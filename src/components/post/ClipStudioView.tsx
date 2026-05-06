import React, { useEffect, useMemo, useState } from "react";
import { Icon, PeaksWave, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { deriveSlug, useProjectStore } from "../../store/projectStore";
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

                <div style={{ minHeight: 82, border: "1px solid var(--line-1)", background: "var(--bg-0)", borderRadius: 2, padding: 10, overflow: "hidden" }}>
                  {peaks[selected.audio_path] ? (
                    <PeaksWave peaks={peaks[selected.audio_path]} width={1000} height={70} color={KIND_COLOR[selected.kind]} opacity={0.9} />
                  ) : (
                    <Wave width={1000} height={70} seed={selected.name.charCodeAt(0)} count={180} color={KIND_COLOR[selected.kind]} opacity={0.75} />
                  )}
                </div>

                <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, marginTop: 12 }}>
                  {selected.prompt || "No prompt recorded."}
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
