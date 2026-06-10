import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listSpatialSpaces } from "../../lib/tauriCommands";
import type { ScriptRow, SpatialSpace, SpatialWaypoint } from "../../lib/types";
import { reportError } from "../../lib/errors";

/**
 * Spatialize modal — place this clip in 3D space around the listener.
 *
 * Static mode: a top-down azimuth ring + an elevation slider. The user drags
 * the source dot around the listener and immediately hears the result via a
 * Web Audio HRTF PannerNode (fast, ≠ bit-accurate to the final ffmpeg render
 * but feels alive while dialing).
 *
 * Trajectory mode: an ordered list of waypoints at fractional clip times.
 * Each waypoint has its own (az, el). On render we segment the clip and
 * interpolate; on preview we schedule PannerNode position ramps to match.
 */

export interface SpatializeModalProps {
  row: ScriptRow;
  rowLabel: string;
  onSave: (fields: {
    azimuth: string;
    elevation: string;
    path: string;
    space: string;
    reverbSend: string;
  }) => void;
  onClose: () => void;
}

type Mode = "static" | "trajectory";

const RING_SIZE = 220;
const RING_RADIUS = 92;

export const SpatializeModal: React.FC<SpatializeModalProps> = ({
  row, rowLabel, onSave, onClose,
}) => {
  // ── Local edit state ────────────────────────────────────────────────────
  const initialAz = parseFloat(row.spatial_azimuth) || 0;
  const initialEl = parseFloat(row.spatial_elevation) || 0;
  const initialPath = parseWaypointsTolerant(row.spatial_path);
  const initialSpace = row.spatial_space || "anechoic";
  const initialReverbSend = parseFloat(row.reverb_send);

  const [azimuth, setAzimuth] = useState(initialAz);
  const [elevation, setElevation] = useState(initialEl);
  const [waypoints, setWaypoints] = useState<SpatialWaypoint[]>(initialPath);
  const [mode, setMode] = useState<Mode>(initialPath.length > 0 ? "trajectory" : "static");

  // ── Space catalog ────────────────────────────────────────────────────────
  const [spaces, setSpaces] = useState<SpatialSpace[]>([]);
  const [spaceSlug, setSpaceSlug] = useState<string>(initialSpace);
  // wetOverride === null → use the manifest's default_wet for the chosen space.
  // Set when the user moves the slider, persisted via the reverb_send column.
  const [wetOverride, setWetOverride] = useState<number | null>(
    Number.isFinite(initialReverbSend) && row.reverb_send.trim() !== "" ? initialReverbSend : null,
  );

  useEffect(() => {
    let cancelled = false;
    listSpatialSpaces().then((list) => {
      if (cancelled) return;
      setSpaces(list);
      // If the row's stored slug isn't in the catalog (corrupt or manifest
      // changed), fall back to anechoic. We don't quietly drop the value
      // until Save — preserves data on first read.
    }).catch((e) => {
      reportError("Could not load spatial spaces", e);
    });
    return () => { cancelled = true; };
  }, []);

  const selectedSpace: SpatialSpace | null = useMemo(
    () => spaces.find((s) => s.slug === spaceSlug) ?? null,
    [spaces, spaceSlug],
  );
  const effectiveWet: number = wetOverride != null
    ? wetOverride
    : (selectedSpace?.default_wet ?? 0);

  // Track which waypoint the dial currently controls when in trajectory mode.
  // The static (az, el) above are also the *fallback* (start point) when no
  // waypoints exist yet, so trajectory mode just exposes more handles.
  const [selectedWp, setSelectedWp] = useState<number | null>(null);

  const displayAz = mode === "trajectory" && selectedWp != null
    ? waypoints[selectedWp]?.az ?? azimuth
    : azimuth;
  const displayEl = mode === "trajectory" && selectedWp != null
    ? waypoints[selectedWp]?.el ?? elevation
    : elevation;

  const setDisplayedPosition = useCallback((az: number, el: number) => {
    if (mode === "trajectory" && selectedWp != null) {
      setWaypoints((prev) => prev.map((w, i) => i === selectedWp ? { ...w, az, el } : w));
    } else {
      setAzimuth(az);
      setElevation(el);
    }
  }, [mode, selectedWp]);

  // ── Save shape ──────────────────────────────────────────────────────────
  const handleSave = () => {
    const azStr = String(round1(((azimuth % 360) + 360) % 360));
    const elStr = String(round1(clamp(elevation, -90, 90)));
    const pathStr = mode === "trajectory" && waypoints.length > 0
      ? JSON.stringify(waypoints.map((w) => ({
          t_frac: round3(clamp(w.t_frac, 0, 1)),
          az: round1(((w.az % 360) + 360) % 360),
          el: round1(clamp(w.el, -90, 90)),
        })))
      : "";
    // Persist the space slug, treating "anechoic" as the dry baseline that
    // gets stored as empty (avoids polluting CSV with a no-op default).
    const spaceStr = spaceSlug === "anechoic" ? "" : spaceSlug;
    // Only persist a reverb_send override when the user dragged the slider.
    // Leaving it empty means "use the manifest default for the selected space",
    // which keeps Save round-trippable with the dropdown's defaults.
    const reverbStr = wetOverride != null
      ? String(round3(clamp(wetOverride, 0, 1)))
      : "";
    onSave({ azimuth: azStr, elevation: elStr, path: pathStr, space: spaceStr, reverbSend: reverbStr });
  };

  const handleClear = () => {
    // Wipe all spatial fields — caller writes empty strings, which the
    // render path treats as "no spatial data" and falls back to L/R pan.
    onSave({ azimuth: "", elevation: "", path: "", space: "", reverbSend: "" });
  };

  // ── Web Audio preview ───────────────────────────────────────────────────
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const pannerRef = useRef<PannerNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const stopPreview = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    pannerRef.current?.disconnect();
    pannerRef.current = null;
    setPreviewPlaying(false);
  }, []);

  // Keep the panner in sync with the dial in static mode. In trajectory mode
  // the schedule is set once at playback start.
  useEffect(() => {
    const panner = pannerRef.current;
    const ctx = ctxRef.current;
    if (!panner || !ctx || mode === "trajectory") return;
    const { x, y, z } = sphericalToCartesian(azimuth, elevation, 1.5);
    const t = ctx.currentTime;
    panner.positionX.setValueAtTime(x, t);
    panner.positionY.setValueAtTime(y, t);
    panner.positionZ.setValueAtTime(z, t);
  }, [azimuth, elevation, mode]);

  const startPreview = useCallback(async () => {
    if (!row.file) {
      setPreviewError("This row has no audio file assigned yet.");
      return;
    }
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      // Lazily create the AudioContext so a never-previewed modal doesn't
      // ask the browser for one.
      let ctx = ctxRef.current;
      if (!ctx) {
        ctx = new AudioContext();
        ctxRef.current = ctx;
      }
      // Resume on user gesture (this handler is one) for browsers that
      // auto-suspend.
      if (ctx.state === "suspended") await ctx.resume();

      // Decode once per modal lifetime. Subsequent previews reuse the buffer.
      if (!bufferRef.current) {
        const url = convertFileSrc(row.file);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
        const arr = await res.arrayBuffer();
        bufferRef.current = await ctx.decodeAudioData(arr);
      }

      stopPreview(); // tear down any prior playback

      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 1;
      panner.maxDistance = 100;
      panner.rolloffFactor = 0.5;
      // Listener faces -z by default; the spherical → cartesian helper below
      // is written to match that convention so az=0 lands at -z (in front).
      const src = ctx.createBufferSource();
      src.buffer = bufferRef.current;
      src.connect(panner).connect(ctx.destination);

      if (mode === "trajectory" && waypoints.length > 0 && bufferRef.current) {
        // Schedule the trajectory as ramped position changes.
        const dur = bufferRef.current.duration;
        const t0 = ctx.currentTime;
        const first = sphericalToCartesian(waypoints[0].az, waypoints[0].el, 1.5);
        panner.positionX.setValueAtTime(first.x, t0);
        panner.positionY.setValueAtTime(first.y, t0);
        panner.positionZ.setValueAtTime(first.z, t0);
        for (let i = 1; i < waypoints.length; i++) {
          const w = waypoints[i];
          const tt = t0 + w.t_frac * dur;
          const c = sphericalToCartesian(w.az, w.el, 1.5);
          panner.positionX.linearRampToValueAtTime(c.x, tt);
          panner.positionY.linearRampToValueAtTime(c.y, tt);
          panner.positionZ.linearRampToValueAtTime(c.z, tt);
        }
      } else {
        const { x, y, z } = sphericalToCartesian(azimuth, elevation, 1.5);
        panner.positionX.setValueAtTime(x, ctx.currentTime);
        panner.positionY.setValueAtTime(y, ctx.currentTime);
        panner.positionZ.setValueAtTime(z, ctx.currentTime);
      }

      src.onended = () => {
        if (sourceRef.current === src) {
          stopPreview();
        }
      };

      sourceRef.current = src;
      pannerRef.current = panner;
      src.start();
      setPreviewPlaying(true);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
      stopPreview();
    } finally {
      setPreviewLoading(false);
    }
  }, [row.file, mode, waypoints, azimuth, elevation, stopPreview]);

  // Clean up audio context on unmount.
  useEffect(() => {
    return () => {
      stopPreview();
      if (ctxRef.current) {
        ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
      bufferRef.current = null;
    };
  }, [stopPreview]);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Waypoint helpers ────────────────────────────────────────────────────
  const addWaypoint = () => {
    const lastT = waypoints.length === 0 ? 0 : waypoints[waypoints.length - 1].t_frac;
    const t = Math.min(1, lastT + 0.25);
    const newWp: SpatialWaypoint = { t_frac: t, az: azimuth, el: elevation };
    setWaypoints((prev) => [...prev, newWp].sort((a, b) => a.t_frac - b.t_frac));
    setSelectedWp(waypoints.length); // select the new one
  };

  const removeWaypoint = (i: number) => {
    setWaypoints((prev) => prev.filter((_, j) => j !== i));
    if (selectedWp === i) setSelectedWp(null);
  };

  const updateWaypoint = (i: number, patch: Partial<SpatialWaypoint>) => {
    setWaypoints((prev) => prev.map((w, j) => j === i ? { ...w, ...patch } : w)
                                .sort((a, b) => a.t_frac - b.t_frac));
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "92vw",
          maxHeight: "92vh",
          overflowY: "auto",
          background: "var(--bg-1)",
          border: "1px solid var(--fg-3)",
          borderRadius: 6,
          padding: 18,
          color: "var(--fg-0)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
          fontSize: 13,
        }}
      >
        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>
            Spatialize · <span style={{ color: "var(--fg-2)" }}>{rowLabel}</span>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* ── Mode toggle ── */}
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <ModeButton active={mode === "static"} onClick={() => setMode("static")}>
            Static
          </ModeButton>
          <ModeButton active={mode === "trajectory"} onClick={() => setMode("trajectory")}>
            Trajectory ({waypoints.length})
          </ModeButton>
        </div>

        {/* ── Dial + elevation ── */}
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <AzimuthDial
            azimuth={displayAz}
            onChange={(az) => setDisplayedPosition(az, displayEl)}
          />
          <ElevationSlider
            elevation={displayEl}
            onChange={(el) => setDisplayedPosition(displayAz, el)}
          />
          <div style={{ flex: 1, fontSize: 12, color: "var(--fg-2)" }}>
            <div style={{ marginBottom: 8 }}>
              <span style={readoutLabel}>Azimuth</span>
              <span style={readoutValue}>{displayAz.toFixed(1)}°</span>
              <div style={{ fontSize: 11, color: "var(--fg-3)" }}>
                0 = front · 90 = right · 180 = back · 270 = left
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <span style={readoutLabel}>Elevation</span>
              <span style={readoutValue}>{displayEl.toFixed(1)}°</span>
              <div style={{ fontSize: 11, color: "var(--fg-3)" }}>
                0 = ear level · ±90 = directly above/below
              </div>
            </div>
            <button
              onClick={previewPlaying ? stopPreview : startPreview}
              disabled={previewLoading || !row.file}
              style={{ ...primaryBtnStyle, width: "100%" }}
            >
              {previewLoading ? "Loading…" : previewPlaying ? "Stop preview" : "Preview"}
            </button>
            {!row.file && (
              <div style={{ fontSize: 11, color: "var(--warn)", marginTop: 6 }}>
                Assign a file to this row first to preview.
              </div>
            )}
            {previewError && (
              <div style={{ fontSize: 11, color: "var(--error, #e88)", marginTop: 6 }}>
                {previewError}
              </div>
            )}
          </div>
        </div>

        {/* ── Space (room IR) picker ── */}
        <div style={{ marginTop: 16, padding: 12, background: "var(--bg-2)", borderRadius: 4 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Space</span>
            <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
              ffmpeg afir convolution
            </span>
          </div>
          {spaces.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              No space catalog found. Run <code>./inference/download_spatial_assets.sh</code> to install the curated starter pack.
            </div>
          ) : (
            <>
              <select
                value={spaceSlug}
                onChange={(e) => {
                  setSpaceSlug(e.target.value);
                  // Reset wet override when switching spaces — new default kicks in.
                  setWetOverride(null);
                }}
                style={{
                  width: "100%",
                  background: "var(--bg-1)",
                  color: "var(--fg-0)",
                  border: "1px solid var(--fg-3)",
                  borderRadius: 3,
                  padding: "5px 8px",
                  fontSize: 13,
                  marginBottom: 8,
                }}
              >
                {spaces.map((sp) => (
                  <option
                    key={sp.slug}
                    value={sp.slug}
                    disabled={!sp.available}
                  >
                    {sp.label}{sp.available ? "" : "  (not installed)"}
                  </option>
                ))}
              </select>
              {selectedSpace && (
                <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 8 }}>
                  {selectedSpace.description}
                  {selectedSpace.source && (
                    <span style={{ display: "block", color: "var(--fg-3)", marginTop: 3 }}>
                      Source: {selectedSpace.source}{selectedSpace.license ? ` · ${selectedSpace.license}` : ""}
                    </span>
                  )}
                  {!selectedSpace.available && selectedSpace.file && (
                    <span style={{ display: "block", color: "var(--warn)", marginTop: 3 }}>
                      IR file not installed yet — run <code>./inference/download_spatial_assets.sh</code> or drop the file in <code>assets/spaces/</code>.
                    </span>
                  )}
                </div>
              )}
              {selectedSpace && selectedSpace.slug !== "anechoic" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span style={{ color: "var(--fg-3)", minWidth: 44 }}>Wet</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={effectiveWet}
                    onChange={(e) => setWetOverride(parseFloat(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{
                    color: "var(--fg-0)",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 12,
                    minWidth: 36,
                    textAlign: "right",
                  }}>
                    {Math.round(effectiveWet * 100)}%
                  </span>
                  {wetOverride != null && (
                    <button
                      onClick={() => setWetOverride(null)}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--fg-3)",
                        color: "var(--fg-2)",
                        borderRadius: 3,
                        padding: "2px 6px",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                      title="Revert to preset default"
                    >reset</button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Trajectory editor ── */}
        {mode === "trajectory" && (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>Waypoints</span>
              <button onClick={addWaypoint} style={secondaryBtnStyle}>+ Add</button>
            </div>
            {waypoints.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--fg-3)", padding: "8px 4px" }}>
                No waypoints yet. The dial above is the static fallback.
                Add a waypoint to start building a trajectory.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {waypoints.map((wp, i) => (
                  <WaypointRow
                    key={i}
                    waypoint={wp}
                    selected={selectedWp === i}
                    onSelect={() => setSelectedWp(i)}
                    onChange={(patch) => updateWaypoint(i, patch)}
                    onRemove={() => removeWaypoint(i)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end" }}>
          <button onClick={handleClear} style={dangerBtnStyle}>Clear spatial</button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={primaryBtnStyle}>Save</button>
        </div>
      </div>
    </div>
  );
};

// ── Sub-components ──────────────────────────────────────────────────────────

const AzimuthDial: React.FC<{ azimuth: number; onChange: (az: number) => void }> = ({
  azimuth, onChange,
}) => {
  const ref = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const cx = RING_SIZE / 2;
  const cy = RING_SIZE / 2;

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dx = mx - cx;
    const dy = cy - my; // flip y so up is positive
    let az = Math.atan2(dx, dy) * 180 / Math.PI;
    if (az < 0) az += 360;
    onChange(az);
  }, [dragging, cx, cy, onChange]);

  const dotPos = useMemo(() => {
    const rad = azimuth * Math.PI / 180;
    return {
      x: cx + RING_RADIUS * Math.sin(rad),
      y: cy - RING_RADIUS * Math.cos(rad),
    };
  }, [azimuth, cx, cy]);

  return (
    <svg
      ref={ref}
      width={RING_SIZE} height={RING_SIZE}
      style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        setDragging(true);
        handlePointerMove(e);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    >
      {/* Outer ring */}
      <circle cx={cx} cy={cy} r={RING_RADIUS} fill="var(--bg-2)" stroke="var(--fg-3)" strokeWidth={1} />
      {/* Cardinal ticks */}
      {[0, 90, 180, 270].map((a) => {
        const rad = a * Math.PI / 180;
        const x1 = cx + (RING_RADIUS - 6) * Math.sin(rad);
        const y1 = cy - (RING_RADIUS - 6) * Math.cos(rad);
        const x2 = cx + (RING_RADIUS + 2) * Math.sin(rad);
        const y2 = cy - (RING_RADIUS + 2) * Math.cos(rad);
        return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--fg-3)" strokeWidth={1} />;
      })}
      {/* Cardinal labels */}
      <text x={cx} y={cy - RING_RADIUS - 6} textAnchor="middle" fill="var(--fg-2)" fontSize={11}>F</text>
      <text x={cx + RING_RADIUS + 10} y={cy + 3} textAnchor="middle" fill="var(--fg-2)" fontSize={11}>R</text>
      <text x={cx} y={cy + RING_RADIUS + 14} textAnchor="middle" fill="var(--fg-2)" fontSize={11}>B</text>
      <text x={cx - RING_RADIUS - 10} y={cy + 3} textAnchor="middle" fill="var(--fg-2)" fontSize={11}>L</text>
      {/* Listener at center */}
      <circle cx={cx} cy={cy} r={5} fill="var(--fg-1)" />
      <circle cx={cx} cy={cy} r={2} fill="var(--bg-1)" />
      {/* Line from listener to source dot */}
      <line x1={cx} y1={cy} x2={dotPos.x} y2={dotPos.y} stroke="var(--tts)" strokeWidth={1} opacity={0.45} />
      {/* Source dot */}
      <circle cx={dotPos.x} cy={dotPos.y} r={8} fill="var(--tts)" stroke="var(--bg-1)" strokeWidth={2} />
    </svg>
  );
};

const ElevationSlider: React.FC<{ elevation: number; onChange: (el: number) => void }> = ({
  elevation, onChange,
}) => (
  <div style={{
    display: "flex", flexDirection: "column", alignItems: "center",
    height: RING_SIZE, justifyContent: "center", gap: 4,
  }}>
    <div style={{ fontSize: 10, color: "var(--fg-3)" }}>+90°</div>
    <input
      type="range"
      min={-90}
      max={90}
      step={1}
      value={Math.round(elevation)}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      style={{
        // vertical: rotate -90° so dragging up = +el
        writingMode: "vertical-lr" as const,
        // legacy webkit; supported broadly
        WebkitAppearance: "slider-vertical" as unknown as undefined,
        width: 28,
        height: RING_SIZE - 40,
      }}
    />
    <div style={{ fontSize: 10, color: "var(--fg-3)" }}>−90°</div>
  </div>
);

const WaypointRow: React.FC<{
  waypoint: SpatialWaypoint;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<SpatialWaypoint>) => void;
  onRemove: () => void;
}> = ({ waypoint, selected, onSelect, onChange, onRemove }) => (
  <div
    onClick={onSelect}
    style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 8px",
      background: selected ? "var(--bg-2)" : "transparent",
      border: `1px solid ${selected ? "var(--tts)" : "var(--fg-3)"}`,
      borderRadius: 4,
      cursor: "pointer",
      fontSize: 12,
    }}
  >
    <span style={{ color: "var(--fg-2)", minWidth: 50 }}>
      t = {waypoint.t_frac.toFixed(2)}
    </span>
    <input
      type="range"
      min={0} max={1} step={0.01}
      value={waypoint.t_frac}
      onChange={(e) => onChange({ t_frac: parseFloat(e.target.value) })}
      onClick={(e) => e.stopPropagation()}
      style={{ flex: 1 }}
    />
    <NumberSpin
      label="az"
      value={waypoint.az}
      min={0} max={360} step={1}
      onChange={(v) => onChange({ az: ((v % 360) + 360) % 360 })}
    />
    <NumberSpin
      label="el"
      value={waypoint.el}
      min={-90} max={90} step={1}
      onChange={(v) => onChange({ el: clamp(v, -90, 90) })}
    />
    <button
      onClick={(e) => { e.stopPropagation(); onRemove(); }}
      style={{
        background: "transparent",
        border: "none",
        color: "var(--fg-2)",
        cursor: "pointer",
        fontSize: 16,
        padding: "0 4px",
      }}
      title="Remove waypoint"
    >×</button>
  </div>
);

const NumberSpin: React.FC<{
  label: string;
  value: number;
  min: number; max: number; step: number;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, onChange }) => (
  <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11 }}>
    <span style={{ color: "var(--fg-3)" }}>{label}</span>
    <input
      type="number"
      min={min} max={max} step={step}
      value={Math.round(value)}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      onClick={(e) => e.stopPropagation()}
      style={{
        width: 52,
        background: "var(--bg-1)",
        border: "1px solid var(--fg-3)",
        color: "var(--fg-0)",
        borderRadius: 3,
        padding: "2px 4px",
        fontSize: 11,
      }}
    />
  </label>
);

