import React, { useState, useEffect, useRef } from "react";
import { Icon, Wave } from "../shared/atoms";
import { useProjectStore } from "../../store/projectStore";
import { readScript, updateScriptRow } from "../../lib/tauriCommands";
import type { MockScene, MockTrack, MockAssets, AssetItem, ScriptRow } from "../../lib/types";

const PX_PER_SEC = 4;
const TOTAL_SEC = 200;

interface CompositionViewProps {
  scene: MockScene;
  scenes: MockScene[];
  tracks: MockTrack[];
  assets: MockAssets;
  onSwitchScene: (no: string) => void;
  onOpenPyramid: () => void;
  onUpdateScene: (no: string, patch: Partial<MockScene>) => void;
}

export const CompositionView: React.FC<CompositionViewProps> = ({
  scene, scenes, tracks, assets, onSwitchScene, onOpenPyramid, onUpdateScene,
}) => {
  const [selected, setSelected] = useState<string | null>(null);
  const playheadSec = 72;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(scene.title);
  const [desc, setDesc] = useState(scene.desc);
  const [script, setScript] = useState(scene.script ?? "");
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [showAssets, setShowAssets] = useState(true);
  const [wide, setWide] = useState(window.innerWidth >= 1180);
  const [showScript, setShowScript] = useState(false);
  const [scriptRows, setScriptRows] = useState<ScriptRow[]>([]);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editingPrompt, setEditingPrompt] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { realProjectId, activeSceneSlug } = useProjectStore();

  useEffect(() => {
    setTitle(scene.title);
    setDesc(scene.desc);
    setScript(scene.script ?? "");
  }, [scene.no]);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1180);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Load script rows from Tauri when real project is available
  useEffect(() => {
    if (!realProjectId || !activeSceneSlug) return;
    readScript({ projectId: realProjectId, sceneSlug: activeSceneSlug })
      .then(setScriptRows)
      .catch(() => setScriptRows([]));
  }, [realProjectId, activeSceneSlug, scene.no]);

  const commitRowEdit = (rowIndex: number, prompt: string) => {
    setScriptRows((rows) => rows.map((r, i) => i === rowIndex ? { ...r, prompt } : r));
    if (!realProjectId || !activeSceneSlug) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      updateScriptRow({ projectId: realProjectId, sceneSlug: activeSceneSlug, rowIndex, fields: { prompt } })
        .catch(console.error);
    }, 5000); // 5s debounce per architecture spec
  };

  const TYPE_COLOR: Record<string, string> = {
    DIALOGUE: "var(--tts)",
    SFX: "var(--sfx)",
    BED: "var(--sfx)",
    MUSIC: "var(--music)",
    DIRECTION: "var(--fg-3)",
  };

  const sidebarVisible = wide && showAssets;

  const sceneAssets: AssetItem[] = [
    ...assets.dialogue.filter((a) => a.scene === scene.no),
    ...assets.sfx.filter((a) => a.scene === scene.no),
    ...assets.music.filter((a) => a.scene === scene.no),
  ];

  const ruler = Array.from({ length: Math.floor(TOTAL_SEC / 20) + 1 }, (_, i) => {
    const s = i * 20;
    const m = Math.floor(s / 60);
    const ss = (s % 60).toString().padStart(2, "0");
    return <div key={s} className="ruler-tick">{m}:{ss}</div>;
  });

  const saveEditing = () => {
    onUpdateScene(scene.no, { title, desc, script });
    setEditing(false);
  };

  return (
    <div
      className="comp"
      style={{
        display: "grid",
        gridTemplateColumns: sidebarVisible ? "minmax(0,1fr) 280px" : "minmax(0,1fr)",
        gridTemplateRows: "auto auto auto auto 1fr",
      }}
    >
      {/* Header */}
      <div className="comp-header" style={{ gridColumn: "1 / -1" }}>
        <button className="btn btn-icon" onClick={onOpenPyramid} title="Back to pyramid">
          <Icon name="pyramid" style={{ width: 16, height: 16 }} />
        </button>
        <div className="comp-title-block" style={{ flex: 1, minWidth: 0 }}>
          <span className="scene-no">SCENE {scene.no} · REV.{scene.rev}</span>
          {editing ? (
            <input
              className="input"
              style={{ fontSize: 16, fontWeight: 600, padding: "4px 6px" }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          ) : (
            <span className="scene-name" onClick={() => setEditing(true)} style={{ cursor: "text" }}>
              {title}
            </span>
          )}
        </div>
        <span className="kicker">Duration {scene.duration}</span>
        <div className="comp-header-actions">
          {editing ? (
            <>
              <button className="btn" onClick={() => { setEditing(false); setTitle(scene.title); setDesc(scene.desc); setScript(scene.script ?? ""); }}>Cancel</button>
              <button className="btn btn-primary" onClick={saveEditing}>Save</button>
            </>
          ) : (
            <>
              {wide && (
                <button className="btn" onClick={() => setShowAssets((v) => !v)}>
                  {showAssets ? "Hide assets" : "Show assets"}
                </button>
              )}
              <button className="btn" onClick={() => setEditing(true)}>Edit story</button>
              <button className="btn" onClick={() => setShowScript((v) => !v)}>
                {showScript ? "Hide script" : "Script"}
                {scriptRows.length > 0 && <span style={{ marginLeft: 5, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)" }}>{scriptRows.length}</span>}
              </button>
              <button className="btn"><Icon name="sparkle" style={{ width: 14, height: 14 }} /> Agent assist</button>
              <button className="btn btn-primary"><Icon name="download" style={{ width: 14, height: 14 }} /> Render scene</button>
            </>
          )}
        </div>
      </div>

      {/* Scene strip */}
      <div className="scene-strip" style={{ gridColumn: "1 / -1" }}>
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

      {/* Edit panel */}
      {editing && (
        <div style={{
          gridColumn: "1 / -1", padding: "16px 20px",
          borderBottom: "1px solid var(--line-1)", background: "var(--bg-2)",
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16,
        }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <div className="field-label"><span>Description</span></div>
            <textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ minHeight: 70 }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <div className="field-label">
              <span>Script</span>
              <span className="hint">stage directions in (parens)</span>
            </div>
            <textarea className="textarea" value={script} onChange={(e) => setScript(e.target.value)} style={{ minHeight: 70, fontFamily: "var(--font-mono)", fontSize: 11 }} />
          </div>
        </div>
      )}

      {/* Script CSV panel */}
      {showScript && (
        <div style={{
          gridColumn: "1 / -1",
          borderBottom: "1px solid var(--line-1)",
          background: "var(--bg-1)",
          maxHeight: 240, overflow: "auto",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "70px 80px 100px 1fr 80px 80px",
            padding: "6px 16px",
            borderBottom: "1px solid var(--line-1)",
            fontFamily: "var(--font-mono)", fontSize: 9,
            letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-4)",
            background: "var(--bg-2)", position: "sticky", top: 0,
          }}>
            <span>Track</span><span>Type</span><span>Character</span><span>Prompt</span>
            <span>Start</span><span>Duration</span>
          </div>
          {scriptRows.length === 0 && (
            <div style={{ padding: "20px 16px", fontSize: 11, color: "var(--fg-4)", textAlign: "center" }}>
              {realProjectId ? "No script rows yet. Generate audio from the Voice/SFX/Music panels." : "Script CSV available when a real project is open."}
            </div>
          )}
          {scriptRows.map((row, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "70px 80px 100px 1fr 80px 80px",
                padding: "5px 16px",
                borderBottom: "1px solid var(--line-1)",
                alignItems: "center",
                background: editingRow === i ? "var(--bg-2)" : "transparent",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>{row.track}</span>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em",
                padding: "1px 5px", borderRadius: 2,
                background: `color-mix(in oklch, ${TYPE_COLOR[row.type] ?? "var(--fg-4)"} 15%, transparent)`,
                color: TYPE_COLOR[row.type] ?? "var(--fg-4)",
                width: "fit-content",
              }}>{row.type}</span>
              <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{row.character || "—"}</span>
              {editingRow === i ? (
                <input
                  className="input"
                  style={{ fontSize: 11, padding: "2px 6px" }}
                  value={editingPrompt}
                  onChange={(e) => setEditingPrompt(e.target.value)}
                  onBlur={() => { commitRowEdit(i, editingPrompt); setEditingRow(null); }}
                  autoFocus
                />
              ) : (
                <span
                  style={{ fontSize: 11, color: "var(--fg-1)", cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  onClick={() => { setEditingRow(i); setEditingPrompt(row.prompt); }}
                  title={row.prompt}
                >{row.prompt || <span style={{ color: "var(--fg-4)" }}>—</span>}</span>
              )}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: row.start_ms ? "var(--fg-2)" : "var(--fg-4)" }}>
                {row.start_ms ? `${(Number(row.start_ms) / 1000).toFixed(1)}s` : "—"}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: row.file ? "var(--st-rendered)" : "var(--fg-4)" }}>
                {row.duration_ms ? `${(Number(row.duration_ms) / 1000).toFixed(1)}s` : row.file ? "✓" : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Timeline */}
      <div className="timeline" style={{ gridColumn: 1 }}>
        <div className="tracks-head">
          <div className="tracks-time">TRACKS · {tracks.length}</div>
          {tracks.map((t) => (
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
            {tracks.map((t, ti) => (
              <div
                key={t.id}
                className="track-row"
                onDragOver={(e) => { e.preventDefault(); setDropTarget(ti); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => { e.preventDefault(); setDropTarget(null); }}
                style={dropTarget === ti ? { boxShadow: "inset 0 0 0 1px var(--fg-0)" } : {}}
              >
                {t.clips.map((c, ci) => (
                  <div
                    key={ci}
                    className={`clip ${t.kind} ${selected === `${ti}-${ci}` ? "selected" : ""}`}
                    style={{ left: c.start * PX_PER_SEC, width: c.len * PX_PER_SEC }}
                    onClick={(e) => { e.stopPropagation(); setSelected(`${ti}-${ci}`); }}
                  >
                    <div className="clip-label">{c.label}</div>
                    <div className="clip-wave">
                      <Wave
                        width={c.len * PX_PER_SEC}
                        height={28}
                        seed={ti * 7 + ci * 3 + 1}
                        count={Math.max(20, Math.floor(c.len * 1.6))}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ))}
            <div className="playhead" style={{ left: playheadSec * PX_PER_SEC }} />
            <div className="agent-marker" style={{ left: 96 * PX_PER_SEC }} title="Agent suggestion: insert breath" />
          </div>
        </div>
      </div>

      {/* Scene assets sidebar */}
      {sidebarVisible && (
        <div style={{
          gridColumn: 2, gridRow: "3 / 5",
          borderLeft: "1px solid var(--line-1)", background: "var(--bg-1)",
          overflow: "auto", display: "flex", flexDirection: "column",
        }}>
          <div className="asset-group-head" style={{ borderBottom: "1px solid var(--line-1)", paddingBottom: 10 }}>
            <span>SCENE ASSETS · {sceneAssets.length}</span>
            <span style={{ color: "var(--fg-4)" }}>drag to track</span>
          </div>
          {sceneAssets.length === 0 && (
            <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)" }}>
              No assets yet. Generate via Voice / SFX / Score panels.
            </div>
          )}
          {sceneAssets.map((a) => (
            <div
              key={a.id}
              className={`asset-row ${a.kind}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/plain", a.id)}
              style={{ cursor: "grab" }}
            >
              <div className="swatch" />
              <div style={{ width: 56, height: 22 }}>
                <Wave
                  width={56} height={22}
                  seed={a.id.charCodeAt(1) + a.id.charCodeAt(2)}
                  count={20}
                  color={a.kind === "tts" ? "var(--tts)" : a.kind === "sfx" ? "var(--sfx)" : "var(--music)"}
                  opacity={0.7}
                />
              </div>
              <div className="meta">
                <span className="name" style={{ fontSize: 11 }}>{a.name}</span>
                <span className="sub" style={{ fontSize: 9.5 }}>{a.sub}</span>
              </div>
              <span className={`badge ${a.state}`}>{a.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
