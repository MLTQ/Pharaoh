/**
 * DissectOverview.tsx
 *
 * The whole recording at a glance: chapters, the main voices, and where the
 * effects, ambience and music were found, as horizontal lanes on one canvas.
 * A canvas rather than divs because a 20 h book has tens of thousands of turns.
 * Hover shows the time and chapter under the cursor.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DissectManifest } from "../../lib/types";
import { CHAR_HUE } from "../library/libraryShared";

const MAX_VOICE_LANES = 5;
const LANE_H = 12;
const GAP = 4;
const LABEL_W = 92;

function fmt(s: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export const DissectOverview: React.FC<{ manifest: DissectManifest }> = ({ manifest }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(700);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const lanes = useMemo(() => {
    const voices = manifest.speakers.slice(0, MAX_VOICE_LANES).map((s) => ({ key: s.id, label: s.label }));
    const out: { key: string; label: string; kind: "chapters" | "voice" | "sound" }[] = [];
    if ((manifest.chapters?.length ?? 0) > 0) out.push({ key: "chapters", label: "Chapters", kind: "chapters" });
    voices.forEach((v) => out.push({ ...v, kind: "voice" }));
    const s = manifest.sounds;
    if (s) {
      if (s.sfx.length) out.push({ key: "sfx", label: `Effects · ${s.sfx.length}`, kind: "sound" });
      if (s.ambience.length) out.push({ key: "ambience", label: `Ambience · ${s.ambience.length}`, kind: "sound" });
      if (s.music.length) out.push({ key: "music", label: `Music · ${s.music.length}`, kind: "sound" });
    }
    return out;
  }, [manifest]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(300, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = lanes.length * (LANE_H + GAP) + 18;
  const dur = Math.max(1, manifest.duration_s);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, height);
    const plotW = width - LABEL_W;
    const X = (t: number) => LABEL_W + (t / dur) * plotW;
    const fg3 = cssVar("--fg-3", "#888");
    const line = cssVar("--bg-3", "#333");
    const colours: Record<string, string> = {
      sfx: cssVar("--sfx", "#5bc"), ambience: cssVar("--st-ready", "#69c"), music: cssVar("--music", "#b8c"),
    };
    g.font = "10px system-ui, sans-serif";

    lanes.forEach((lane, i) => {
      const y = i * (LANE_H + GAP);
      g.fillStyle = fg3;
      g.textBaseline = "middle";
      g.fillText(lane.label, 0, y + LANE_H / 2, LABEL_W - 6);
      g.fillStyle = line;
      g.fillRect(LABEL_W, y + LANE_H / 2, plotW, 1);

      if (lane.kind === "chapters") {
        (manifest.chapters ?? []).forEach((c, k) => {
          g.fillStyle = k % 2 ? cssVar("--bg-4", "#444") : cssVar("--bg-3", "#333");
          g.fillRect(X(c.start), y, Math.max(1, X(c.end) - X(c.start)), LANE_H);
        });
      } else if (lane.kind === "voice") {
        g.fillStyle = `oklch(0.7 0.12 ${CHAR_HUE(lane.key)})`;
        // Merge turns that land on the same pixel column.
        let lastX = -1;
        for (const t of manifest.turns) {
          if (t.speaker !== lane.key) continue;
          const x0 = X(t.start), x1 = Math.max(x0 + 1, X(t.end));
          if (x1 <= lastX) continue;
          g.fillRect(Math.max(x0, lastX), y + 1, x1 - Math.max(x0, lastX), LANE_H - 2);
          lastX = x1;
        }
      } else {
        const items = manifest.sounds?.[lane.key as "sfx" | "ambience" | "music"] ?? [];
        g.fillStyle = colours[lane.key] ?? fg3;
        for (const r of items) {
          const x0 = X(r.start);
          g.fillRect(x0, y + 1, Math.max(1.5, X(r.end) - x0), LANE_H - 2);
        }
      }
    });

    // Time axis ticks.
    const ticks = 6;
    g.fillStyle = fg3;
    for (let k = 0; k <= ticks; k++) {
      const t = (dur * k) / ticks;
      const x = X(t);
      g.fillText(fmt(t), Math.min(x, width - 38), height - 7);
    }
  }, [lanes, manifest, width, height, dur]);

  const chapterAt = (t: number) => manifest.chapters?.find((c) => c.start <= t && t < c.end)?.title;

  return (
    <div ref={wrap} style={{ position: "relative" }}
         onMouseMove={(e) => {
           const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
           const x = e.clientX - r.left;
           if (x < LABEL_W) { setHover(null); return; }
           setHover({ x, t: ((x - LABEL_W) / (width - LABEL_W)) * dur });
         }}
         onMouseLeave={() => setHover(null)}>
      <canvas ref={ref} style={{ width, height, display: "block" }} />
      {hover && (
        <>
          <div style={{ position: "absolute", left: hover.x, top: 0, bottom: 16, width: 1, background: "var(--fg-3)", pointerEvents: "none" }} />
          <div style={{
            position: "absolute", left: Math.min(hover.x + 6, width - 180), top: -2, pointerEvents: "none",
            fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-1)", background: "var(--bg-2)",
            border: "1px solid var(--line-2)", padding: "1px 5px", borderRadius: 2, whiteSpace: "nowrap",
          }}>
            {fmt(hover.t)}{chapterAt(hover.t) ? ` · ${chapterAt(hover.t)}` : ""}
          </div>
        </>
      )}
    </div>
  );
};
