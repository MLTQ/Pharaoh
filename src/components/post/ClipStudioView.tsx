import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon, PeaksWave, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { deriveSlug, useProjectStore } from "../../store/projectStore";
import { useAudioStore } from "../../store/audioStore";
import {
  getWaveformPeaks,
  importAudioAsset,
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

async function pickAudioFile(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "aac", "ogg", "flac", "m4a"] }],
    });
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function peaksForDisplay(peaks: number[], maxBars: number): number[] {
  if (peaks.length === 0) return peaks;
  const bucketSize = Math.max(1, Math.ceil(peaks.length / maxBars));
  const bucketed: number[] = [];
  for (let i = 0; i < peaks.length; i += bucketSize) {
    let bucketPeak = 0;
    for (let j = i; j < Math.min(i + bucketSize, peaks.length); j += 1) {
      bucketPeak = Math.max(bucketPeak, Math.abs(peaks[j]));
    }
    bucketed.push(bucketPeak);
  }
  return bucketed;
}

function normalizePeaksForDisplay(peaks: number[], maxBars: number): number[] {
  const bucketed = peaksForDisplay(peaks, maxBars);
  const max = bucketed.reduce((acc, peak) => Math.max(acc, Math.abs(peak)), 0);
  if (max <= 0.0001) return bucketed;
  return bucketed.map((peak) => Math.pow(clamp(Math.abs(peak) / max, 0, 1), 0.68));
}

function curveName(amount: number, reverse = false): string {
  const normalized = reverse ? -amount : amount;
  if (normalized > 0.35) return "qsin";
  if (normalized < -0.35) return "qua";
  return "tri";
}

interface CropWaveformProps {
  peaks: number[] | null;
  durationMs: number | null;
  startMs: number;
  endMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  fadeInCurve: number;
  fadeOutCurve: number;
  color: string;
  fallbackSeed: number;
  zoom: number;
  viewportStartMs: number;
  onStartChange: (ms: number) => void;
  onEndChange: (ms: number) => void;
  onFadeInChange: (ms: number) => void;
  onFadeOutChange: (ms: number) => void;
  onFadeInCurveChange: (amount: number) => void;
  onFadeOutCurveChange: (amount: number) => void;
  onViewportChange: (ms: number) => void;
  // Mouse wheel → cursor-anchored zoom. Caller bumps zoom and shifts viewport
  // so the timestamp under the cursor stays put on screen.
  onZoomChange: (nextZoom: number, nextViewportStartMs: number) => void;
}

