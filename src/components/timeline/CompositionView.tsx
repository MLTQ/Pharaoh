import React, { useState, useEffect, useRef, useMemo } from "react";
import { Icon, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { ScriptCanvas } from "./ScriptCanvas";
import { FountainEditor } from "./FountainEditor";
import { TakesPopover } from "./TakesPopover";
import { deriveSlug, useProjectStore } from "../../store/projectStore";
import { useAudioStore } from "../../store/audioStore";
import { useJobStore } from "../../store/jobStore";
import { readScript, updateScriptRow, writeScript, renderScene, readRenderMeta } from "../../lib/tauriCommands";
import {
  ASSET_DRAG_MIME,
  ASSET_POINTER_DROP_EVENT,
  getCurrentDraggedAsset,
  SCRIPT_ASSETS_CHANGED_EVENT,
  type AssetPointerDropDetail,
  type DraggedAssetPayload,
  type RoutableAssetKind,
} from "../../lib/assetRouting";
import { useRenderMetaStore } from "../../store/renderMetaStore";
import type { MockScene, MockTrack, MockTrackClip, MockAssets, ScriptRow, TrackType } from "../../lib/types";

type ScriptMode = "write" | "direct" | "mix";

const PX_PER_SEC = 4;
const TOTAL_SEC = 200;
const SNAP_SEC = 0.5;

type DraggedAsset = DraggedAssetPayload;

function trackKindForAsset(kind: RoutableAssetKind): MockTrack["kind"] {
  if (kind === "tts") return "dialogue";
  if (kind === "music") return "music";
  return "sfx";
}

function rowTypeForAsset(kind: RoutableAssetKind): TrackType {
  if (kind === "tts") return "DIALOGUE";
  if (kind === "music") return "MUSIC";
  return "SFX";
}

function defaultTrackNameForAsset(asset: DraggedAsset): string {
  if (asset.kind === "tts") return asset.character?.trim() || asset.track?.trim() || asset.label.split(/[_.]/)[0].toUpperCase() || "DIALOGUE";
  if (asset.kind === "music") return asset.track?.trim() || "MUSIC";
  return asset.track?.trim() || "SFX";
}

function uniqueTrackName(base: string, tracks: MockTrack[]): string {
  const names = new Set(tracks.map((track) => track.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let index = 2;
  while (names.has(`${base} ${index}`.toLowerCase())) index += 1;
  return `${base} ${index}`;
}

function blankScriptRow(sceneNo: string, asset: DraggedAsset, track: string, startMs: number): ScriptRow {
  const prompt = asset.prompt ?? "";
  return {
    scene: sceneNo,
    track,
    type: rowTypeForAsset(asset.kind),
    character: asset.kind === "tts" ? (asset.character ?? track) : "",
    prompt,
    file: asset.audioPath,
    start_ms: String(startMs),
    duration_ms: asset.durationMs != null ? String(asset.durationMs) : "",
    loop: "",
    pan: "0",
    gain_db: "0",
    instruct: "",
    fade_in_ms: "",
    fade_out_ms: "",
    reverb_send: "0",
    emotion: "",
    notes: "",
  };
}

function parseDraggedAsset(event: React.DragEvent): DraggedAsset | null {
  const candidates = [
    event.dataTransfer.getData(ASSET_DRAG_MIME),
    event.dataTransfer.getData("application/json"),
    event.dataTransfer.getData("text/plain"),
  ].filter(Boolean);

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as DraggedAsset;
      if (!parsed.audioPath || !["tts", "sfx", "music"].includes(parsed.kind)) continue;
      return parsed;
    } catch {
      continue;
    }
  }

  return getCurrentDraggedAsset();
}

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
  onTrim: (trackIdx: number, clipIdx: number, newDurationSec: number) => void;
  onRequestTakes: (rowIndex: number, x: number, y: number) => void;
}

