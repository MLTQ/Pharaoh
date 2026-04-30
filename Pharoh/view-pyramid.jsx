// Pyramid Canvas — zoomed-out: apex story bible + scene plates flowing along base
function PyramidView({ scenes, project, cast, onOpenScene, onOpenBible, activeScene }) {
  const stageRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  const [scale, setScale] = React.useState(1);
  React.useEffect(() => {
    const fit = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const sx = wrap.clientWidth / 1280;
      const sy = wrap.clientHeight / 760;
      setScale(Math.min(sx, sy, 1));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);
  const W = 1280, H = 760;
  const APEX_X = 640, APEX_Y = 60;
  const APEX_W = 360, APEX_H = 280;
  const BASE_Y = 420; // top of plate row
  const PLATE_W = 184, PLATE_H = 188;

  // Distribute plates evenly along base
  const n = scenes.length;
  const plateGap = 22;
  const totalPlatesW = n * PLATE_W + (n - 1) * plateGap;
  const startX = (W - totalPlatesW) / 2;

  return (
    <div className="pyramid">
      <div className="grain" />

      <div ref={wrapRef} style={{
        position: "absolute", inset: 0,
        overflow: "hidden",
      }}>
        <div ref={stageRef} style={{
          width: W, height: H, position: "absolute",
          top: "50%", left: "50%",
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "center center",
        }} className="pyramid-stage">

          {/* Triangle silhouette + diagonals */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id="pgrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="oklch(0.42 0.025 145)" stopOpacity="0.5" />
                <stop offset="1" stopColor="oklch(0.42 0.025 145)" stopOpacity="0.12" />
              </linearGradient>
            </defs>
            <polygon points={`${APEX_X},40 ${W - 60},${H - 40} 60,${H - 40}`} fill="url(#pgrad)" stroke="oklch(0.5 0.025 145 / 0.5)" strokeWidth="1" strokeDasharray="2 4" />
            {/* diagonals from apex to plate corners */}
            <line x1={APEX_X} y1="40" x2={startX + 8} y2={BASE_Y - 4} stroke="oklch(0.5 0.025 145 / 0.4)" strokeWidth="0.8" strokeDasharray="2 3" />
            <line x1={APEX_X} y1="40" x2={startX + totalPlatesW - 8} y2={BASE_Y - 4} stroke="oklch(0.5 0.025 145 / 0.4)" strokeWidth="0.8" strokeDasharray="2 3" />
            <line x1={APEX_X} y1="40" x2={APEX_X} y2={H - 40} stroke="oklch(0.5 0.025 145 / 0.22)" strokeWidth="0.8" strokeDasharray="1 4" />
            {/* tier rules */}
            <line x1="120" y1={BASE_Y - 30} x2={W - 120} y2={BASE_Y - 30} stroke="oklch(0.5 0.025 145 / 0.3)" strokeWidth="0.8" strokeDasharray="2 3" />
            <line x1="60"  y1={BASE_Y + PLATE_H + 14} x2={W - 60} y2={BASE_Y + PLATE_H + 14} stroke="oklch(0.5 0.025 145 / 0.25)" strokeWidth="0.8" strokeDasharray="2 3" />
            {/* corner crops */}
            <g stroke="oklch(0.55 0.025 145 / 0.5)" strokeWidth="1" fill="none">
              <path d={`M 60 ${H - 40} L 60 ${H - 60} M 60 ${H - 40} L 80 ${H - 40}`} />
              <path d={`M ${W - 60} ${H - 40} L ${W - 60} ${H - 60} M ${W - 60} ${H - 40} L ${W - 80} ${H - 40}`} />
              <path d={`M ${APEX_X} 40 L ${APEX_X - 20} 40 M ${APEX_X} 40 L ${APEX_X + 20} 40`} />
            </g>
          </svg>

          {/* Title — top-left, far from apex */}
          <div style={{ position: "absolute", top: 16, left: 24, display: "flex", flexDirection: "column", gap: 2, zIndex: 5 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-3)" }}>Project · Pyramid</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-0)" }}>{project.title}</span>
          </div>

          {/* Tier labels — left edge, vertically clear */}
          <div style={{ position: "absolute", top: 30, left: 200, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-4)", background: "var(--bg-1)", padding: "0 8px" }}>I · STORY BIBLE</div>
          <div style={{ position: "absolute", top: BASE_Y - 36, left: 80, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-4)", background: "var(--bg-1)", padding: "0 8px" }}>II · SCENES &amp; CONTINUITY</div>
          <div style={{ position: "absolute", top: BASE_Y + PLATE_H + 6, left: 60, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-4)", background: "var(--bg-1)", padding: "0 8px" }}>III · COMPOSITION &amp; MIX</div>

          {/* Apex card — absolutely positioned in stage coords */}
          <div
            className={`apex ${activeScene === "bible" ? "active" : ""}`}
            onClick={onOpenBible}
            style={{ position: "absolute", left: APEX_X - APEX_W / 2, top: APEX_Y, transform: "none", width: APEX_W, margin: 0 }}
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
              {cast.slice(0, 3).map(c => (
                <div className="cast-row" key={c.id}>
                  <div className="av" style={{ background: `oklch(0.7 0.06 ${(c.id.charCodeAt(0) * 13) % 360})` }} />
                  <span className="name">{c.name}</span>
                  <span className="voice">{c.voice}</span>
                  <span className="scenes">{c.scenes} sc</span>
                </div>
              ))}
            </div>
          </div>

          {/* Scene plates — fixed coords along the base */}
          {scenes.map((s, i) => {
            const x = startX + i * (PLATE_W + plateGap);
            const nodes = s.nodes || [];
            const totalNodes = nodes.reduce((a, n) => a + n.n, 0);
            // Distribute nodes in a row beneath the plate
            const NODE_SIZE = 10;
            const NODE_GAP = 4;
            const nodesW = totalNodes * NODE_SIZE + (totalNodes - 1) * NODE_GAP;
            const nodesStart = (PLATE_W - nodesW) / 2;
            let acc = 0;
            return (
              <React.Fragment key={s.no}>
                <div
                  className={`plate ${activeScene === s.no ? "active" : ""}`}
                  onClick={() => onOpenScene(s.no)}
                  style={{ position: "absolute", left: x, top: BASE_Y, width: PLATE_W, margin: 0 }}
                >
                  <div className="plate-head">
                    <span className="plate-no">DRAWING {s.no}</span>
                    <span className="plate-rev">REV.{s.rev}</span>
                  </div>
                  <div className="plate-body">
                    <div className="plate-title">{s.title}</div>
                    <div className="plate-desc">{s.desc}</div>
                  </div>
                  <div className="plate-foot">
                    <div className="plate-status">
                      <StatusRing s={s.status} />
                      <span>{s.status}</span>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-3)" }}>{s.duration}</span>
                  </div>
                </div>
                {/* Connector line + colored nodes per asset */}
                <svg style={{ position: "absolute", left: x, top: BASE_Y + PLATE_H, width: PLATE_W, height: 36, pointerEvents: "none" }}>
                  <line x1={PLATE_W / 2} y1="0" x2={PLATE_W / 2} y2="14" stroke="oklch(0.5 0.025 145 / 0.5)" strokeWidth="1" strokeDasharray="2 2" />
                  <line x1={nodesStart - 4} y1="14" x2={nodesStart + nodesW + 4} y2="14" stroke="oklch(0.5 0.025 145 / 0.4)" strokeWidth="1" />
                </svg>
                {nodes.map(group => {
                  const color = group.k === "tts" ? "var(--tts)" : group.k === "sfx" ? "var(--sfx)" : "var(--music)";
                  const items = [];
                  for (let j = 0; j < group.n; j++) {
                    const cx = x + nodesStart + acc * (NODE_SIZE + NODE_GAP);
                    items.push(
                      <div key={`${group.k}-${j}`} title={`${group.k.toUpperCase()} asset`} style={{
                        position: "absolute", left: cx, top: BASE_Y + PLATE_H + 14 + 4,
                        width: NODE_SIZE, height: NODE_SIZE, borderRadius: 2,
                        background: color, opacity: 0.85,
                        border: "1px solid color-mix(in oklch, " + color + " 60%, black)",
                      }} />
                    );
                    acc++;
                  }
                  return items;
                })}
              </React.Fragment>
            );
          })}

          {/* Bottom episode timeline */}
          <div style={{
            position: "absolute", left: 60, right: 60, bottom: 24,
            border: "1px solid var(--line-1)",
            background: "color-mix(in oklch, var(--bg-2) 80%, transparent)",
            borderRadius: 2, padding: "10px 16px",
            display: "flex", alignItems: "center", gap: 16,
            fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em"
          }}>
            <span style={{ color: "var(--fg-3)", textTransform: "uppercase" }}>Episode timeline</span>
            <div style={{ flex: 1, height: 22 }}>
              <svg width="100%" height="22" viewBox="0 0 1000 22" preserveAspectRatio="none">
                {(() => {
                  const total = scenes.reduce((a, s) => a + (parseInt(s.duration.split(":")[0]) * 60 + parseInt(s.duration.split(":")[1])), 0);
                  let acc = 0;
                  const colors = { rendered: "oklch(0.72 0.13 145)", ready: "oklch(0.72 0.10 230)", gen: "oklch(0.78 0.14 75)", draft: "oklch(0.45 0.01 145)" };
                  return scenes.map((s) => {
                    const dur = parseInt(s.duration.split(":")[0]) * 60 + parseInt(s.duration.split(":")[1]);
                    const xx = (acc / total) * 1000;
                    const w = (dur / total) * 1000;
                    acc += dur;
                    return (
                      <g key={s.no}>
                        <rect x={xx + 1} y="4" width={w - 2} height="14" fill={colors[s.status]} opacity="0.6" rx="1" />
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

      {/* Coords (fixed, viewport-anchored) */}
      <div className="pyramid-coord">
        <span>X 0.000</span><span>Y 0.000</span><span>ZOOM 1.00</span><span>SCALE 1:48</span>
      </div>

      {/* Zoom controls */}
      <div className="pyramid-zoom">
        <button title="Zoom in"><Icon name="plus" /></button>
        <button title="Zoom out"><Icon name="minus" /></button>
        <button title="Fit"><Icon name="fit" /></button>
      </div>
    </div>
  );
}

window.PyramidView = PyramidView;