const CropWaveform: React.FC<CropWaveformProps> = ({
  peaks,
  durationMs,
  startMs,
  endMs,
  fadeInMs,
  fadeOutMs,
  fadeInCurve,
  fadeOutCurve,
  color,
  fallbackSeed,
  zoom,
  viewportStartMs,
  onStartChange,
  onEndChange,
  onFadeInChange,
  onFadeOutChange,
  onFadeInCurveChange,
  onFadeOutCurveChange,
  onViewportChange,
  onZoomChange,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const duration = durationMs ?? 0;
  const active = duration > 0;
  const viewportDuration = active ? Math.max(1000, duration / zoom) : 0;
  const viewportMax = Math.max(0, duration - viewportDuration);
  const visibleStartMs = clamp(viewportStartMs, 0, viewportMax);
  const visibleEndMs = Math.min(duration, visibleStartMs + viewportDuration);
  const minGapMs = Math.min(100, Math.max(10, duration * 0.01));
  const startVisible = active && startMs >= visibleStartMs && startMs <= visibleEndMs;
  const endVisible = active && endMs >= visibleStartMs && endMs <= visibleEndMs;
  const startPct = active ? ((clamp(startMs, visibleStartMs, visibleEndMs) - visibleStartMs) / viewportDuration) * 100 : 0;
  const endPct = active ? ((clamp(endMs, visibleStartMs, visibleEndMs) - visibleStartMs) / viewportDuration) * 100 : 100;
  const fadeInEndMs = clamp(startMs + fadeInMs, startMs, endMs);
  const fadeOutStartMs = clamp(endMs - fadeOutMs, startMs, endMs);
  const fadeInEndPct = active ? ((clamp(fadeInEndMs, visibleStartMs, visibleEndMs) - visibleStartMs) / viewportDuration) * 100 : 0;
  const fadeOutStartPct = active ? ((clamp(fadeOutStartMs, visibleStartMs, visibleEndMs) - visibleStartMs) / viewportDuration) * 100 : 100;
  const fadeInVisible = active && fadeInEndMs >= visibleStartMs && fadeInEndMs <= visibleEndMs;
  const fadeOutVisible = active && fadeOutStartMs >= visibleStartMs && fadeOutStartMs <= visibleEndMs;
  const waveformHeight = 74;
  const visiblePeaks = useMemo(() => {
    if (!peaks || !active) return peaks;
    const startIndex = Math.floor((visibleStartMs / duration) * peaks.length);
    const endIndex = Math.max(startIndex + 1, Math.ceil((visibleEndMs / duration) * peaks.length));
    return normalizePeaksForDisplay(peaks.slice(startIndex, endIndex), 720);
  }, [peaks, active, visibleStartMs, visibleEndMs, duration]);
  const fadeInMidPct = (startPct + fadeInEndPct) / 2;
  const fadeOutMidPct = (fadeOutStartPct + endPct) / 2;
  const fadeInCurveYPct = clamp(52 - fadeInCurve * 28, 20, 82);
  const fadeOutCurveYPct = clamp(52 - fadeOutCurve * 28, 20, 82);

  const msFromPointer = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !active) return 0;
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
    return Math.round(visibleStartMs + pct * viewportDuration);
  };

  const curveFromPointer = (clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return 0;
    const pct = clamp((clientY - rect.top) / rect.height, 0.14, 0.86);
    return clamp((0.5 - pct) * 2.4, -1, 1);
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

  const startFadeDrag = (handle: "fadeIn" | "fadeOut", e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (clientX: number) => {
      const next = msFromPointer(clientX);
      if (handle === "fadeIn") onFadeInChange(clamp(next - startMs, 0, Math.max(0, endMs - startMs)));
      else onFadeOutChange(clamp(endMs - next, 0, Math.max(0, endMs - startMs)));
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

  const startCurveDrag = (handle: "fadeIn" | "fadeOut", e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (clientY: number) => {
      if (handle === "fadeIn") onFadeInCurveChange(curveFromPointer(clientY));
      else onFadeOutCurveChange(curveFromPointer(clientY));
    };
    move(e.clientY);
    const onMove = (ev: PointerEvent) => move(ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  // ── Cursor-anchored zoom ─────────────────────────────────────────────
  // Wheel up/right zooms in, wheel down/left zooms out. The timestamp under
  // the cursor stays fixed on screen so the user gets a "magnify here" feel
  // instead of jumping back to viewport-start.
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!active) return;
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const cursorPct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const msAtCursor = visibleStartMs + cursorPct * viewportDuration;
    // Trackpad two-finger gives small deltaY; wheel gives larger. Either way
    // we treat each "tick" as a 1.15× zoom step (smooth on trackpad, snappy
    // on a mouse wheel). Holding shift reverses for some mice.
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = Math.pow(1.15, direction * Math.min(3, Math.abs(e.deltaY) / 40));
    const nextZoom = clamp(zoom * factor, 1, 100);
    if (Math.abs(nextZoom - zoom) < 0.001) return;
    const nextViewportDuration = duration / nextZoom;
    const nextViewportStart = clamp(
      msAtCursor - cursorPct * nextViewportDuration,
      0,
      Math.max(0, duration - nextViewportDuration),
    );
    onZoomChange(nextZoom, nextViewportStart);
  };

  return (
    <div
      ref={ref}
      onWheel={handleWheel}
      style={{
        position: "relative",
        minHeight: waveformHeight + 14,
        height: "100%",
        border: "1px solid var(--line-1)",
        background: "var(--bg-0)",
        borderRadius: 2,
        padding: 7,
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {visiblePeaks ? (
        <div style={{ position: "relative", zIndex: 1 }}>
          <PeaksWave peaks={visiblePeaks} width={1000} height={waveformHeight} color={color} opacity={0.95} />
        </div>
      ) : (
        <div style={{ position: "relative", zIndex: 1 }}>
          <Wave width={1000} height={waveformHeight} seed={fallbackSeed} count={180} color={color} opacity={0.8} />
        </div>
      )}
      {active && (
        <>
          <div style={{ position: "absolute", inset: `0 ${100 - startPct}% 0 0`, background: "rgba(0,0,0,0.34)", pointerEvents: "none", opacity: startVisible ? 1 : 0.15, zIndex: 2 }} />
          <div style={{ position: "absolute", inset: `0 0 0 ${endPct}%`, background: "rgba(0,0,0,0.34)", pointerEvents: "none", opacity: endVisible ? 1 : 0.15, zIndex: 2 }} />
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{
              position: "absolute",
              inset: 7,
              zIndex: 6,
              overflow: "visible",
              pointerEvents: "none",
              filter: `drop-shadow(0 0 4px ${color})`,
            }}
          >
            <path
              d={`M ${startPct} 90 Q ${fadeInMidPct} ${fadeInCurveYPct} ${fadeInEndPct} 18 L ${fadeOutStartPct} 18 Q ${fadeOutMidPct} ${fadeOutCurveYPct} ${endPct} 90`}
              fill="none"
              stroke={color}
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
              opacity={1}
            />
            <path
              d={`M ${startPct} 90 Q ${fadeInMidPct} ${fadeInCurveYPct} ${fadeInEndPct} 18 L ${fadeOutStartPct} 18 Q ${fadeOutMidPct} ${fadeOutCurveYPct} ${endPct} 90 L ${endPct} 96 L ${startPct} 96 Z`}
              fill={color}
              opacity={0.14}
            />
          </svg>
          {fadeInVisible && (
            <div
              onPointerDown={(e) => startFadeDrag("fadeIn", e)}
              title="Drag fade-in length"
              style={{
                position: "absolute",
                left: `${fadeInEndPct}%`,
                bottom: 9,
                width: 13,
                height: 13,
                transform: "translateX(-50%) rotate(45deg)",
                background: "var(--bg-1)",
                border: `1px solid ${color}`,
                boxShadow: `0 0 10px ${color}`,
                cursor: "ew-resize",
                touchAction: "none",
                zIndex: 7,
              }}
            />
          )}
          {fadeOutVisible && (
            <div
              onPointerDown={(e) => startFadeDrag("fadeOut", e)}
              title="Drag fade-out length"
              style={{
                position: "absolute",
                left: `${fadeOutStartPct}%`,
                bottom: 9,
                width: 13,
                height: 13,
                transform: "translateX(-50%) rotate(45deg)",
                background: "var(--bg-1)",
                border: `1px solid ${color}`,
                boxShadow: `0 0 10px ${color}`,
                cursor: "ew-resize",
                touchAction: "none",
                zIndex: 7,
              }}
            />
          )}
          {fadeInMs > 0 && fadeInVisible && (
            <div
              onPointerDown={(e) => startCurveDrag("fadeIn", e)}
              title="Drag fade-in curve"
              style={{
                position: "absolute",
                left: `${fadeInMidPct}%`,
                top: `${fadeInCurveYPct}%`,
                width: 13,
                height: 13,
                transform: "translate(-50%, -50%)",
                borderRadius: "50%",
                background: color,
                border: "1px solid var(--bg-0)",
                cursor: "ns-resize",
                touchAction: "none",
                zIndex: 8,
              }}
            />
          )}
          {fadeOutMs > 0 && fadeOutVisible && (
            <div
              onPointerDown={(e) => startCurveDrag("fadeOut", e)}
              title="Drag fade-out curve"
              style={{
                position: "absolute",
                left: `${fadeOutMidPct}%`,
                top: `${fadeOutCurveYPct}%`,
                width: 13,
                height: 13,
                transform: "translate(-50%, -50%)",
                borderRadius: "50%",
                background: color,
                border: "1px solid var(--bg-0)",
                cursor: "ns-resize",
                touchAction: "none",
                zIndex: 8,
              }}
            />
          )}
          {(["start", "end"] as const).map((handle) => {
            const pct = handle === "start" ? startPct : endPct;
            const visible = handle === "start" ? startVisible : endVisible;
            if (!visible) return null;
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
                  zIndex: 5,
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
          {startMs < visibleEndMs && endMs > visibleStartMs && (
            <div style={{
              position: "absolute",
              left: `${startPct}%`,
              right: `${100 - endPct}%`,
              bottom: 5,
              height: 2,
              background: color,
              boxShadow: `0 0 10px ${color}`,
              pointerEvents: "none",
              zIndex: 4,
            }} />
          )}
          <div
            style={{ position: "absolute", inset: 0, cursor: "grab", zIndex: 3 }}
            onPointerDown={(e) => {
              if (!active || zoom <= 1) return;
              e.preventDefault();
              const startX = e.clientX;
              const initial = visibleStartMs;
              const rect = ref.current?.getBoundingClientRect();
              if (!rect) return;
              const onMove = (ev: PointerEvent) => {
                const deltaPct = (ev.clientX - startX) / rect.width;
                onViewportChange(clamp(initial - deltaPct * viewportDuration, 0, viewportMax));
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp, { once: true });
            }}
          />
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
  const [fadeInCurve, setFadeInCurve] = useState(0);
  const [fadeOutCurve, setFadeOutCurve] = useState(0);
  const [normalize, setNormalize] = useState(false);
  const [normalizeLufs, setNormalizeLufs] = useState(-16);
  const [highpassHz, setHighpassHz] = useState(0);
  const [lowpassHz, setLowpassHz] = useState(0);
  const [targetScene, setTargetScene] = useState(activeSceneNo);
  const [scriptRows, setScriptRows] = useState<ScriptRow[]>([]);
  const [targetRowIndex, setTargetRowIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportStartMs, setViewportStartMs] = useState(0);
  const playAudio = useAudioStore((state) => state.play);
  const stopAudio = useAudioStore((state) => state.stop);
  const audioPlayingPath = useAudioStore((state) => state.playing);

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
  const viewportDuration = selectedDuration ? Math.max(1000, selectedDuration / zoom) : 0;
  const viewportMax = selectedDuration ? Math.max(0, selectedDuration - viewportDuration) : 0;

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
    setFadeInMs(0);
    setFadeOutMs(0);
    setFadeInCurve(0);
    setFadeOutCurve(0);
    setZoom(1);
    setViewportStartMs(0);
  }, [selected?.audio_path]);

  useEffect(() => {
    if (!selected || peaks[selected.audio_path]) return;
    getWaveformPeaks(selected.audio_path, 12_000)
      .then((next) => setPeaks((prev) => ({ ...prev, [selected.audio_path]: next })))
      .catch(() => {});
  }, [selected?.audio_path]);

  useEffect(() => {
    setViewportStartMs((current) => clamp(current, 0, viewportMax));
  }, [viewportMax]);

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
    // Toggle: if this asset is already playing (i.e. user wants to stop and
    // look at a different clip), stop instead of restarting from startMs.
    if (audioPlayingPath === selected.audio_path) {
      stopAudio();
      return;
    }
    playAudio(
      selected.audio_path,
      Math.max(0, startMs) / 1000,
      safeEndMs > startMs ? safeEndMs / 1000 : null,
    );
  };

  const handleImportAudio = async () => {
    if (!realProjectId || importing) return;
    const sourcePath = await pickAudioFile();
    if (!sourcePath) return;
    setImporting(true);
    setError(null);
    try {
      const importedPath = await importAudioAsset({
        projectId: realProjectId,
        sourcePath,
        label: basename(sourcePath),
      });
      await listGeneratedAudioAssets(realProjectId).then((next) => {
        setAssets(next);
        setSelectedPath(importedPath);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
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
        fadeInCurve: curveName(fadeInCurve),
        fadeOutCurve: curveName(fadeOutCurve, true),
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
      <div style={{ height: "calc(100% - 180px)", width: "100%", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)" }}>
        <div style={{ borderRight: "1px solid var(--line-1)", background: "var(--bg-1)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "22px 18px 14px", borderBottom: "1px solid var(--line-1)" }}>
            <div className="eyebrow" style={{ marginBottom: 5 }}>Post</div>
            <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0 }}>Clip Studio</h1>
            <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.55, marginTop: 7 }}>
              Trim generated takes, apply practical cleanup, save child assets, or assign the result to a scene row.
            </div>
            <button
              className="btn btn-sm btn-primary"
              disabled={importing || !realProjectId}
              onClick={handleImportAudio}
              style={{ marginTop: 12 }}
            >
              <Icon name="plus" style={{ width: 12, height: 12 }} />
              {importing ? "importing..." : "Import long recording"}
            </button>
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

          <div className="clip-studio-scroll" style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
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
                      <PeaksWave peaks={normalizePeaksForDisplay(peaks[asset.audio_path], 42)} width={72} height={28} color={color} opacity={0.85} />
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

        <div className="clip-studio-scroll" style={{ overflowY: "auto", overflowX: "hidden", padding: "28px 28px 28px 34px", minWidth: 0, scrollbarGutter: "stable" }}>
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
                <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6 }}>
                  Crop, fade, zoom, and envelope handles are in the docked clip editor at the bottom of this page.
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
      <div style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 180,
        borderTop: "1px solid var(--line-1)",
        background: "color-mix(in oklch, var(--bg-1) 94%, black)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 16px",
        zIndex: 9,
      }}>
        {!selected ? (
          <div style={{ gridColumn: "1 / -1", color: "var(--fg-4)", fontSize: 13, display: "grid", placeItems: "center" }}>
            Select a generated or imported clip to edit its crop and envelope.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 0.85fr) minmax(320px, 1.35fr) minmax(150px, auto)", gap: 14, alignItems: "center", minHeight: 30 }}>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: selectedColor, boxShadow: `0 0 8px ${selectedColor}`, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{basename(selected.audio_path)}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)", marginTop: 1 }}>
                    {formatMs(startMs)} - {formatMs(safeEndMs)} · fade {fadeInMs} / {fadeOutMs} ms · in {curveName(fadeInCurve)} · out {curveName(fadeOutCurve, true)}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.35, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                {selected.prompt || "No prompt recorded."}
              </div>
              {(() => {
                const isPlayingThis = selected && audioPlayingPath === selected.audio_path;
                return (
                  <button
                    className="btn btn-sm"
                    onClick={playSelection}
                    title={isPlayingThis ? "Stop preview · Space" : "Preview crop from the left handle · Space"}
                  >
                    <Icon name={isPlayingThis ? "pause" : "play"} style={{ width: 11, height: 11 }} />
                    {isPlayingThis ? "stop" : "play crop"}
                  </button>
                );
              })()}
            </div>

            <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <CropWaveform
                peaks={peaks[selected.audio_path] ?? null}
                durationMs={selectedDuration}
                startMs={startMs}
                endMs={safeEndMs}
                fadeInMs={fadeInMs}
                fadeOutMs={fadeOutMs}
                fadeInCurve={fadeInCurve}
                fadeOutCurve={fadeOutCurve}
                color={selectedColor}
                fallbackSeed={selected.name.charCodeAt(0)}
                zoom={zoom}
                viewportStartMs={viewportStartMs}
                onStartChange={setStartMs}
                onEndChange={setEndMs}
                onFadeInChange={setFadeInMs}
                onFadeOutChange={setFadeOutMs}
                onFadeInCurveChange={setFadeInCurve}
                onFadeOutCurveChange={setFadeOutCurve}
                onViewportChange={setViewportStartMs}
                onZoomChange={(nextZoom, nextViewportStartMs) => {
                  setZoom(nextZoom);
                  setViewportStartMs(nextViewportStartMs);
                }}
              />
              <div style={{ display: "grid", gridTemplateColumns: "auto minmax(120px, 1fr) auto minmax(120px, 1fr)", gap: 9, alignItems: "center" }}>
                <span className="eyebrow">Zoom</span>
                <input
                  className="slider"
                  type="range"
                  min={1}
                  max={120}
                  step={1}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)" }}>{zoom}x</span>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={viewportMax}
                  step={100}
                  value={Math.min(viewportStartMs, viewportMax)}
                  disabled={zoom <= 1}
                  onChange={(e) => setViewportStartMs(Number(e.target.value))}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
