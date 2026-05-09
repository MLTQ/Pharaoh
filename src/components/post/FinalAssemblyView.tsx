import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { useProjectStore, deriveSlug } from "../../store/projectStore";
import { useToastStore } from "../../store/toastStore";
import { usePeaksStore } from "../../store/peaksStore";
import { renderEpisode, readRenderMeta, type RenderMeta } from "../../lib/tauriCommands";
import type { MockScene } from "../../lib/types";

// Episode-level master targets, mirrors the per-scene set in CompositionView
const TARGETS = [
  { value: -14, label: "-14 LUFS · Spotify" },
  { value: -16, label: "-16 LUFS · Podcast" },
  { value: -18, label: "-18 LUFS · Apple" },
  { value: -23, label: "-23 LUFS · Broadcast" },
];

const CROSSFADES = [
  { value: 0,    label: "hard cut" },
  { value: 200,  label: "200 ms" },
  { value: 500,  label: "500 ms" },
  { value: 1000, label: "1.0 s" },
  { value: 1500, label: "1.5 s" },
  { value: 2000, label: "2.0 s" },
];

interface SceneStripProps {
  scene: MockScene;
  index: number;
  total: number;
  rendered: boolean;
  meta: RenderMeta | null;
  renderPath: string | null;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

const SceneStrip: React.FC<SceneStripProps> = ({
  scene, index, total, rendered, meta, renderPath, onMoveUp, onMoveDown,
}) => {
  // Compliance color for the per-scene measurement, same scheme as the
  // transport bar — if a scene drifts > 2 LU from target it lights up red.
  const lufsColor = meta
    ? (() => {
        const dev = Math.abs(meta.integrated_lufs - meta.target_lufs);
        return dev <= 1 ? "var(--st-rendered)" : dev <= 2 ? "var(--st-gen)" : "var(--sfx)";
      })()
    : "var(--fg-4)";
  const tpColor = meta
    ? (meta.true_peak_dbtp <= -1 ? "var(--st-rendered)" : meta.true_peak_dbtp <= 0 ? "var(--st-gen)" : "var(--sfx)")
    : "var(--fg-4)";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "60px 60px 1fr 220px 90px 56px",
      alignItems: "center",
      gap: 10,
      padding: "10px 14px",
      borderBottom: "1px solid var(--line-1)",
      background: rendered ? "var(--bg-1)" : "color-mix(in oklch, var(--bg-1) 80%, transparent)",
    }}>
      {/* Order */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <button
          onClick={onMoveUp}
          disabled={index === 0}
          style={{
            background: "transparent", border: "1px solid var(--line-2)", borderRadius: 2,
            padding: "1px 6px", color: index === 0 ? "var(--fg-4)" : "var(--fg-2)",
            cursor: index === 0 ? "default" : "pointer", fontFamily: "var(--font-mono)", fontSize: 10,
          }}
        >▲</button>
        <button
          onClick={onMoveDown}
          disabled={index === total - 1}
          style={{
            background: "transparent", border: "1px solid var(--line-2)", borderRadius: 2,
            padding: "1px 6px", color: index === total - 1 ? "var(--fg-4)" : "var(--fg-2)",
            cursor: index === total - 1 ? "default" : "pointer", fontFamily: "var(--font-mono)", fontSize: 10,
          }}
        >▼</button>
      </div>

      {/* Status indicator */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span
          title={rendered ? "Rendered" : "Not yet rendered"}
          style={{
            width: 12, height: 12, borderRadius: "50%",
            border: `1.5px solid ${rendered ? "var(--st-rendered)" : "var(--st-draft)"}`,
            background: rendered ? "var(--st-rendered)" : "transparent",
            boxShadow: rendered ? "0 0 6px color-mix(in oklch, var(--st-rendered) 40%, transparent)" : "none",
          }}
        />
      </div>

      {/* Scene title + slug */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-3)", fontWeight: 400, marginRight: 8 }}>{scene.no}</span>
          {scene.title}
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", letterSpacing: "0.04em", marginTop: 2 }}>
          {scene.slug ?? deriveSlug(scene.no, scene.title)} · {scene.duration}
        </div>
      </div>

      {/* Per-scene measured loudness */}
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.4 }}>
        {meta ? (
          <>
            <div>
              <span style={{ color: lufsColor }}>{meta.integrated_lufs.toFixed(1)} LUFS</span>
              <span style={{ color: "var(--fg-4)" }}> · </span>
              <span style={{ color: tpColor }}>{meta.true_peak_dbtp.toFixed(1)} dBTP</span>
            </div>
            <div style={{ color: "var(--fg-4)", marginTop: 2 }}>
              target {meta.target_lufs.toFixed(0)} · LRA {meta.loudness_range_lu.toFixed(1)}
            </div>
          </>
        ) : (
          <span style={{ color: "var(--fg-4)" }}>not measured</span>
        )}
      </div>

      {/* Per-scene render preview */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {rendered && renderPath ? (
          <PlayButton path={renderPath} size={11} />
        ) : (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)" }}>—</span>
        )}
      </div>

      {/* Status badge */}
      <div style={{ textAlign: "right" }}>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: rendered ? "var(--st-rendered)" : "var(--fg-4)",
        }}>
          {rendered ? "ready" : "pending"}
        </span>
      </div>
    </div>
  );
};

