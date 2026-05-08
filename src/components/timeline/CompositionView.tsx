import React, { useState, useEffect, useRef, useMemo } from "react";
import { Icon, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { ScriptCanvas } from "./ScriptCanvas";
import { FountainEditor } from "./FountainEditor";
import { useProjectStore } from "../../store/projectStore";
import { useAudioStore } from "../../store/audioStore";
import { useJobStore } from "../../store/jobStore";
import { readScript, updateScriptRow, writeScript, renderScene, readRenderMeta } from "../../lib/tauriCommands";
import { useRenderMetaStore } from "../../store/renderMetaStore";
import type { MockScene, MockTrack, MockTrackClip, MockAssets, ScriptRow } from "../../lib/types";

type ScriptMode = "write" | "direct" | "mix";

const PX_PER_SEC = 4;
const TOTAL_SEC = 200;
const SNAP_SEC = 0.5;

// ── Draggable clip ───────────────────────────────────────────────────────────

interface DraggableClipProps {
  clip: MockTrackClip;
  startSec: number;
  trackIdx: number;
  clipIdx: number;
  trackKind: string;
  isSelected: boolean;
  onSelect: () => void;
  onMove: (trackIdx: number, clipIdx: number, newStartSec: number) => void;
}

const DraggableClip: React.FC<DraggableClipProps> = ({
  clip, startSec, trackIdx, clipIdx, trackKind, isSelected, onSelect, onMove,
}) => {
  const pointerStartX = useRef(0);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerStartX.current = e.clientX;
    setDragOffsetPx(0);
    setDragging(true);
    onSelect();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragOffsetPx(e.clientX - pointerStartX.current);
  };

  const handlePointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    const rawSec = startSec + dragOffsetPx / PX_PER_SEC;
    const snapped = Math.max(0, Math.round(rawSec / SNAP_SEC) * SNAP_SEC);
    onMove(trackIdx, clipIdx, snapped);
    setDragOffsetPx(0);
  };

  const effectiveLeft = (startSec * PX_PER_SEC) + dragOffsetPx;

  return (
    <div
      className={`clip ${trackKind}${isSelected ? " selected" : ""}${dragging ? " dragging" : ""}`}
      style={{
        left: effectiveLeft,
        width: clip.len * PX_PER_SEC,
        cursor: dragging ? "grabbing" : "grab",
        opacity: dragging ? 0.85 : 1,
        zIndex: dragging ? 10 : undefined,
        userSelect: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="clip-label">{clip.label}</div>
      <div className="clip-wave">
        <Wave
          width={clip.len * PX_PER_SEC}
          height={28}
          seed={trackIdx * 7 + clipIdx * 3 + 1}
          count={Math.max(20, Math.floor(clip.len * 1.6))}
        />
      </div>
    </div>
  );
};

// ── Props ────────────────────────────────────────────────────────────────────

interface CompositionViewProps {
  scene: MockScene;
  scenes: MockScene[];
  tracks: MockTrack[];
  assets: MockAssets;
  onSwitchScene: (no: string) => void;
  onOpenPyramid: () => void;
  onUpdateScene: (no: string, patch: Partial<MockScene>) => void;
}

// ── Main component ───────────────────────────────────────────────────────────

export const CompositionView: React.FC<CompositionViewProps> = ({
  scene, scenes, tracks, onSwitchScene, onOpenPyramid, onUpdateScene,
}) => {
  const [selected, setSelected]   = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [scriptRows, setScriptRows] = useState<ScriptRow[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(scene.title);
  const [renderState, setRenderState] = useState<"idle" | "rendering" | "done" | "error">("idle");
  const [renderPath, setRenderPath]   = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [mode, setMode] = useState<ScriptMode>("direct");
  // Master target loudness — podcast/streaming default. -14 = Spotify, -16 = podcast,
  // -18 = older Apple Podcasts, -23 = broadcast.
  const [targetLufs, setTargetLufs] = useState<number>(-16);
  // Per-row pending writes — keyed by row index so concurrent edits across rows
  // can't clobber each other. flushAllPendingWrites() drains the map immediately.
  const pendingWritesRef = useRef<Map<number, { timer: ReturnType<typeof setTimeout>; fields: Record<string, string> }>>(new Map());
  // Whole-script write debouncer used by Fountain mode (replaces all rows at once)
  const fountainSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { realProjectId, activeSceneSlug, characters, projectsDir } = useProjectStore();
  const { jobs } = useJobStore();

  // ── Script rows ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (realProjectId && activeSceneSlug) {
      readScript({ projectId: realProjectId, sceneSlug: activeSceneSlug })
        .then(setScriptRows)
        .catch(() => setScriptRows([]));
    } else {
      setScriptRows([]);
    }
  }, [
    realProjectId,
    activeSceneSlug,
    scene.no,
    jobs
      .filter((job) => job.scene_slug === activeSceneSlug && job.status === "complete")
      .map((job) => `${job.id}:${job.output_path ?? ""}`)
      .join("|"),
  ]);

  const handleAddRow = (row: ScriptRow) => setScriptRows((prev) => [...prev, row]);

  const handleDeleteRow = (i: number) =>
    setScriptRows((prev) => prev.filter((_, idx) => idx !== i));

  const flushRowWrite = (rowIndex: number) => {
    const entry = pendingWritesRef.current.get(rowIndex);
    if (!entry || !realProjectId || !activeSceneSlug) return;
    clearTimeout(entry.timer);
    pendingWritesRef.current.delete(rowIndex);
    updateScriptRow({
      projectId: realProjectId,
      sceneSlug: activeSceneSlug,
      rowIndex,
      fields: entry.fields,
    }).catch(console.error);
  };

  const flushAllPendingWrites = () => {
    Array.from(pendingWritesRef.current.keys()).forEach(flushRowWrite);
  };

  const handleUpdateRow = (i: number, patch: Partial<ScriptRow>) => {
    setScriptRows((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
    if (!realProjectId || !activeSceneSlug) return;
    const existing = pendingWritesRef.current.get(i);
    if (existing) clearTimeout(existing.timer);
    const merged = { ...(existing?.fields ?? {}), ...(patch as Record<string, string>) };
    const timer = setTimeout(() => flushRowWrite(i), 500);
    pendingWritesRef.current.set(i, { timer, fields: merged });
  };

  // Flush on scene switch and unmount so no edit is ever lost
  useEffect(() => {
    return () => flushAllPendingWrites();
  }, [activeSceneSlug, realProjectId]);
  useEffect(() => {
    const onBeforeUnload = () => flushAllPendingWrites();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // ── Fountain commit handler ─────────────────────────────────────────────
  // Fountain edits replace the entire row list at once; debounce to coalesce
  // typing bursts, but flush when we hide the editor or switch scenes.

  const handleFountainCommit = (nextRows: ScriptRow[]) => {
    setScriptRows(nextRows);
    if (!realProjectId || !activeSceneSlug) return;
    if (fountainSaveTimerRef.current) clearTimeout(fountainSaveTimerRef.current);
    fountainSaveTimerRef.current = setTimeout(() => {
      writeScript({
        projectId: realProjectId,
        sceneSlug: activeSceneSlug,
        rows: nextRows,
      }).catch(console.error);
    }, 600);
  };

  useEffect(() => {
    return () => {
      if (fountainSaveTimerRef.current) clearTimeout(fountainSaveTimerRef.current);
    };
  }, [activeSceneSlug, realProjectId, mode]);

  // ── Timeline tracks ──────────────────────────────────────────────────────

  const activeTracks = useMemo<MockTrack[]>(() => {
    if (!realProjectId || scriptRows.length === 0) return tracks;
    const map = new Map<string, MockTrack>();
    scriptRows.forEach((row, rowIndex) => {
      const typeUp = row.type.toUpperCase();
      if (typeUp === "DIRECTION") return;
      if (!map.has(row.track)) {
        const kind: MockTrack["kind"] =
          typeUp === "DIALOGUE" ? "dialogue" :
          typeUp === "MUSIC"    ? "music"    : "sfx";
        map.set(row.track, { id: row.track, kind, name: row.track, clips: [] });
      }
      if (row.file && row.start_ms) {
        const startSec = Number(row.start_ms) / 1000;
        const durSec   = row.duration_ms ? Number(row.duration_ms) / 1000 : 5;
        const label    = row.character || row.prompt.slice(0, 30) || row.file.split("/").pop() || "clip";
        map.get(row.track)!.clips.push({ start: startSec, len: durSec, label, take: 1, row_index: rowIndex });
      }
    });
    return Array.from(map.values());
  }, [realProjectId, scriptRows, tracks]);

  const [clipStarts, setClipStarts] = useState<number[][]>([]);
  useEffect(() => {
    setClipStarts(activeTracks.map((t) => t.clips.map((c) => c.start)));
    setSelected(null);
  }, [activeTracks]);

  const handleClipMove = (ti: number, ci: number, newStartSec: number) => {
    setClipStarts((prev) => prev.map((row, i) =>
      i === ti ? row.map((s, j) => j === ci ? newStartSec : s) : row
    ));
    if (realProjectId && activeSceneSlug) {
      const rowIndex = activeTracks[ti]?.clips[ci]?.row_index;
      if (rowIndex != null) {
        updateScriptRow({
          projectId: realProjectId,
          sceneSlug: activeSceneSlug,
          rowIndex,
          fields: { start_ms: String(Math.round(newStartSec * 1000)) },
        }).catch(console.error);
      }
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const setMeta = useRenderMetaStore((s) => s.setMeta);

  const handleRender = async () => {
    if (!realProjectId || !activeSceneSlug) return;
    setRenderState("rendering"); setRenderPath(null); setRenderError(null);
    try {
      const outPath = await renderScene(realProjectId, activeSceneSlug, targetLufs);
      setRenderPath(outPath); setRenderState("done");
      // After render, read the loudness meta the master chain wrote and surface
      // it in the transport bar. Best-effort — if the meta read fails we still
      // mark the render done.
      try {
        const meta = await readRenderMeta(outPath);
        if (meta) setMeta(activeSceneSlug, meta);
      } catch (_) { /* swallow */ }
    } catch (e) {
      setRenderError(String(e)); setRenderState("error");
    }
  };

  // On scene switch, eagerly load any prior render meta that exists on disk so
  // switching back into a scene shows its measured loudness immediately.
  useEffect(() => {
    if (!realProjectId || !activeSceneSlug || !projectsDir) return;
    const renderPath = `${projectsDir}/${realProjectId}/scenes/${activeSceneSlug}/render.wav`;
    readRenderMeta(renderPath).then((m) => { if (m) setMeta(activeSceneSlug, m); }).catch(() => {});
  }, [realProjectId, activeSceneSlug, projectsDir, setMeta]);

  // ── Misc ─────────────────────────────────────────────────────────────────

  const { playing, position } = useAudioStore();
  const playheadSec = playing ? position : 72;

  useEffect(() => {
    setTitleDraft(scene.title);
    setEditingTitle(false);
  }, [scene.no]);

  const commitTitle = () => {
    setEditingTitle(false);
    if (titleDraft !== scene.title) onUpdateScene(scene.no, { title: titleDraft });
  };

  const ruler = Array.from({ length: Math.floor(TOTAL_SEC / 20) + 1 }, (_, i) => {
    const s = i * 20;
    const m = Math.floor(s / 60);
    const ss = (s % 60).toString().padStart(2, "0");
    return <div key={s} className="ruler-tick">{m}:{ss}</div>;
  });

  // ── JSX ──────────────────────────────────────────────────────────────────

  return (
    <div className="comp" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

      {/* Header */}
      <div className="comp-header" style={{ flexShrink: 0 }}>
        <button className="btn btn-icon" onClick={onOpenPyramid} title="Back to pyramid">
          <Icon name="pyramid" style={{ width: 16, height: 16 }} />
        </button>
        <div className="comp-title-block" style={{ flex: 1, minWidth: 0 }}>
          <span className="scene-no">SCENE {scene.no} · REV.{scene.rev}</span>
          {editingTitle ? (
            <input
              className="input"
              style={{ fontSize: 16, fontWeight: 600, padding: "4px 6px" }}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => { if (e.key === "Enter") commitTitle(); if (e.key === "Escape") { setEditingTitle(false); setTitleDraft(scene.title); } }}
              autoFocus
            />
          ) : (
            <span className="scene-name" onClick={() => setEditingTitle(true)} style={{ cursor: "text" }}>
              {scene.title}
            </span>
          )}
        </div>
        <span className="kicker">Duration {scene.duration}</span>
        {/* Mode toggle: Write (full-width Fountain) · Direct (script + timeline) · Mix (timeline only) */}
        <div style={{
          display: "inline-flex", border: "1px solid var(--line-2)", borderRadius: 3,
          overflow: "hidden", marginRight: 8,
        }}>
          {(["write", "direct", "mix"] as ScriptMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                background: mode === m ? "var(--bg-2)" : "transparent",
                color: mode === m ? "var(--fg-0)" : "var(--fg-3)",
                border: "none",
                borderRight: m !== "mix" ? "1px solid var(--line-2)" : "none",
                padding: "4px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
              title={
                m === "write"  ? "Full-width Fountain script editor" :
                m === "direct" ? "Script + timeline" :
                "Timeline only"
              }
            >
              {m}
            </button>
          ))}
        </div>
        <div className="comp-header-actions">
          <button className="btn"><Icon name="sparkle" style={{ width: 14, height: 14 }} /> Agent assist</button>
          {/* Master target loudness — sets the loudnorm `I` parameter in render_scene */}
          <select
            value={targetLufs}
            onChange={(e) => setTargetLufs(Number(e.target.value))}
            disabled={renderState === "rendering"}
            title="Master target loudness — applied by loudnorm + alimiter on render"
            style={{
              background: "var(--bg-2)",
              color: "var(--fg-1)",
              border: "1px solid var(--line-2)",
              borderRadius: 3,
              fontFamily: "var(--font-mono)",
              fontSize: 9.5,
              letterSpacing: "0.05em",
              padding: "4px 6px",
              cursor: "pointer",
            }}
          >
            <option value={-14}>-14 LUFS · Spotify</option>
            <option value={-16}>-16 LUFS · Podcast</option>
            <option value={-18}>-18 LUFS · Apple</option>
            <option value={-23}>-23 LUFS · Broadcast</option>
          </select>
          {renderState === "done" && renderPath ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--st-rendered)" }}>render.wav</span>
              <PlayButton path={renderPath} size={13} />
              <button className="btn btn-primary" onClick={handleRender}>
                <Icon name="download" style={{ width: 14, height: 14 }} /> Re-render
              </button>
            </div>
          ) : renderState === "error" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--sfx)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={renderError ?? undefined}>
                {renderError?.split("\n")[0]}
              </span>
              <button className="btn btn-primary" onClick={handleRender}>Retry</button>
            </div>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleRender}
              disabled={!realProjectId || renderState === "rendering"}
              title={!realProjectId ? "Open a real project to render" : undefined}
            >
              <Icon name="download" style={{ width: 14, height: 14 }} />
              {renderState === "rendering" ? "Rendering…" : "Render scene"}
            </button>
          )}
        </div>
      </div>

      {/* Scene strip */}
      <div className="scene-strip" style={{ flexShrink: 0 }}>
        {scenes.map((s) => (
          <div
            key={s.no}
            className={`scene-chip ${s.no === scene.no ? "active" : ""}`}
            onClick={() => onSwitchScene(s.no)}
          >
            <span className={`ring ${s.status}`} />
            <span>{s.no}</span>
            <span style={{ color: "var(--fg-3)" }}>·</span>
            <span style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-ui)" }}>{s.title}</span>
          </div>
        ))}
      </div>

      {/* Main area: layout depends on mode */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {mode === "write" && (
          <FountainEditor
            key={`${activeSceneSlug ?? "demo"}:${scene.no}`}
            rows={scriptRows}
            characters={characters}
            sceneNo={scene.no}
            sceneSlug={activeSceneSlug}
            onCommitRows={handleFountainCommit}
          />
        )}

        {mode === "direct" && (
          <div style={{
            width: 300, flexShrink: 0,
            borderRight: "1px solid var(--line-1)",
            overflowY: "auto", background: "var(--bg-1)",
          }}>
            <ScriptCanvas
              rows={scriptRows}
              characters={characters}
              sceneNo={scene.no}
              sceneSlug={activeSceneSlug}
              onAdd={handleAddRow}
              onDelete={handleDeleteRow}
              onUpdate={handleUpdateRow}
            />
          </div>
        )}

        {/* Timeline (visible in direct + mix; hidden in write mode) */}
        {mode !== "write" && (
        <div className="timeline" style={{ flex: 1, overflow: "auto" }}>
          <div className="tracks-head">
            <div className="tracks-time">
              TRACKS · {activeTracks.length}
              {realProjectId && scriptRows.length > 0 && (
                <span style={{ marginLeft: 6, fontFamily: "var(--font-mono)", fontSize: 8, color: "var(--st-rendered)", textTransform: "uppercase", letterSpacing: "0.06em" }}>live</span>
              )}
            </div>
            {activeTracks.map((t) => (
              <div key={t.id} className={`track-label ${t.kind}`}>
                <div className="name">{t.name}</div>
                <div className="track-controls">
                  <button className="track-btn">M</button>
                  <button className="track-btn">S</button>
                  <button className="track-btn">REC</button>
                </div>
              </div>
            ))}
          </div>
          <div className="tracks-body">
            <div className="timeline-ruler" style={{ width: TOTAL_SEC * PX_PER_SEC }}>{ruler}</div>
            <div className="tracks-rows" style={{ width: TOTAL_SEC * PX_PER_SEC }}>
              {activeTracks.length === 0 && realProjectId && (
                <div style={{ padding: "20px 16px", fontSize: 11, color: "var(--fg-4)" }}>
                  No placed clips yet — use Place on script rows to add them to the timeline.
                </div>
              )}
              {activeTracks.map((t, ti) => (
                <div
                  key={t.id}
                  className="track-row"
                  onDragOver={(e) => { e.preventDefault(); setDropTarget(ti); }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => { e.preventDefault(); setDropTarget(null); }}
                  style={dropTarget === ti ? { boxShadow: "inset 0 0 0 1px var(--fg-0)" } : {}}
                >
                  {t.clips.map((c, ci) => (
                    <DraggableClip
                      key={ci}
                      clip={c}
                      startSec={clipStarts[ti]?.[ci] ?? c.start}
                      trackIdx={ti}
                      clipIdx={ci}
                      trackKind={t.kind}
                      isSelected={selected === `${ti}-${ci}`}
                      onSelect={() => setSelected(`${ti}-${ci}`)}
                      onMove={handleClipMove}
                    />
                  ))}
                </div>
              ))}
              <div className="playhead" style={{ left: playheadSec * PX_PER_SEC }} />
              <div className="agent-marker" style={{ left: 96 * PX_PER_SEC }} title="Agent suggestion: insert breath" />
            </div>
          </div>
        </div>
        )}

      </div>
    </div>
  );
};