const ModeButton: React.FC<React.PropsWithChildren<{ active: boolean; onClick: () => void }>> = ({
  active, onClick, children,
}) => (
  <button
    onClick={onClick}
    style={{
      padding: "6px 12px",
      background: active ? "var(--tts)" : "var(--bg-2)",
      color: active ? "var(--bg-0)" : "var(--fg-0)",
      border: `1px solid ${active ? "var(--tts)" : "var(--fg-3)"}`,
      borderRadius: 4,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: active ? 600 : 400,
    }}
  >
    {children}
  </button>
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Spherical (azimuth, elevation, distance) → Cartesian for Web Audio's
 * PannerNode. Web Audio's listener faces -z by default, so:
 *   az = 0   (front) → (0, 0, -d)
 *   az = 90  (right) → (+d, 0, 0)
 *   az = 180 (back)  → (0, 0, +d)
 *   az = 270 (left)  → (-d, 0, 0)
 * Elevation tilts up/down on the y axis.
 */
function sphericalToCartesian(azDeg: number, elDeg: number, distance: number) {
  const az = azDeg * Math.PI / 180;
  const el = elDeg * Math.PI / 180;
  const xz = Math.cos(el) * distance;
  return {
    x: xz * Math.sin(az),
    y: distance * Math.sin(el),
    z: -xz * Math.cos(az),
  };
}

function parseWaypointsTolerant(json: string): SpatialWaypoint[] {
  const trimmed = (json ?? "").trim();
  if (!trimmed) return [];
  try {
    const raw = JSON.parse(trimmed);
    if (!Array.isArray(raw)) return [];
    const out: SpatialWaypoint[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const t_frac = Number((item as { t_frac?: unknown }).t_frac);
      const az = Number((item as { az?: unknown }).az);
      const el = Number((item as { el?: unknown }).el);
      if (Number.isFinite(t_frac) && Number.isFinite(az) && Number.isFinite(el)) {
        out.push({
          t_frac: clamp(t_frac, 0, 1),
          az: ((az % 360) + 360) % 360,
          el: clamp(el, -90, 90),
        });
      }
    }
    out.sort((a, b) => a.t_frac - b.t_frac);
    return out;
  } catch {
    return [];
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function round1(v: number) { return Math.round(v * 10) / 10; }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

const closeBtnStyle: React.CSSProperties = {
  background: "transparent", border: "none", color: "var(--fg-2)",
  fontSize: 20, cursor: "pointer", padding: "0 4px",
};
const primaryBtnStyle: React.CSSProperties = {
  background: "var(--tts)", color: "var(--bg-0)", border: "none",
  borderRadius: 4, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const secondaryBtnStyle: React.CSSProperties = {
  background: "var(--bg-2)", color: "var(--fg-0)",
  border: "1px solid var(--fg-3)", borderRadius: 4,
  padding: "6px 12px", cursor: "pointer", fontSize: 12,
};
const dangerBtnStyle: React.CSSProperties = {
  background: "transparent", color: "var(--fg-2)",
  border: "1px solid var(--fg-3)", borderRadius: 4,
  padding: "6px 12px", cursor: "pointer", fontSize: 12,
};
const readoutLabel: React.CSSProperties = {
  color: "var(--fg-3)", marginRight: 6, fontSize: 11,
};
const readoutValue: React.CSSProperties = {
  color: "var(--fg-0)", fontFamily: "ui-monospace, monospace", fontSize: 13,
};