const DraggableClip: React.FC<DraggableClipProps> = ({
  clip, startSec, trackIdx, clipIdx, trackKind, isSelected, onSelect, onMove, onTrim, onRequestTakes,
}) => {
  const pointerStartX = useRef(0);
  const trimStartLen = useRef(0);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [trimDeltaPx, setTrimDeltaPx] = useState(0);
  const [trimming, setTrimming] = useState(false);

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

  // ── Right-edge trim ───────────────────────────────────────────────────
  // The trim handle is its own pointer surface so it doesn't fight with the
  // body's drag-to-move. Updates the row's duration_ms, which the renderer
  // honors via atrim — the audio is actually shortened on render, not just
  // the visual width.

  const handleTrimDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerStartX.current = e.clientX;
    trimStartLen.current = clip.len;
    setTrimDeltaPx(0);
    setTrimming(true);
    onSelect();
  };

  const handleTrimMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!trimming) return;
    setTrimDeltaPx(e.clientX - pointerStartX.current);
  };

  const handleTrimUp = () => {
    if (!trimming) return;
    setTrimming(false);
    const rawLen = trimStartLen.current + trimDeltaPx / PX_PER_SEC;
    // Floor at 0.1s so the user can't trim a clip out of existence
    const newLen = Math.max(0.1, Math.round(rawLen / SNAP_SEC) * SNAP_SEC);
    onTrim(trackIdx, clipIdx, newLen);
    setTrimDeltaPx(0);
  };

  const effectiveLeft = (startSec * PX_PER_SEC) + dragOffsetPx;
  const effectiveWidth = (clip.len + (trimming ? trimDeltaPx / PX_PER_SEC : 0)) * PX_PER_SEC;

  return (
    <div
      className={`clip ${trackKind}${isSelected ? " selected" : ""}${dragging ? " dragging" : ""}`}
      style={{
        left: effectiveLeft,
        width: effectiveWidth,
        cursor: dragging ? "grabbing" : "grab",
        opacity: dragging || trimming ? 0.85 : 1,
        zIndex: dragging || trimming ? 10 : undefined,
        userSelect: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(e) => {
        // Right-click → open Takes popover for this clip's source row.
        // Only meaningful for clips derived from a real script row.
        if (clip.row_index == null) return;
        e.preventDefault();
        e.stopPropagation();
        onRequestTakes(clip.row_index, e.clientX, e.clientY);
      }}
      title="Drag body to move · drag right edge to trim · right-click for takes"
    >
      <div className="clip-label">{clip.label}</div>
      <div className="clip-wave">
        <Wave
          width={effectiveWidth}
          height={28}
          seed={trackIdx * 7 + clipIdx * 3 + 1}
          count={Math.max(20, Math.floor((clip.len + (trimming ? trimDeltaPx / PX_PER_SEC : 0)) * 1.6))}
        />
      </div>
      {/* Right-edge trim handle. Sits over the rightmost 6px of the clip;
          its own pointer events don't bubble to the body's drag handler. */}
      <div
        onPointerDown={handleTrimDown}
        onPointerMove={handleTrimMove}
        onPointerUp={handleTrimUp}
        title="Drag to trim"
        style={{
          position: "absolute",
          top: 0, right: 0, bottom: 0,
          width: 6,
          cursor: "ew-resize",
          background: trimming || isSelected
            ? "color-mix(in oklch, var(--fg-0) 30%, transparent)"
            : "transparent",
          borderRight: trimming ? "1px solid var(--fg-0)" : "1px solid transparent",
        }}
      />
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
  const [sceneRenderState, setSceneRenderState] = useState<Record<string, "idle" | "rendering" | "error">>({});
  // Master target loudness — podcast/streaming default. -14 = Spotify, -16 = podcast,
  // -18 = older Apple Podcasts, -23 = broadcast.
  const [targetLufs, setTargetLufs] = useState<number>(-16);
  // Take family popover anchor — set on right-click of a timeline clip
  const [takesPopover, setTakesPopover] = useState<{ rowIndex: number; x: number; y: number } | null>(null);
  // Per-row pending writes — keyed by row index so concurrent edits across rows
  // can't clobber each other. flushAllPendingWrites() drains the map immediately.
  const pendingWritesRef = useRef<Map<number, { timer: ReturnType<typeof setTimeout>; fields: Record<string, string> }>>(new Map());
  // Whole-script write debouncer used by Fountain mode (replaces all rows at once)
  const fountainSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tracksRowsRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    const refreshScript = () => {
      if (!realProjectId || !activeSceneSlug) return;
      readScript({ projectId: realProjectId, sceneSlug: activeSceneSlug })
        .then(setScriptRows)
        .catch(() => setScriptRows([]));
    };
    window.addEventListener(SCRIPT_ASSETS_CHANGED_EVENT, refreshScript);
    return () => window.removeEventListener(SCRIPT_ASSETS_CHANGED_EVENT, refreshScript);
  }, [realProjectId, activeSceneSlug]);

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

  const trackNameForAssetDrop = (asset: DraggedAsset, compatibleTarget?: MockTrack): string => {
    if (compatibleTarget) return compatibleTarget.name;

    const base = defaultTrackNameForAsset(asset);
    if (asset.kind === "tts") {
      const existingDialogueTrack = activeTracks.find((track) =>
        track.kind === "dialogue" && track.name.toLowerCase() === base.toLowerCase()
      );
      return existingDialogueTrack?.name ?? uniqueTrackName(base, activeTracks);
    }

    return uniqueTrackName(base, activeTracks);
  };

  const placeDraggedAsset = async (asset: DraggedAsset, startSec: number, targetTrack?: MockTrack) => {
    if (!realProjectId || !activeSceneSlug) return;

    const requiredTrackKind = trackKindForAsset(asset.kind);
    const compatibleTarget = targetTrack?.kind === requiredTrackKind ? targetTrack : undefined;
    const track = trackNameForAssetDrop(asset, compatibleTarget);
    const startMs = Math.round(startSec * 1000);
    const rowType = rowTypeForAsset(asset.kind);

    const shouldReuseExisting = asset.kind === "tts" || !!compatibleTarget;
    const existingIndex = shouldReuseExisting
      ? scriptRows.findIndex((row) => row.file === asset.audioPath && row.type === rowType)
      : -1;

    if (existingIndex >= 0) {
      const patch: Partial<ScriptRow> = {
        track,
        file: asset.audioPath,
        start_ms: String(startMs),
      };
      if (asset.durationMs != null) patch.duration_ms = String(asset.durationMs);
      if (asset.kind === "tts") patch.character = asset.character ?? track;

      setScriptRows((prev) => prev.map((row, index) => index === existingIndex ? { ...row, ...patch } : row));
      await updateScriptRow({
        projectId: realProjectId,
        sceneSlug: activeSceneSlug,
        rowIndex: existingIndex,
        fields: patch as Record<string, string>,
      });
    } else {
      const nextRows = [
        ...scriptRows,
        blankScriptRow(scene.no, asset, track, startMs),
      ];
      setScriptRows(nextRows);
      await writeScript({ projectId: realProjectId, sceneSlug: activeSceneSlug, rows: nextRows });
    }

    window.dispatchEvent(new CustomEvent(SCRIPT_ASSETS_CHANGED_EVENT, {
      detail: { projectId: realProjectId, sceneSlug: activeSceneSlug },
    }));
  };

  const handleAssetDrop = (event: React.DragEvent, targetTrack?: MockTrack) => {
    const asset = parseDraggedAsset(event);
    if (!asset) return false;

    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);

    const rect = tracksRowsRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const rawSec = Math.max(0, localX / PX_PER_SEC);
    const snapped = Math.round(rawSec / SNAP_SEC) * SNAP_SEC;
    placeDraggedAsset(asset, snapped, targetTrack).catch((error) => {
      console.error("[CompositionView] asset drop failed", error);
    });
    return true;
  };

  useEffect(() => {
    const handlePointerAssetDrop = (event: Event) => {
      const detail = (event as CustomEvent<AssetPointerDropDetail>).detail;
      if (!detail?.asset || !tracksRowsRef.current) return;

      const rect = tracksRowsRef.current.getBoundingClientRect();
      if (
        detail.clientX < rect.left
        || detail.clientX > rect.right
        || detail.clientY < rect.top
        || detail.clientY > rect.bottom
      ) {
        return;
      }

      const localX = detail.clientX - rect.left;
      const localY = detail.clientY - rect.top;
      const startSec = Math.max(0, Math.round((localX / PX_PER_SEC) / SNAP_SEC) * SNAP_SEC);
      const trackIndex = Math.floor(localY / 76);
      const targetTrack = trackIndex >= 0 && trackIndex < activeTracks.length ? activeTracks[trackIndex] : undefined;

      placeDraggedAsset(detail.asset, startSec, targetTrack).catch((error) => {
        console.error("[CompositionView] pointer asset drop failed", error);
      });
    };

    window.addEventListener(ASSET_POINTER_DROP_EVENT, handlePointerAssetDrop);
    return () => window.removeEventListener(ASSET_POINTER_DROP_EVENT, handlePointerAssetDrop);
  }, [activeTracks, activeSceneSlug, realProjectId, scriptRows]);

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

  const handleClipTrim = (ti: number, ci: number, newDurationSec: number) => {
    // Optimistically update local state so the visual width sticks immediately
    setScriptRows((prev) => {
      const rowIndex = activeTracks[ti]?.clips[ci]?.row_index;
      if (rowIndex == null || !prev[rowIndex]) return prev;
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], duration_ms: String(Math.round(newDurationSec * 1000)) };
      return next;
    });
    if (realProjectId && activeSceneSlug) {
      const rowIndex = activeTracks[ti]?.clips[ci]?.row_index;
      if (rowIndex != null) {
        updateScriptRow({
          projectId: realProjectId,
          sceneSlug: activeSceneSlug,
          rowIndex,
          fields: { duration_ms: String(Math.round(newDurationSec * 1000)) },
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

  // ── Playhead scrub & spacebar ─────────────────────────────────────────────

  const { playing, position, play: playAudio, stop: stopAudio } = useAudioStore();

  // parkedSec: where the playhead sits when nothing is playing.
  // It updates live from position while playing, and gets locked in place on stop.
  const [parkedSec, setParkedSec] = useState(0);
  const parkedSecRef = useRef(0);           // readable in event callbacks without stale closure
  const isScrubbing = useRef(false);

  // Keep parked position in sync with playback position
  useEffect(() => {
    if (playing) {
      parkedSecRef.current = position;
      setParkedSec(position);
    }
  }, [playing, position]);

  const playheadSec = playing ? position : parkedSec;

  // The active scene's render path (may not exist yet if never rendered)
  const activeRenderPath = realProjectId && activeSceneSlug && projectsDir
    ? `${projectsDir}/${realProjectId}/scenes/${activeSceneSlug}/render.wav`
    : null;

  // Ruler ref for scrub hit testing
  const rulerRef = useRef<HTMLDivElement | null>(null);

  const secFromRulerEvent = (e: { clientX: number }): number => {
    if (!rulerRef.current) return 0;
    const rect = rulerRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(TOTAL_SEC, (e.clientX - rect.left) / PX_PER_SEC));
  };

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    isScrubbing.current = true;
    const sec = secFromRulerEvent(e);
    parkedSecRef.current = sec;
    setParkedSec(sec);
    // If currently playing, seek immediately
    if (playing) {
      playAudio(playing, sec).catch(() => {});
    }
  };

  const handleRulerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing.current) return;
    const sec = secFromRulerEvent(e);
    parkedSecRef.current = sec;
    setParkedSec(sec);
    if (playing) {
      playAudio(playing, sec).catch(() => {});
    }
  };

  const handleRulerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing.current) return;
    isScrubbing.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Spacebar: play/pause the active scene render from the parked position
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Don't steal space from text inputs, textareas, contenteditable
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.code !== "Space") return;
      e.preventDefault();

      if (playing) {
        // Pause — stop and park at current position
        const pos = parkedSecRef.current;
        stopAudio();
        setParkedSec(pos);
        parkedSecRef.current = pos;
      } else if (activeRenderPath) {
        // Play from parked position
        playAudio(activeRenderPath, parkedSecRef.current).catch(console.error);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [playing, activeRenderPath, playAudio, stopAudio]);

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

  const sceneSlugFor = (target: MockScene) => target.slug ?? deriveSlug(target.no, target.title);
  const sceneRenderPath = (target: MockScene) =>
    realProjectId && projectsDir ? `${projectsDir}/${realProjectId}/scenes/${sceneSlugFor(target)}/render.wav` : null;

  const handleScenePlay = async (event: React.MouseEvent, target: MockScene) => {
    event.stopPropagation();
    if (!realProjectId || !projectsDir) return;
    const slug = sceneSlugFor(target);
    const path = sceneRenderPath(target);
    if (!path) return;

    if (playing === path) {
      const pos = parkedSecRef.current;
      stopAudio();
      setParkedSec(pos);
      parkedSecRef.current = pos;
      return;
    }

    setSceneRenderState((prev) => ({ ...prev, [slug]: "rendering" }));
    try {
      const existingMeta = await readRenderMeta(path);
      const outputPath = existingMeta ? path : await renderScene(realProjectId, slug, targetLufs);
      try {
        const meta = existingMeta ?? await readRenderMeta(outputPath);
        if (meta) setMeta(slug, meta);
      } catch (_) { /* best-effort metadata */ }
      setSceneRenderState((prev) => ({ ...prev, [slug]: "idle" }));
      // Start from the parked position if this is the active scene, else from 0
      const offset = (slug === activeSceneSlug) ? parkedSecRef.current : 0;
      await playAudio(outputPath, offset);
    } catch (error) {
      console.error("[CompositionView] scene playback failed", error);
      setSceneRenderState((prev) => ({ ...prev, [slug]: "error" }));
    }
  };

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
        {scenes.map((s) => {
          const slug = sceneSlugFor(s);
          const renderPathForScene = sceneRenderPath(s);
          const isPlayingScene = !!renderPathForScene && playing === renderPathForScene;
          const renderBusy = sceneRenderState[slug] === "rendering";
          const renderFailed = sceneRenderState[slug] === "error";
          return (
            <div
              key={s.no}
              className={`scene-chip ${s.no === scene.no ? "active" : ""}`}
              onClick={() => onSwitchScene(s.no)}
            >
              <button
                className="btn btn-sm"
                onClick={(event) => handleScenePlay(event, s)}
                disabled={!realProjectId || renderBusy}
                title={renderBusy ? "Rendering scene before playback" : isPlayingScene ? "Stop scene" : "Play scene"}
                style={{
                  padding: "1px 4px",
                  minWidth: 0,
                  lineHeight: 1,
                  borderColor: isPlayingScene ? "var(--st-rendered)" : renderFailed ? "var(--sfx)" : undefined,
                  color: isPlayingScene ? "var(--st-rendered)" : renderFailed ? "var(--sfx)" : undefined,
                }}
              >
                <Icon name={isPlayingScene ? "pause" : "play"} style={{ width: 10, height: 10, opacity: renderBusy ? 0.35 : 1 }} />
              </button>
              <span className={`ring ${s.status}`} />
              <span>{s.no}</span>
              <span style={{ color: "var(--fg-3)" }}>·</span>
              <span style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-ui)" }}>{s.title}</span>
            </div>
          );
        })}
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
            <div
              ref={rulerRef}
              className="timeline-ruler"
              style={{ width: TOTAL_SEC * PX_PER_SEC, cursor: "col-resize", userSelect: "none" }}
              onPointerDown={handleRulerPointerDown}
              onPointerMove={handleRulerPointerMove}
              onPointerUp={handleRulerPointerUp}
            >{ruler}</div>
            <div
              ref={tracksRowsRef}
              className="tracks-rows"
              style={{
                width: TOTAL_SEC * PX_PER_SEC,
                boxShadow: dropTarget === -1 ? "inset 0 0 0 1px var(--fg-0)" : undefined,
              }}
              onDragOver={(e) => {
                // Some WebKit/Tauri builds do not expose custom MIME types
                // reliably during dragover. Always allow the drop, then parse
                // and reject non-asset payloads in onDrop.
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropTarget(-1);
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                setDropTarget(null);
                handleAssetDrop(e);
              }}
            >
              {activeTracks.length === 0 && realProjectId && (
                <div style={{ padding: "20px 16px", fontSize: 11, color: "var(--fg-4)" }}>
                  No placed clips yet — drag an asset here to create a track.
                </div>
              )}
              {activeTracks.map((t, ti) => (
                <div
                  key={t.id}
                  className="track-row"
                  onDragOver={(e) => {
                    // Accept asset drops and script-row moves. Without
                    // preventDefault the drop event won't fire on this element.
                    const types = Array.from(e.dataTransfer.types || []);
                    const isAssetDrop =
                      types.includes(ASSET_DRAG_MIME)
                      || types.includes("application/json")
                      || types.includes("text/plain")
                      || !!getCurrentDraggedAsset();
                    if (!isAssetDrop && !types.includes("application/x-pharaoh-script-row")) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = isAssetDrop ? "copy" : "move";
                    setDropTarget(ti);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => {
                    if (handleAssetDrop(e, t)) return;

                    e.preventDefault();
                    setDropTarget(null);
                    const data = e.dataTransfer.getData("application/x-pharaoh-script-row");
                    if (!data) return;
                    let payload: { rowIndex: number; type: string; track: string };
                    try { payload = JSON.parse(data); } catch { return; }
                    // Compute drop position in seconds relative to this track row's left edge
                    const rect = e.currentTarget.getBoundingClientRect();
                    const xInTrack = e.clientX - rect.left;
                    const rawSec = Math.max(0, xInTrack / PX_PER_SEC);
                    const snapped = Math.round(rawSec / SNAP_SEC) * SNAP_SEC;
                    // Build the patch: always set start_ms; only swap track when
                    // the kinds match (don't put a music clip on a dialogue lane)
                    const patch: Partial<ScriptRow> = { start_ms: String(Math.round(snapped * 1000)) };
                    const sourceType = payload.type.toUpperCase();
                    const sourceKind: MockTrack["kind"] =
                      sourceType === "DIALOGUE" ? "dialogue" :
                      sourceType === "MUSIC"    ? "music"    :
                      sourceType === "BED" || sourceType === "SFX" ? "sfx" : "sfx";
                    if (sourceKind === t.kind && payload.track !== t.id) {
                      patch.track = t.id;
                    }
                    handleUpdateRow(payload.rowIndex, patch);
                  }}
                  style={dropTarget === ti ? {
                    boxShadow: `inset 0 0 0 2px var(--${t.kind === "dialogue" ? "tts" : t.kind === "music" ? "music" : "sfx"})`,
                    background: `color-mix(in oklch, var(--${t.kind === "dialogue" ? "tts" : t.kind === "music" ? "music" : "sfx"}) 6%, transparent)`,
                  } : {}}
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
                      onTrim={handleClipTrim}
                      onRequestTakes={(rowIndex, x, y) => setTakesPopover({ rowIndex, x, y })}
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

      {/* Takes popover — anchored to the right-clicked clip */}
      {takesPopover && (
        <TakesPopover
          projectId={realProjectId}
          sceneSlug={activeSceneSlug}
          rowIndex={takesPopover.rowIndex}
          row={scriptRows[takesPopover.rowIndex] ?? null}
          x={takesPopover.x}
          y={takesPopover.y}
          onClose={() => setTakesPopover(null)}
          onTakeApplied={(newRow) => {
            setScriptRows((prev) => prev.map((r, i) => i === takesPopover.rowIndex ? newRow : r));
          }}
        />
      )}
    </div>
  );
};
