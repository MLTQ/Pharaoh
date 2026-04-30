// Pharoh — main app
const { useState, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "pyramidLiteralness": "literal",
  "colorTemp": "forest",
  "density": "comfortable"
}/*EDITMODE-END*/;

function App() {
  const data = window.PHAROH_DATA;
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState("pyramid");
  const [activeScene, setActiveScene] = useState("S04");
  const [rightTab, setRightTab] = useState("agent");
  const [scenes, setScenes] = useState(data.scenes);
  const updateScene = (no, patch) => setScenes(ss => ss.map(s => s.no === no ? { ...s, ...patch } : s));

  // Apply tweaks to root
  useEffect(() => {
    document.documentElement.dataset.colorTemp = tweaks.colorTemp === "forest" ? "" : tweaks.colorTemp;
    document.documentElement.dataset.density = tweaks.density === "compact" ? "compact" : "";
  }, [tweaks]);

  const scene = scenes.find(s => s.no === activeScene) || scenes[3];

  const railItems = [
    { id: "pyramid", icon: "pyramid", label: "Pyramid" },
    { id: "composition", icon: "timeline", label: "Composition" },
    { id: "bible", icon: "book", label: "Story Bible" },
    { id: "tts", icon: "mic", label: "Voice / TTS", model: "tts" },
    { id: "sfx", icon: "waves", label: "Sound design", model: "sfx" },
    { id: "music", icon: "music", label: "Score", model: "music" },
  ];

  const sidebarTitle = {
    pyramid: { eyebrow: "Workspace", title: "Pyramid" },
    composition: { eyebrow: "Workspace", title: "Composition" },
    bible: { eyebrow: "Workspace", title: "Story Bible" },
    tts: { eyebrow: "Generation", title: "Voice · Dialogue" },
    sfx: { eyebrow: "Generation", title: "Sound design" },
    music: { eyebrow: "Generation", title: "Score" },
  }[view];

  const breadcrumb = (() => {
    if (view === "pyramid") return [{ k: "Project", v: data.project.title, active: true }];
    if (view === "bible") return [{ k: "Project", v: data.project.title }, { k: "Tier I", v: "Story Bible", active: true }];
    if (view === "composition") return [{ k: "Project", v: data.project.title }, { k: "Tier II", v: scene.no }, { k: "Composition", v: scene.title, active: true }];
    if (view === "tts") return [{ k: "Project", v: data.project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Dialogue", active: true }];
    if (view === "sfx") return [{ k: "Project", v: data.project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Sound design", active: true }];
    if (view === "music") return [{ k: "Project", v: data.project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Score", active: true }];
    return [];
  })();

  return (
    <div className="app">
      {/* TOPBAR */}
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><polygon points="12,3 21,20 3,20" /><path d="M12 3 V20" /></svg>
          </div>
          Pharoh
        </div>
        <div className="breadcrumb">
          {breadcrumb.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sep">/</span>}
              <span className={`crumb ${b.active ? "active" : ""}`}>
                <span style={{ color: "var(--fg-4)", marginRight: 6 }}>{b.k}</span>{b.v}
              </span>
            </React.Fragment>
          ))}
        </div>
        <div className="topbar-spacer" />
        <div className="status-pills">
          <span className="status-pill"><span className="dot" /> autosaved 14:22</span>
          <span className="status-pill"><span className="dot warn" /> 2 jobs running</span>
        </div>
        <div className="agent-pill">
          <span className="pulse" /> Agents · 4 active
          <button>Take over</button>
        </div>
      </div>

      {/* RAIL */}
      <div className="rail">
        {railItems.map(r => (
          <button
            key={r.id}
            className={`rail-btn ${view === r.id ? "active" : ""}`}
            title={r.label}
            onClick={() => setView(r.id)}
          >
            <Icon name={r.icon} />
            {r.id === "tts" && <span className="rail-badge" style={{ background: "var(--tts)" }}>2</span>}
            {r.id === "sfx" && <span className="rail-badge" style={{ background: "var(--sfx)" }}>1</span>}
            {r.id === "music" && <span className="rail-badge" style={{ background: "var(--music)" }}>1</span>}
          </button>
        ))}
        <div className="rail-spacer" />
        <button className="rail-btn"><Icon name="folder" /></button>
        <button className="rail-btn"><Icon name="settings" /></button>
      </div>

      {/* SIDEBAR */}
      <div className="sidebar">
        <div className="sidebar-head">
          <span className="eyebrow">{sidebarTitle.eyebrow}</span>
          <span className="title">{sidebarTitle.title}</span>
        </div>
        <div className="sidebar-body">
          <div className="side-section">Tier I · Story</div>
          <div className={`side-item ${view === "bible" ? "active" : ""}`} onClick={() => setView("bible")}>
            <span className="ico"><Icon name="book" /></span>
            <span>Story Bible</span>
            <span className="num">REV.07</span>
          </div>

          <div className="side-section">Tier II · Scenes</div>
          {scenes.map(s => (
            <div
              key={s.no}
              className={`side-item ${activeScene === s.no && view === "composition" ? "active" : ""}`}
              onClick={() => { setActiveScene(s.no); setView("composition"); }}
            >
              <StatusRing s={s.status} />
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12 }}>{s.no} · {s.title}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{s.duration} · rev.{s.rev}</span>
              </span>
            </div>
          ))}

          <div className="side-section">Tier III · Generate</div>
          <div className={`side-item ${view === "tts" ? "active" : ""}`} onClick={() => setView("tts")}>
            <span className="ico" style={{ color: "var(--tts)" }}><Icon name="mic" /></span>
            <span>Voice · Dialogue</span>
            <span className="num">2</span>
          </div>
          <div className={`side-item ${view === "sfx" ? "active" : ""}`} onClick={() => setView("sfx")}>
            <span className="ico" style={{ color: "var(--sfx)" }}><Icon name="waves" /></span>
            <span>Sound design</span>
            <span className="num">1</span>
          </div>
          <div className={`side-item ${view === "music" ? "active" : ""}`} onClick={() => setView("music")}>
            <span className="ico" style={{ color: "var(--music)" }}><Icon name="music" /></span>
            <span>Score</span>
            <span className="num">1</span>
          </div>

          <div className="side-section">Cast · {data.cast.length}</div>
          {data.cast.map(c => (
            <div key={c.id} className="side-item">
              <span className="ico"><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: `oklch(0.7 0.06 ${(c.id.charCodeAt(0) * 13) % 360})`, border: "1px solid var(--line-2)" }} /></span>
              <span>{c.name}</span>
              <span className="num">{c.scenes}</span>
            </div>
          ))}
        </div>
      </div>

      {/* CANVAS */}
      <div className="canvas">
        {view === "pyramid" && (
          <PyramidView
            scenes={scenes}
            project={data.project}
            cast={data.cast}
            activeScene={activeScene}
            onOpenScene={(no) => { setActiveScene(no); setView("composition"); }}
            onOpenBible={() => setView("bible")}
          />
        )}
        {view === "composition" && (
          <CompositionView
            scene={scene}
            scenes={scenes}
            tracks={data.tracks}
            allAssets={data.assets}
            onSwitchScene={(no) => setActiveScene(no)}
            onOpenPyramid={() => setView("pyramid")}
            onUpdateScene={updateScene}
          />
        )}
        {view === "bible" && <StoryBibleView project={data.project} cast={data.cast} />}
        {view === "tts" && <TTSPanel cast={data.cast} scenes={scenes} defaultScene={activeScene} />}
        {view === "sfx" && <SFXPanel scenes={scenes} defaultScene={activeScene} />}
        {view === "music" && <MusicPanel scenes={scenes} defaultScene={activeScene} />}
      </div>

      {/* RIGHT */}
      <div className="right">
        <div className="right-tabs">
          <button className={`right-tab ${rightTab === "agent" ? "active" : ""}`} onClick={() => setRightTab("agent")}>Agent</button>
          <button className={`right-tab ${rightTab === "assets" ? "active" : ""}`} onClick={() => setRightTab("assets")}>Assets</button>
          <button className={`right-tab ${rightTab === "jobs" ? "active" : ""}`} onClick={() => setRightTab("jobs")}>Jobs · 2</button>
        </div>
        <div className="right-body">
          {rightTab === "agent" && <AgentFeed log={data.agentLog} />}
          {rightTab === "assets" && <AssetBrowser assets={data.assets} />}
          {rightTab === "jobs" && <JobQueue jobs={data.jobs} />}
        </div>
      </div>

      {/* TRANSPORT */}
      <div className="transport">
        <div className="tp-controls">
          <button className="tp-btn"><Icon name="skip_back" /></button>
          <button className="tp-btn play"><Icon name="play" /></button>
          <button className="tp-btn"><Icon name="skip_fwd" /></button>
          <button className="tp-btn" style={{ color: "oklch(0.78 0.14 30)" }}><Icon name="record" /></button>
          <span style={{ marginLeft: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>00:01:12 / 00:06:04</span>
        </div>
        <div className="tp-mini">
          <span className="tp-mini-label">{scene.no} · {scene.title}</span>
          <div className="tp-wave"><Wave width={500} height={24} seed={scene.no.charCodeAt(2)} count={140} color="var(--fg-2)" opacity={0.65} /></div>
          <span className="tp-time">−4:52</span>
        </div>
        <div className="tp-meta">
          <div>−14.2 LU · −1.8 dB TP</div>
          <div style={{ color: "var(--fg-4)", marginTop: 2 }}>48 kHz · 24-bit · stereo</div>
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Color temperature">
          <TweakRadio
            value={tweaks.colorTemp}
            onChange={(v) => setTweak("colorTemp", v)}
            options={[
              { value: "forest", label: "Forest" },
              { value: "warm", label: "Warm" },
              { value: "neutral", label: "Neutral" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Pyramid literalness">
          <TweakRadio
            value={tweaks.pyramidLiteralness}
            onChange={(v) => setTweak("pyramidLiteralness", v)}
            options={[
              { value: "literal", label: "Literal" },
              { value: "implied", label: "Implied" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Density">
          <TweakRadio
            value={tweaks.density}
            onChange={(v) => setTweak("density", v)}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
