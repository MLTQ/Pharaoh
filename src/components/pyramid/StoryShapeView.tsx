import React, { useCallback, useRef, useState } from "react";
import type { MockScene } from "../../lib/types";
import { buildCurve, clamp01, toShapePoints } from "../../lib/storyShape";

interface StoryShapeViewProps {
  scenes: MockScene[];
  activeSceneNo: string;
  /** Pixel geometry inside the pyramid's fixed 1280×760 coordinate space. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** `null` clears the scene back to unshaped. */
  onSetTension: (sceneNo: string, tension: number | null) => void;
  onOpenScene: (sceneNo: string) => void;
}

interface DragState {
  no: string;
  startClientY: number;
  startTension: number;
  tension: number;
}

const AXIS_W = 44;   // left gutter for the tension axis
const LABEL_H = 46;  // bottom gutter for scene labels
const NODE_R = 7;

/** Value an unshaped node sits at while it has no authored tension. Purely a
 *  rendering/drag-origin choice — it is never written to the scene. */
const UNSET_REST = 0.5;

export const StoryShapeView: React.FC<StoryShapeViewProps> = ({
  scenes, activeSceneNo, left, top, width, height, onSetTension, onOpenScene,
}) => {
  const plotRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const plotW = Math.max(0, width - AXIS_W);
  const plotH = Math.max(0, height - LABEL_H);
  const n = scenes.length;
  const colW = n > 0 ? plotW / n : 0;

  // Data space (x = scene index, y = tension) → pixels inside the plot.
  const cx = (i: number) => colW * (i + 0.5);
  const cy = (t: number) => (1 - t) * plotH;

  /** Live tension for a scene: the in-flight drag wins over stored value. */
  const tensionOf = (s: MockScene): number | null =>
    drag?.no === s.no ? drag.tension : s.tension ?? null;

  const displayScenes = scenes.map((s) => ({ ...s, tension: tensionOf(s) }));
  const points = toShapePoints(displayScenes);
  const segments = buildCurve(points);

  const toPath = (samples: { x: number; y: number }[]) =>
    samples.map((p, i) => `${i === 0 ? "M" : "L"} ${cx(p.x)} ${cy(p.y)}`).join(" ");

  // ── Drag ────────────────────────────────────────────────────────────────
  // Delta-based against the plot's *screen* rect, so the pyramid's CSS scale
  // transform never desyncs the pointer from the node.

  const onPointerDown = useCallback(
    (e: React.PointerEvent, s: MockScene) => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({
        no: s.no,
        startClientY: e.clientY,
        startTension: s.tension ?? UNSET_REST,
        tension: s.tension ?? UNSET_REST,
      });
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const rect = plotRef.current?.getBoundingClientRect();
      if (!rect || rect.height === 0) return;
      const raw = (drag.startClientY - e.clientY) / rect.height;
      const delta = e.shiftKey ? raw * 0.25 : raw;
      setDrag({ ...drag, tension: clamp01(drag.startTension + delta) });
    },
    [drag],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      // A click with no movement is a select, not a shape edit — don't write.
      if (drag.tension !== drag.startTension) onSetTension(drag.no, drag.tension);
      setDrag(null);
    },
    [drag, onSetTension],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent, s: MockScene) => {
      const step = e.shiftKey ? 0.01 : 0.05;
      const base = s.tension ?? UNSET_REST;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onSetTension(s.no, clamp01(base + step));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onSetTension(s.no, clamp01(base - step));
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        onSetTension(s.no, null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onOpenScene(s.no);
      }
    },
    [onSetTension, onOpenScene],
  );

  const shapedCount = points.length;

  return (
    <div style={{ position: "absolute", left, top, width, height }}>
      {/* Tension axis */}
      {[1, 0.5, 0].map((t) => (
        <div
          key={t}
          style={{
            position: "absolute", left: 0, top: cy(t) - 6, width: AXIS_W - 8,
            textAlign: "right",
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.1em",
            color: "var(--fg-4)",
          }}
        >
          {t === 1 ? "PEAK" : t === 0.5 ? "MID" : "REST"}
        </div>
      ))}

      <div ref={plotRef} style={{ position: "absolute", left: AXIS_W, top: 0, width: plotW, height: plotH }}>
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
          viewBox={`0 0 ${plotW} ${plotH}`}
          preserveAspectRatio="none"
        >
          {/* Gridlines */}
          {[0, 0.5, 1].map((t) => (
            <line
              key={t}
              x1={0} y1={cy(t)} x2={plotW} y2={cy(t)}
              stroke="oklch(0.5 0.025 145 / 0.28)"
              strokeWidth="0.8"
              strokeDasharray={t === 0.5 ? "2 4" : "2 3"}
            />
          ))}

          {/* Runtime midpoint — the structural beat the whole view exists for */}
          <line
            x1={plotW / 2} y1={0} x2={plotW / 2} y2={plotH}
            stroke="oklch(0.62 0.09 305 / 0.5)" strokeWidth="1" strokeDasharray="4 4"
          />

          {/* Column ticks */}
          {scenes.map((s, i) => (
            <line
              key={s.no}
              x1={cx(i)} y1={plotH - 4} x2={cx(i)} y2={plotH}
              stroke="oklch(0.5 0.025 145 / 0.45)" strokeWidth="1"
            />
          ))}

          {/* The curve. Dashed where it bridges unshaped scenes — an
              interpolation must never read as authored. */}
          {segments.map((seg, i) => (
            <path
              key={i}
              d={toPath(seg.samples)}
              fill="none"
              stroke="var(--tts)"
              strokeWidth={seg.spansGap ? 1.2 : 2}
              strokeDasharray={seg.spansGap ? "3 4" : undefined}
              opacity={seg.spansGap ? 0.5 : 0.9}
              strokeLinecap="round"
            />
          ))}
        </svg>

        {/* Draggable nodes */}
        {scenes.map((s, i) => {
          const live = tensionOf(s);
          const shaped = live != null;
          const y = cy(live ?? UNSET_REST);
          const isActive = activeSceneNo === s.no;
          const isDragging = drag?.no === s.no;
          const showValue = isDragging || hover === s.no;
          return (
            <div
              key={s.no}
              role="slider"
              tabIndex={0}
              aria-label={`Scene ${s.no} tension`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={live ?? undefined}
              aria-valuetext={shaped ? live!.toFixed(2) : "unshaped"}
              title={`${s.no} · ${shaped ? live!.toFixed(2) : "unshaped"} — drag to shape, double-click to clear`}
              onPointerDown={(e) => onPointerDown(e, s)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={(e) => { e.stopPropagation(); onSetTension(s.no, null); }}
              onKeyDown={(e) => onKeyDown(e, s)}
              onMouseEnter={() => setHover(s.no)}
              onMouseLeave={() => setHover((h) => (h === s.no ? null : h))}
              style={{
                position: "absolute",
                left: cx(i) - NODE_R,
                top: y - NODE_R,
                width: NODE_R * 2,
                height: NODE_R * 2,
                borderRadius: "50%",
                background: shaped ? "var(--tts)" : "transparent",
                border: `1.5px solid ${shaped ? "color-mix(in oklch, var(--tts) 65%, black)" : "var(--line-2)"}`,
                opacity: shaped ? 1 : 0.55,
                cursor: isDragging ? "grabbing" : "grab",
                touchAction: "none",
                boxShadow: isActive
                  ? "0 0 0 3px color-mix(in oklch, var(--tts) 28%, transparent)"
                  : shaped
                    ? "0 0 5px color-mix(in oklch, var(--tts) 45%, transparent)"
                    : "none",
                transition: isDragging ? "none" : "top 0.12s ease-out",
                zIndex: isDragging ? 3 : 2,
              }}
            >
              {showValue && (
                <div style={{
                  position: "absolute", left: "50%", top: -20, transform: "translateX(-50%)",
                  fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em",
                  color: "var(--fg-1)", background: "var(--bg-1)",
                  border: "1px solid var(--line-1)", borderRadius: 2,
                  padding: "1px 4px", whiteSpace: "nowrap", pointerEvents: "none",
                }}>
                  {shaped ? live!.toFixed(2) : "unshaped"}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Scene labels */}
      {scenes.map((s, i) => (
        <div
          key={s.no}
          onClick={() => onOpenScene(s.no)}
          title={s.title}
          style={{
            position: "absolute",
            left: AXIS_W + cx(i) - colW / 2,
            top: plotH + 8,
            width: colW,
            padding: "0 4px",
            textAlign: "center",
            cursor: "pointer",
            color: activeSceneNo === s.no ? "var(--fg-0)" : "var(--fg-3)",
          }}
        >
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em" }}>{s.no}</div>
          <div style={{
            fontSize: 10, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {s.title}
          </div>
        </div>
      ))}

      {/* Midpoint caption + shaped count */}
      <div style={{
        position: "absolute", left: AXIS_W + plotW / 2 + 6, top: 2,
        fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.16em",
        textTransform: "uppercase", color: "oklch(0.62 0.09 305 / 0.75)",
        pointerEvents: "none",
      }}>
        Midpoint
      </div>
      <div style={{
        position: "absolute", right: 0, top: 2,
        fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.1em",
        color: "var(--fg-4)", pointerEvents: "none",
      }}>
        {shapedCount}/{n} shaped
      </div>
    </div>
  );
};