export const FinalAssemblyView: React.FC = () => {
  const { realProjectId, projectsDir, scenes: storeScenes } = useProjectStore();
  const pushToast = useToastStore((s) => s.push);
  const fetchPeaks = usePeaksStore((s) => s.fetchPeaks);
  // toast helper not needed yet; pushToast is used directly below

  const [order, setOrder] = useState<string[]>([]); // scene.no order
  const [crossfadeMs, setCrossfadeMs] = useState<number>(500);
  const [targetLufs, setTargetLufs] = useState<number>(-16);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalPath, setFinalPath] = useState<string | null>(null);
  const [finalMeta, setFinalMeta] = useState<RenderMeta | null>(null);
  const [sceneMetaBySlug, setSceneMetaBySlug] = useState<Record<string, RenderMeta | null>>({});
  const [sceneRenderPathBySlug, setSceneRenderPathBySlug] = useState<Record<string, string | null>>({});

  // Initialize order from the store; only re-seed when the set of scenes
  // changes (additions/removals), preserving any user-applied reorderings.
  useEffect(() => {
    const fromStore = storeScenes.map((s) => s.no);
    setOrder((prev) => {
      const sameSet = prev.length === fromStore.length && prev.every((n) => fromStore.includes(n));
      return sameSet ? prev : fromStore;
    });
  }, [storeScenes]);

  // Load per-scene render meta + path so each strip can show measured
  // loudness without rerendering. Best-effort: missing render.wav.meta.json
  // simply leaves the strip in "pending" state.
  useEffect(() => {
    if (!realProjectId || !projectsDir) return;
    (async () => {
      const metaEntries: Record<string, RenderMeta | null> = {};
      const pathEntries: Record<string, string | null> = {};
      await Promise.all(storeScenes.map(async (s) => {
        const slug = s.slug ?? deriveSlug(s.no, s.title);
        const renderPath = `${projectsDir}/${realProjectId}/scenes/${slug}/render.wav`;
        try {
          const meta = await readRenderMeta(renderPath);
          metaEntries[slug] = meta;
          pathEntries[slug] = meta ? renderPath : null;
        } catch {
          metaEntries[slug] = null;
          pathEntries[slug] = null;
        }
      }));
      setSceneMetaBySlug(metaEntries);
      setSceneRenderPathBySlug(pathEntries);
    })();
  }, [realProjectId, projectsDir, storeScenes]);

  // Load final.wav.meta.json + path on mount and after a render completes.
  const reloadFinalMeta = async () => {
    if (!realProjectId || !projectsDir) return;
    const path = `${projectsDir}/${realProjectId}/output/final.wav`;
    try {
      const meta = await readRenderMeta(path);
      if (meta) {
        setFinalMeta(meta);
        setFinalPath(path);
      } else {
        setFinalMeta(null);
        setFinalPath(null);
      }
    } catch {}
  };
  useEffect(() => { reloadFinalMeta(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [realProjectId, projectsDir]);

  // Keep the peaks cache warm for each rendered scene so any preview clicks
  // are instant. Scenes still pending render are skipped.
  useEffect(() => {
    Object.entries(sceneRenderPathBySlug).forEach(([_, p]) => {
      if (p) fetchPeaks(p, 200).catch(() => {});
    });
  }, [sceneRenderPathBySlug, fetchPeaks]);

  // ── Derived ────────────────────────────────────────────────────────────

  const orderedScenes = useMemo(() => {
    const byNo = new Map(storeScenes.map((s) => [s.no, s]));
    return order.map((no) => byNo.get(no)).filter((s): s is MockScene => Boolean(s));
  }, [order, storeScenes]);

  const orderedSlugs = useMemo(
    () => orderedScenes.map((s) => s.slug ?? deriveSlug(s.no, s.title)),
    [orderedScenes],
  );

  const renderedCount = orderedSlugs.filter((slug) => sceneRenderPathBySlug[slug]).length;
  const totalDurationSec = orderedScenes.reduce((acc, s) => {
    // Prefer measured duration if available (more accurate post-render);
    // fall back to the human-formatted scene.duration string.
    const slug = s.slug ?? deriveSlug(s.no, s.title);
    const meta = sceneMetaBySlug[slug];
    if (meta?.duration_seconds) return acc + meta.duration_seconds;
    const parts = (s.duration || "").split(":").map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return acc;
    if (parts.length === 2) return acc + parts[0] * 60 + parts[1];
    if (parts.length === 3) return acc + parts[0] * 3600 + parts[1] * 60 + parts[2];
    return acc;
  }, 0);
  // Subtract one crossfade duration per gap (overlapping audio)
  const projectedDurationSec = Math.max(0, totalDurationSec - Math.max(0, orderedScenes.length - 1) * (crossfadeMs / 1000));

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleMove = (idx: number, dir: -1 | 1) => {
    setOrder((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const handleRender = async () => {
    if (!realProjectId) {
      pushToast({ kind: "warn", title: "Open a real project to render the episode" });
      return;
    }
    if (orderedSlugs.length === 0) {
      pushToast({ kind: "warn", title: "No scenes in this episode" });
      return;
    }
    setRendering(true);
    setError(null);
    try {
      const path = await renderEpisode({
        projectId: realProjectId,
        crossfadeMs,
        targetLufs,
        sceneSlugs: orderedSlugs,
      });
      setFinalPath(path);
      const meta = await readRenderMeta(path);
      setFinalMeta(meta);
      // Refresh per-scene meta — render_episode renders any missing scenes.
      const metaEntries: Record<string, RenderMeta | null> = {};
      const pathEntries: Record<string, string | null> = {};
      await Promise.all(orderedSlugs.map(async (slug) => {
        const renderPath = `${projectsDir}/${realProjectId}/scenes/${slug}/render.wav`;
        const m = await readRenderMeta(renderPath).catch(() => null);
        metaEntries[slug] = m;
        pathEntries[slug] = m ? renderPath : null;
      }));
      setSceneMetaBySlug(metaEntries);
      setSceneRenderPathBySlug(pathEntries);
      pushToast({ kind: "info", title: "Episode rendered" });
    } catch (e) {
      setError(String(e));
      pushToast({ kind: "error", title: `Render failed: ${e}` });
    } finally {
      setRendering(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  // Compliance colors for the final episode readout
  const finalLufsColor = finalMeta
    ? (() => {
        const dev = Math.abs(finalMeta.integrated_lufs - finalMeta.target_lufs);
        return dev <= 1 ? "var(--st-rendered)" : dev <= 2 ? "var(--st-gen)" : "var(--sfx)";
      })()
    : "var(--fg-4)";
  const finalTpColor = finalMeta
    ? (finalMeta.true_peak_dbtp <= -1 ? "var(--st-rendered)" : finalMeta.true_peak_dbtp <= 0 ? "var(--st-gen)" : "var(--sfx)")
    : "var(--fg-4)";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--bg-0)" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 32px" }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>Post · Final Assembly</div>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.012em", color: "var(--fg-0)", margin: 0 }}>
            Episode
          </h1>
          <div style={{ marginTop: 6, fontSize: 13, color: "var(--fg-2)" }}>
            Concatenate scene renders into <code style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>output/final.wav</code> with crossfades and an episode-wide master pass.
          </div>
        </div>

        {/* Episode summary card */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 16,
          padding: 18,
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: 4,
          marginBottom: 24,
        }}>
          <div>
            <div className="kicker" style={{ marginBottom: 4 }}>Scenes</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--fg-0)" }}>
              {renderedCount}<span style={{ fontSize: 14, fontWeight: 400, color: "var(--fg-3)" }}> / {orderedScenes.length}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 2 }}>rendered</div>
          </div>
          <div>
            <div className="kicker" style={{ marginBottom: 4 }}>Projected duration</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--fg-0)", fontFamily: "var(--font-mono)" }}>
              {Math.floor(projectedDurationSec / 60)}:{String(Math.floor(projectedDurationSec % 60)).padStart(2, "0")}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 2 }}>
              after {crossfadeMs > 0 ? `${crossfadeMs}ms` : "hard"} crossfades
            </div>
          </div>
          <div>
            <div className="kicker" style={{ marginBottom: 4 }}>Last render</div>
            {finalMeta ? (
              <>
                <div style={{ fontSize: 14, fontFamily: "var(--font-mono)", lineHeight: 1.4 }}>
                  <span style={{ color: finalLufsColor }}>{finalMeta.integrated_lufs.toFixed(1)} LUFS</span>
                  <span style={{ color: "var(--fg-4)" }}> · </span>
                  <span style={{ color: finalTpColor }}>{finalMeta.true_peak_dbtp.toFixed(1)} dBTP</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 2 }}>
                  {finalMeta.duration_seconds.toFixed(1)}s · target {finalMeta.target_lufs.toFixed(0)} · LRA {finalMeta.loudness_range_lu.toFixed(1)}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "var(--fg-4)" }}>no episode rendered yet</div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: 12,
          background: "var(--bg-1)", border: "1px solid var(--line-1)", borderRadius: 4, marginBottom: 16,
        }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-3)" }}>
            <span style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.04em", color: "var(--fg-4)" }}>CROSSFADE</span>
            <select
              value={crossfadeMs}
              onChange={(e) => setCrossfadeMs(Number(e.target.value))}
              disabled={rendering}
              style={{
                background: "var(--bg-2)", color: "var(--fg-1)",
                border: "1px solid var(--line-2)", borderRadius: 3,
                fontFamily: "var(--font-mono)", fontSize: 10,
                padding: "4px 6px", cursor: "pointer",
              }}
            >
              {CROSSFADES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-3)" }}>
            <span style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.04em", color: "var(--fg-4)" }}>MASTER</span>
            <select
              value={targetLufs}
              onChange={(e) => setTargetLufs(Number(e.target.value))}
              disabled={rendering}
              style={{
                background: "var(--bg-2)", color: "var(--fg-1)",
                border: "1px solid var(--line-2)", borderRadius: 3,
                fontFamily: "var(--font-mono)", fontSize: 10,
                padding: "4px 6px", cursor: "pointer",
              }}
            >
              {TARGETS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>

          <span style={{ flex: 1 }} />

          {error && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--sfx)", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={error}>
              {error.split("\n")[0]}
            </span>
          )}

          {finalPath && !rendering && (
            <PlayButton path={finalPath} size={13} />
          )}

          <button
            className="btn btn-primary"
            onClick={handleRender}
            disabled={rendering || !realProjectId || orderedScenes.length === 0}
            title={!realProjectId ? "Open a real project" : orderedScenes.length === 0 ? "No scenes" : undefined}
          >
            <Icon name="download" style={{ width: 14, height: 14 }} />
            {rendering ? "Rendering…" : finalPath ? "Re-render episode" : "Render episode"}
          </button>
        </div>

        {/* Scene strip list */}
        <div style={{ background: "var(--bg-1)", border: "1px solid var(--line-1)", borderRadius: 4, overflow: "hidden" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "60px 60px 1fr 220px 90px 56px",
            gap: 10, padding: "8px 14px",
            background: "var(--bg-2)", borderBottom: "1px solid var(--line-1)",
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em",
            textTransform: "uppercase", color: "var(--fg-4)",
          }}>
            <div style={{ textAlign: "center" }}>Order</div>
            <div style={{ textAlign: "center" }}>State</div>
            <div>Scene</div>
            <div>Loudness</div>
            <div style={{ textAlign: "right" }}>Audition</div>
            <div style={{ textAlign: "right" }}>Status</div>
          </div>
          {orderedScenes.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--fg-4)", fontSize: 13 }}>
              No scenes — create scenes in the Pyramid first.
            </div>
          )}
          {orderedScenes.map((s, i) => {
            const slug = s.slug ?? deriveSlug(s.no, s.title);
            const meta = sceneMetaBySlug[slug] ?? null;
            const renderPath = sceneRenderPathBySlug[slug] ?? null;
            return (
              <SceneStrip
                key={s.no}
                scene={s}
                index={i}
                total={orderedScenes.length}
                rendered={Boolean(renderPath)}
                meta={meta}
                renderPath={renderPath}
                onMoveUp={() => handleMove(i, -1)}
                onMoveDown={() => handleMove(i, 1)}
              />
            );
          })}
        </div>

        <div style={{ marginTop: 16, fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6 }}>
          Scenes without a render are rendered on demand when you hit Render episode.
          The episode passes through one final loudnorm + alimiter so per-scene
          drift is corrected and the deliverable hits the chosen target.
        </div>
      </div>
    </div>
  );
};
