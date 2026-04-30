// Composition view — editable script + draggable asset list + timeline
function CompositionView({ scene, scenes, tracks, allAssets, onSwitchScene, onOpenPyramid, onUpdateScene }) {
  const PX_PER_SEC = 4;
  const totalSec = 200;
  const [selected, setSelected] = React.useState(null);
  const [playhead] = React.useState(72);
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState(scene.title);
  const [desc, setDesc] = React.useState(scene.desc);
  const [script, setScript] = React.useState(scene.script || "");
  const [dropTarget, setDropTarget] = React.useState(null);
  const [wide, setWide] = React.useState(typeof window !== "undefined" ? window.innerWidth >= 1180 : true);
  const [showAssets, setShowAssets] = React.useState(true);

  React.useEffect(() => {
    setTitle(scene.title); setDesc(scene.desc); setScript(scene.script || "");
  }, [scene.no]);

  React.useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1180);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const sidebarVisible = wide && showAssets;

  // Assets bound to this scene
  const sceneAssets = [
    ...allAssets.dialogue.filter(a => a.scene === scene.no),
    ...allAssets.sfx.filter(a => a.scene === scene.no),
    ...allAssets.music.filter(a => a.scene === scene.no),
  ];

  const ruler = [];
  for (let s = 0; s <= totalSec; s += 20) {
    const m = Math.floor(s / 60);
    const ss = (s % 60).toString().padStart(2, "0");
    ruler.push(<div key={s} className="ruler-tick">{m}:{ss}</div>);
  }

  const onDragStart = (e, a) => { e.dataTransfer.setData("text/plain", a.id); e.dataTransfer.effectAllowed = "copy"; };
  const onTrackDragOver = (e, ti) => { e.preventDefault(); setDropTarget(ti); };
  const onTrackDrop = (e, ti) => { e.preventDefault(); setDropTarget(null); };

  return (
    <div className="comp" style={{ display: "grid", gridTemplateColumns: sidebarVisible ? "minmax(0, 1fr) 280px" : "minmax(0, 1fr)", gridTemplateRows: "auto auto 1fr" }}>
      <div className="comp-header" style={{ gridColumn: "1 / -1" }}>
        <button className="btn btn-icon" onClick={onOpenPyramid} title="Back to pyramid"><Icon name="pyramid" /></button>
        <div className="comp-title-block" style={{ flex: 1, minWidth: 0 }}>
          <span className="scene-no">DRAWING {scene.no} · REV.{scene.rev}</span>
          {editing ? (
            <input className="input" style={{ fontSize: 16, fontWeight: 600, padding: "4px 6px", background: "var(--bg-2)" }}
              value={title} onChange={e => setTitle(e.target.value)} autoFocus />
          ) : (
            <span className="scene-name" onClick={() => setEditing(true)} style={{ cursor: "text" }}>{title}</span>
          )}
        </div>
        <span className="kicker">Duration {scene.duration}</span>
        <div className="comp-header-actions">
          {editing ? (
            <>
              <button className="btn" onClick={() => { setEditing(false); setTitle(scene.title); setDesc(scene.desc); setScript(scene.script || ""); }}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { onUpdateScene && onUpdateScene(scene.no, { title, desc, script }); setEditing(false); }}>Save</button>
            </>
          ) : (
            <>
              {wide && (
                <button className="btn" onClick={() => setShowAssets(v => !v)} title="Toggle scene assets">
                  {showAssets ? "Hide assets" : "Show assets"}
                </button>
              )}
              <button className="btn" onClick={() => setEditing(true)}>Edit story</button>
              <button className="btn"><Icon name="sparkle" /> Agent assist</button>
              <button className="btn btn-primary"><Icon name="download" /> Render scene</button>
            </>
          )}
        </div>
      </div>

      <div className="scene-strip" style={{ gridColumn: "1 / -1" }}>
        {scenes.map(s => (
          <div key={s.no} className={`scene-chip ${s.no === scene.no ? "active" : ""}`} onClick={() => onSwitchScene(s.no)}>
            <span className={`ring ${s.status}`} />
            <span>{s.no}</span>
            <span style={{ color: "var(--fg-3)" }}>·</span>
            <span style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-ui)" }}>{s.title}</span>
          </div>
        ))}
      </div>

      {editing && (
        <div style={{ gridColumn: "1 / -1", padding: "16px 20px", borderBottom: "1px solid var(--line-1)", background: "var(--bg-2)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <div className="field-label"><span>Description</span></div>
            <textarea className="textarea" value={desc} onChange={e => setDesc(e.target.value)} style={{ minHeight: 70 }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <div className="field-label"><span>Script</span><span className="hint">stage directions in (parens)</span></div>
            <textarea className="textarea" value={script} onChange={e => setScript(e.target.value)} style={{ minHeight: 70, fontFamily: "var(--font-mono)", fontSize: 11 }} />
          </div>
        </div>
      )}

      <div className="timeline" style={{ gridColumn: 1 }}>
        <div className="tracks-head">
          <div className="tracks-time">TRACKS · {tracks.length}</div>
          {tracks.map(t => (
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
          <div className="timeline-ruler" style={{ width: totalSec * PX_PER_SEC }}>{ruler}</div>
          <div className="tracks-rows" style={{ width: totalSec * PX_PER_SEC }}>
            {tracks.map((t, ti) => (
              <div key={t.id} className="track-row"
                onDragOver={(e) => onTrackDragOver(e, ti)}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => onTrackDrop(e, ti)}
                style={dropTarget === ti ? { boxShadow: "inset 0 0 0 1px var(--fg-0)" } : {}}>
                {t.clips.map((c, ci) => (
                  <div key={ci}
                    className={`clip ${t.kind} ${selected === `${ti}-${ci}` ? "selected" : ""}`}
                    style={{ left: c.start * PX_PER_SEC, width: c.len * PX_PER_SEC }}
                    onClick={(e) => { e.stopPropagation(); setSelected(`${ti}-${ci}`); }}>
                    <div className="clip-label">{c.label}</div>
                    <div className="clip-wave"><Wave width={c.len * PX_PER_SEC} height={28} seed={ti * 7 + ci * 3 + 1} count={Math.max(20, Math.floor(c.len * 1.6))} /></div>
                  </div>
                ))}
              </div>
            ))}
            <div className="playhead" style={{ left: playhead * PX_PER_SEC }} />
            <div className="agent-marker" style={{ left: 96 * PX_PER_SEC }} title="Agent suggestion: insert breath" />
          </div>
        </div>
      </div>

      {/* Scene assets sidebar — draggable, hidden on narrow viewports */}
      {sidebarVisible && (
      <div style={{ gridColumn: 2, borderLeft: "1px solid var(--line-1)", background: "var(--bg-1)", overflow: "auto", display: "flex", flexDirection: "column" }}>
        <div className="asset-group-head" style={{ borderBottom: "1px solid var(--line-1)", paddingBottom: 10 }}>
          <span>SCENE ASSETS · {sceneAssets.length}</span>
          <span style={{ color: "var(--fg-4)" }}>drag to track</span>
        </div>
        {sceneAssets.length === 0 && (
          <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)" }}>No assets yet. Generate via Voice / SFX / Score panels.</div>
        )}
        {sceneAssets.map(a => (
          <div key={a.id} className={`asset-row ${a.kind}`} draggable onDragStart={(e) => onDragStart(e, a)} style={{ cursor: "grab" }}>
            <div className="swatch" />
            <div style={{ width: 56, height: 22 }}><Wave width={56} height={22} seed={a.id.charCodeAt(1) + a.id.charCodeAt(2)} count={20} color={a.kind === "tts" ? "var(--tts)" : a.kind === "sfx" ? "var(--sfx)" : "var(--music)"} opacity={0.7} /></div>
            <div className="meta"><span className="name" style={{ fontSize: 11 }}>{a.name}</span><span className="sub" style={{ fontSize: 9.5 }}>{a.sub}</span></div>
            <span className={`badge ${a.state}`}>{a.state}</span>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

window.CompositionView = CompositionView;
