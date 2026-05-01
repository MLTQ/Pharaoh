import React, { useState, useEffect, useRef, useMemo } from "react";
import { Icon, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { ScriptCanvas } from "./ScriptCanvas";
import { useProjectStore } from "../../store/projectStore";
import { useAudioStore } from "../../store/audioStore";
import { readScript, updateScriptRow, renderScene } from "../../lib/tauriCommands";
import type { MockScene, MockTrack, MockTrackClip, MockAssets, ScriptRow } from "../../lib/types";

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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { realProjectId, activeSceneSlug, characters } = useProjectStore();

  // ── Script rows ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (realProjectId && activeSceneSlug) {
      readScript({ projectId: realProjectId, sceneSlug: activeSceneSlug })
        .then(setScriptRows)
        .catch(() => setScriptRows([]));
    } else {
      setScriptRows([]);
    }
  }, [realProjectId, activeSceneSlug, scene.no]);

  const handleAddRow = (row: ScriptRow) => setScriptRows((prev) => [...prev, row]);

  const handleDeleteRow = (i: number) =>
    setScriptRows((prev) => prev.filter((_, idx) => idx !== i));

  const handleUpdateRow = (i: number, patch: Partial<ScriptRow>) => {
    setScriptRows((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
    if (!realProjectId || !activeSceneSlug) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      updateScriptRow({
        projectId: realProjectId,
        sceneSlug: activeSceneSlug,
        rowIndex: i,
        fields: patch as Record<string, string>,
      }).catch(console.error);
    }, 5000);
  };

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

  const handleRender = async () => {
    if (!realProjectId || !activeSceneSlug) return;
    setRenderState("rendering"); setRenderPath(null); setRenderError(null);
    try {
      const outPath = await renderScene(realProjectId, activeSceneSlug);
      setRenderPath(outPath); setRenderState("done");
    } catch (e) {
      setRenderError(String(e)); setRenderState("error");
    }
  };

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
        <div className="comp-header-actions">
          <button className="btn"><Icon name="sparkle" style={{ width: 14, height: 14 }} /> Agent assist</button>
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

      {/* Main area: script canvas (left) + timeline (right) */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Script canvas */}
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

        {/* Timeline */}
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

      </div>
    </div>
  );
};
