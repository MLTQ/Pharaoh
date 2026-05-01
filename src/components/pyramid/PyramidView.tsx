import React, { useRef, useEffect, useState } from "react";
import { Icon, StatusRing } from "../shared/atoms";
import type { MockProject, MockCastMember, MockScene } from "../../lib/types";
import { useProjectStore } from "../../store/projectStore";
import { createScene } from "../../lib/tauriCommands";

interface PyramidViewProps {
  project: MockProject;
  scenes: MockScene[];
  cast: MockCastMember[];
  activeSceneNo: string;
  onOpenScene: (no: string) => void;
  onOpenBible: () => void;
}

interface NewSceneForm {
  title: string;
  description: string;
  location: string;
}

export const PyramidView: React.FC<PyramidViewProps> = ({
  project, scenes, cast, activeSceneNo, onOpenScene, onOpenBible,
}) => {
  const { realProjectId, addScene } = useProjectStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewSceneForm>({ title: "", description: "", location: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);

  useEffect(() => {
    const fit = () => {
      if (!wrapRef.current) return;
      const sx = wrapRef.current.clientWidth / 1280;
      const sy = wrapRef.current.clientHeight / 760;
      setScale(Math.min(sx, sy, 1));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const W = 1280, H = 760;
  const APEX_X = 640, APEX_Y = 60;
  const APEX_W = 360;
  const BASE_Y = 420;
  const PLATE_W = 184, PLATE_H = 188;

  const n = scenes.length;
  const plateGap = 22;
  // When computing layout include the "+ Add scene" placeholder
  const totalCards = n + 1;
  const totalPlatesW = totalCards * PLATE_W + (totalCards - 1) * plateGap;
  const startX = (W - totalPlatesW) / 2;

  const episodeTotalSec = scenes.reduce((a, s) => {
    const [m, sec] = s.duration.split(":").map(Number);
    return a + m * 60 + sec;
  }, 0);

  const statusColors: Record<string, string> = {
    rendered: "oklch(0.72 0.13 145)",
    ready:    "oklch(0.72 0.10 230)",
    gen:      "oklch(0.78 0.14 75)",
    draft:    "oklch(0.45 0.01 145)",
  };

  const handleOpenForm = () => {
    setForm({ title: "", description: "", location: "" });
    setFormError(null);
    setShowForm(true);
  };

  const handleCancelForm = () => {
    setShowForm(false);
    setFormError(null);
  };

  const handleCreate = async () => {
    if (!form.title.trim()) {
      setFormError("Title is required.");
      return;
    }
    if (!realProjectId) {
      setFormError("Open a real project first.");
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      const scene = await createScene({
        projectId: realProjectId,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        location: form.location.trim() || undefined,
        index: scenes.length,
      });
      addScene(scene);
      setShowForm(false);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setFormBusy(false);
    }
  };

  return (
    <div className="pyramid">
      <div className="grain" />

      {/* Inline new-scene form (above pyramid canvas) */}
      {showForm && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, zIndex: 20,
          background: "var(--bg-2)",
          borderBottom: "1px solid var(--line-1)",
          padding: "16px 24px",
          display: "flex", flexDirection: "column", gap: 12,
        }}>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em",
            textTransform: "uppercase", color: "var(--fg-4)", marginBottom: 4,
          }}>
            New Scene
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="field" style={{ marginBottom: 0, flex: "1 1 200px" }}>
              <div className="field-label">
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fg-3)" }}>
                  Title <span style={{ color: "var(--sfx)" }}>*</span>
                </span>
              </div>
              <input
                className="input"
                placeholder="Scene title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") handleCancelForm(); }}
                autoFocus
              />
            </div>
            <div className="field" style={{ marginBottom: 0, flex: "2 1 280px" }}>
              <div className="field-label">
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fg-3)" }}>
                  Description
                </span>
              </div>
              <input
                className="input"
                placeholder="Brief scene description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Escape") handleCancelForm(); }}
              />
            </div>
            <div className="field" style={{ marginBottom: 0, flex: "1 1 160px" }}>
              <div className="field-label">
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fg-3)" }}>
                  Location
                </span>
              </div>
              <input
                className="input"
                placeholder="INT. / EXT."
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Escape") handleCancelForm(); }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 1 }}>
              <button className="btn" onClick={handleCancelForm} disabled={formBusy}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={formBusy}>
                {formBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
          {formError && (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--sfx)" }}>
              {formError}
            </div>
          )}
        </div>
      )}

      <div ref={wrapRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <div style={{
          width: W, height: H, position: "absolute",
          top: "50%", left: "50%",
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "center center",
        }}>
          {/* SVG silhouette + structure lines */}
          <svg
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="pgrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="oklch(0.42 0.025 145)" stopOpacity="0.5" />
                <stop offset="1" stopColor="oklch(0.42 0.025 145)" stopOpacity="0.12" />
              </linearGradient>
            </defs>
            <polygon
              points={`${APEX_X},40 ${W - 60},${H - 40} 60,${H - 40}`}
              fill="url(#pgrad)"
              stroke="oklch(0.5 0.025 145 / 0.5)"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <line x1={APEX_X} y1="40" x2={startX + 8} y2={BASE_Y - 4} stroke="oklch(0.5 0.025 145 / 0.4)" strokeWidth="0.8" strokeDasharray="2 3" />
            <line x1={APEX_X} y1="40" x2={startX + totalPlatesW - 8} y2={BASE_Y - 4} stroke="oklch(0.5 0.025 145 / 0.4)" strokeWidth="0.8" strokeDasharray="2 3" />
            <line x1={APEX_X} y1="40" x2={APEX_X} y2={H - 40} stroke="oklch(0.5 0.025 145 / 0.22)" strokeWidth="0.8" strokeDasharray="1 4" />
            <line x1="120" y1={BASE_Y - 30} x2={W - 120} y2={BASE_Y - 30} stroke="oklch(0.5 0.025 145 / 0.3)" strokeWidth="0.8" strokeDasharray="2 3" />
            <line x1="60"  y1={BASE_Y + PLATE_H + 14} x2={W - 60} y2={BASE_Y + PLATE_H + 14} stroke="oklch(0.5 0.025 145 / 0.25)" strokeWidth="0.8" strokeDasharray="2 3" />
            <g stroke="oklch(0.55 0.025 145 / 0.5)" strokeWidth="1" fill="none">
              <path d={`M 60 ${H - 40} L 60 ${H - 60} M 60 ${H - 40} L 80 ${H - 40}`} />
              <path d={`M ${W - 60} ${H - 40} L ${W - 60} ${H - 60} M ${W - 60} ${H - 40} L ${W - 80} ${H - 40}`} />
              <path d={`M ${APEX_X} 40 L ${APEX_X - 20} 40 M ${APEX_X} 40 L ${APEX_X + 20} 40`} />
            </g>
          </svg>

          {/* Title */}
          <div style={{ position: "absolute", top: 16, left: 24, zIndex: 5 }}>
            <div className="kicker" style={{ marginBottom: 2 }}>Project · Pyramid</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-0)" }}>{project.title}</div>
          </div>

          {/* Tier labels */}
          <div style={{ position: "absolute", top: 30, left: 200, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-4)", background: "var(--bg-1)", padding: "0 8px" }}>I · STORY BIBLE</div>
          <div style={{ position: "absolute", top: BASE_Y - 36, left: 80, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-4)", background: "var(--bg-1)", padding: "0 8px" }}>II · SCENES &amp; CONTINUITY</div>
          <div style={{ position: "absolute", top: BASE_Y + PLATE_H + 6, left: 60, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-4)", background: "var(--bg-1)", padding: "0 8px" }}>III · COMPOSITION &amp; MIX</div>

          {/* Apex card */}
          <div
            className={`apex`}
            onClick={onOpenBible}
            style={{ left: APEX_X - APEX_W / 2, top: APEX_Y, width: APEX_W, transform: "none", margin: 0 }}
          >
            <div className="apex-head">
              <span>Story Bible · {project.revision}</span>
              <span>{project.season}·{project.episode}</span>
            </div>
            <div className="apex-body">
              <div className="apex-title">{project.title}</div>
              <div className="apex-logline">"{project.logline}"</div>
              <div className="apex-meta">
                <div className="row"><span className="k">Runtime</span><span className="v">{project.runtime}</span></div>
                <div className="row"><span className="k">Genre</span><span className="v">{project.genre}</span></div>
                <div className="row"><span className="k">Creator</span><span className="v">{project.creator}</span></div>
              </div>
            </div>
            <div className="apex-cast">
              <div className="apex-cast-title">Cast · {cast.length} voices</div>
              {cast.slice(0, 3).map((c) => (
                <div className="cast-row" key={c.id}>
                  <div className="av" style={{ background: `oklch(0.7 0.06 ${(c.id.charCodeAt(0) * 13) % 360})` }} />
                  <span className="name">{c.name}</span>
                  <span className="voice">{c.voice}</span>
                  <span className="scenes">{c.scenes} sc</span>
                </div>
              ))}
            </div>
          </div>

          {/* Scene plates */}
          {scenes.map((s, i) => {
            const x = startX + i * (PLATE_W + plateGap);
            const nodes = s.nodes ?? [];
            const totalNodes = nodes.reduce((a, nd) => a + nd.n, 0);
            const NODE_SIZE = 10, NODE_GAP = 4;
            const nodesW = totalNodes * NODE_SIZE + (totalNodes - 1) * NODE_GAP;
            const nodesStart = (PLATE_W - nodesW) / 2;
            let acc = 0;

            return (
              <React.Fragment key={s.no}>
                <div
                  className={`plate ${activeSceneNo === s.no ? "active" : ""}`}
                  onClick={() => onOpenScene(s.no)}
                  style={{ position: "absolute", left: x, top: BASE_Y, width: PLATE_W, margin: 0 }}
                >
                  <div className="plate-head">
                    <span className="plate-no">SCENE {s.no}</span>
                    <span className="plate-rev">REV.{s.rev}</span>
                  </div>
                  <div className="plate-body">
                    <div className="plate-title">{s.title}</div>
                    <div className="plate-desc">{s.desc}</div>
                  </div>
                  <div className="plate-foot">
                    <div className="plate-status">
                      <StatusRing status={s.status} />
                      <span>{s.status}</span>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-3)" }}>{s.duration}</span>
                  </div>
                </div>

                {/* Connector + asset nodes */}
                <svg style={{ position: "absolute", left: x, top: BASE_Y + PLATE_H, width: PLATE_W, height: 36, pointerEvents: "none" }}>
                  <line x1={PLATE_W / 2} y1="0" x2={PLATE_W / 2} y2="14" stroke="oklch(0.5 0.025 145 / 0.5)" strokeWidth="1" strokeDasharray="2 2" />
                  <line x1={nodesStart - 4} y1="14" x2={nodesStart + nodesW + 4} y2="14" stroke="oklch(0.5 0.025 145 / 0.4)" strokeWidth="1" />
                </svg>
                {nodes.map((group) => {
                  const color = group.k === "tts" ? "var(--tts)" : group.k === "sfx" ? "var(--sfx)" : "var(--music)";
                  const items = Array.from({ length: group.n }, (_, j) => {
                    const cx = x + nodesStart + acc * (NODE_SIZE + NODE_GAP);
                    acc++;
                    return (
                      <div
                        key={`${group.k}-${j}`}
                        title={`${group.k.toUpperCase()} asset`}
                        style={{
                          position: "absolute",
                          left: cx, top: BASE_Y + PLATE_H + 18,
                          width: NODE_SIZE, height: NODE_SIZE,
                          borderRadius: 2, background: color, opacity: 0.85,
                          border: `1px solid color-mix(in oklch, ${color} 60%, black)`,
                        }}
                      />
                    );
                  });
                  return items;
                })}
              </React.Fragment>
            );
          })}

          {/* "+ Add scene" placeholder card */}
          {(() => {
            const addCardX = startX + n * (PLATE_W + plateGap);
            return (
              <div
                onClick={handleOpenForm}
                title="Add scene"
                style={{
                  position: "absolute", left: addCardX, top: BASE_Y,
                  width: PLATE_W, height: PLATE_H,
                  border: "1.5px dashed var(--line-1)",
                  borderRadius: 4,
                  background: "color-mix(in oklch, var(--bg-2) 60%, transparent)",
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 8,
                  cursor: "pointer",
                  opacity: 0.7,
                  transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  border: "1px dashed var(--line-1)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--fg-3)",
                }}>
                  <Icon name="plus" style={{ width: 14, height: 14 }} />
                </div>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9,
                  letterSpacing: "0.14em", textTransform: "uppercase",
                  color: "var(--fg-4)",
                }}>
                  Add scene
                </span>
              </div>
            );
          })()}

          {/* Episode timeline bar */}
          <div style={{
            position: "absolute", left: 60, right: 60, bottom: 24,
            border: "1px solid var(--line-1)",
            background: "color-mix(in oklch, var(--bg-2) 80%, transparent)",
            borderRadius: 2, padding: "10px 16px",
            display: "flex", alignItems: "center", gap: 16,
            fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em",
          }}>
            <span style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>Episode timeline</span>
            <div style={{ flex: 1, height: 22 }}>
              <svg width="100%" height="22" viewBox="0 0 1000 22" preserveAspectRatio="none">
                {(() => {
                  let offset = 0;
                  return scenes.map((s) => {
                    const [m, sec] = s.duration.split(":").map(Number);
                    const dur = m * 60 + sec;
                    const xx = episodeTotalSec > 0 ? (offset / episodeTotalSec) * 1000 : 0;
                    const w = episodeTotalSec > 0 ? (dur / episodeTotalSec) * 1000 : 0;
                    offset += dur;
                    return (
                      <g key={s.no}>
                        <rect x={xx + 1} y="4" width={w - 2} height="14" fill={statusColors[s.status] ?? statusColors.draft} opacity="0.6" rx="1" />
                        <text x={xx + 6} y="14" fill="oklch(0.95 0.01 95)" fontSize="9" fontFamily="var(--font-mono)" letterSpacing="0.06em">{s.no}</text>
                      </g>
                    );
                  });
                })()}
              </svg>
            </div>
            <span style={{ color: "var(--fg-1)" }}>{project.runtime}</span>
          </div>
        </div>
      </div>

      {/* Coord display */}
      <div className="pyramid-coord">
        <span>X 0.000</span><span>Y 0.000</span><span>ZOOM 1.00</span><span>SCALE 1:48</span>
      </div>

      {/* Zoom controls */}
      <div className="pyramid-zoom">
        <button title="Zoom in"><Icon name="plus" style={{ width: 14, height: 14 }} /></button>
        <button title="Zoom out"><Icon name="minus" style={{ width: 14, height: 14 }} /></button>
        <button title="Fit"><Icon name="fit" style={{ width: 14, height: 14 }} /></button>
      </div>
    </div>
  );
};
