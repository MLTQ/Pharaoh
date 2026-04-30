import React, { useEffect, useState } from "react";
import { Icon, Wave } from "./components/shared/atoms";
import { PyramidView } from "./components/pyramid/PyramidView";
import { StoryBibleView } from "./components/pyramid/StoryBibleView";
import { CompositionView } from "./components/timeline/CompositionView";
import { TTSPanel } from "./components/generators/TTSPanel";
import { SFXPanel } from "./components/generators/SFXPanel";
import { MusicPanel } from "./components/generators/MusicPanel";
import { AgentFeed } from "./components/shared/AgentFeed";
import { AssetBrowser } from "./components/shared/AssetBrowser";
import { JobQueue } from "./components/shared/JobQueue";
import { ProjectPicker } from "./components/project/ProjectPicker";
import { useProjectStore } from "./store/projectStore";
import { useJobStore } from "./store/jobStore";
import { useUiStore } from "./store/uiStore";
import { usePlaybackStore } from "./store/playbackStore";
import { useModelStore } from "./store/modelStore";
import { getProjectsDir } from "./lib/tauriCommands";
import type { Project } from "./lib/types";
import { MOCK_AGENT_LOG, MOCK_TRACKS } from "./lib/mockData";
import type { ViewId, RightTab } from "./lib/types";

const RAIL_ITEMS: { id: ViewId; icon: Parameters<typeof Icon>[0]["name"]; label: string; model?: string }[] = [
  { id: "pyramid",     icon: "pyramid",   label: "Pyramid" },
  { id: "composition", icon: "timeline",  label: "Composition" },
  { id: "bible",       icon: "book",      label: "Story Bible" },
  { id: "tts",         icon: "mic",       label: "Voice / TTS",    model: "tts" },
  { id: "sfx",         icon: "waves",     label: "Sound design",   model: "sfx" },
  { id: "music",       icon: "music",     label: "Score",          model: "music" },
];

const STATUS_COLOR: Record<string, string> = {
  online:  "var(--st-rendered)",
  offline: "var(--sfx)",
  loading: "var(--st-gen)",
  unknown: "var(--fg-4)",
};

export default function App() {
  const { project, scenes, cast, assets, activeSceneNo, setActiveScene, updateScene, loadRealProject } = useProjectStore();
  const { jobs, initListeners } = useJobStore();
  const { view, rightTab, colorTemp, density, setView, setRightTab } = useUiStore();
  const { isPlaying, play, pause, positionMs } = usePlaybackStore();
  const { tts, sfx, music, pollHealth } = useModelStore();
  const [showProjectPicker, setShowProjectPicker] = useState(false);

  const scene = scenes.find((s) => s.no === activeSceneNo) ?? scenes[0];

  // Apply theme to root
  useEffect(() => {
    document.documentElement.dataset.colorTemp = colorTemp === "forest" ? "" : colorTemp;
    document.documentElement.dataset.density   = density === "compact" ? "compact" : "";
  }, [colorTemp, density]);

  // Wire Tauri job events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    initListeners().then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Poll server health on mount and every 30s
  useEffect(() => {
    pollHealth();
    const id = setInterval(pollHealth, 30_000);
    return () => clearInterval(id);
  }, []);

  const breadcrumb = (() => {
    if (view === "pyramid")     return [{ k: "Project", v: project.title, active: true }];
    if (view === "bible")       return [{ k: "Project", v: project.title }, { k: "Tier I", v: "Story Bible", active: true }];
    if (view === "composition") return [{ k: "Project", v: project.title }, { k: "Tier II", v: scene.no }, { k: "Composition", v: scene.title, active: true }];
    if (view === "tts")         return [{ k: "Project", v: project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Dialogue", active: true }];
    if (view === "sfx")         return [{ k: "Project", v: project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Sound design", active: true }];
    if (view === "music")       return [{ k: "Project", v: project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Score", active: true }];
    return [];
  })();

  const sidebarTitle: Record<ViewId, { eyebrow: string; title: string }> = {
    pyramid:     { eyebrow: "Workspace", title: "Pyramid" },
    composition: { eyebrow: "Workspace", title: "Composition" },
    bible:       { eyebrow: "Workspace", title: "Story Bible" },
    tts:         { eyebrow: "Generation", title: "Voice · Dialogue" },
    sfx:         { eyebrow: "Generation", title: "Sound design" },
    music:       { eyebrow: "Generation", title: "Score" },
  };

  const runningJobs = jobs.filter((j) => j.status === "running").length;

  const formatMs = (ms: number) => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60).toString().padStart(2, "0");
    const s = (total % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  if (showProjectPicker) {
    return (
      <ProjectPicker
        onOpen={async (p: Project) => {
          try {
            const pDir = await getProjectsDir();
            loadRealProject(p, pDir);
          } catch {
            // Running in browser — still close picker
          }
          setShowProjectPicker(false);
          setView("pyramid");
        }}
      />
    );
  }

  return (
    <div className="app">
      {/* ── TOPBAR ─────────────────────────────────────────────────────── */}
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <polygon points="12,3 21,20 3,20" />
              <path d="M12 3 V20" />
            </svg>
          </div>
          Pharaoh
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

        {/* Server health dots */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 8 }}>
          {(["tts", "sfx", "music"] as const).map((m) => {
            const s = m === "tts" ? tts : m === "sfx" ? sfx : music;
            return (
              <span
                key={m}
                title={`${m.toUpperCase()} server: ${s}`}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)",
                  letterSpacing: "0.06em", textTransform: "uppercase",
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: STATUS_COLOR[s] ?? "var(--fg-4)",
                  boxShadow: s === "online" ? `0 0 4px ${STATUS_COLOR[s]}` : "none",
                }} />
                {m}
              </span>
            );
          })}
        </div>

        <div className="status-pills">
          <span className="status-pill"><span className="dot" /> autosaved {project.lastSync.split(" ")[1]}</span>
          {runningJobs > 0 && (
            <span className="status-pill"><span className="dot warn" /> {runningJobs} job{runningJobs !== 1 ? "s" : ""} running</span>
          )}
        </div>
        <div className="agent-pill">
          <span className="pulse" /> Agents · 4 active
          <button>Take over</button>
        </div>
      </div>

      {/* ── RAIL ───────────────────────────────────────────────────────── */}
      <div className="rail">
        {RAIL_ITEMS.map((r) => (
          <button
            key={r.id}
            className={`rail-btn ${view === r.id ? "active" : ""}`}
            title={r.label}
            onClick={() => setView(r.id)}
          >
            <Icon name={r.icon} style={{ width: 18, height: 18 }} />
            {r.model === "tts"   && <span className="rail-badge" style={{ background: "var(--tts)" }}>2</span>}
            {r.model === "sfx"   && <span className="rail-badge" style={{ background: "var(--sfx)" }}>1</span>}
            {r.model === "music" && <span className="rail-badge" style={{ background: "var(--music)" }}>1</span>}
          </button>
        ))}
        <div className="rail-spacer" />
        <button className="rail-btn" title="Switch project" onClick={() => setShowProjectPicker(true)}>
          <Icon name="folder" style={{ width: 18, height: 18 }} />
        </button>
        <button className="rail-btn"><Icon name="settings" style={{ width: 18, height: 18 }} /></button>
      </div>

      {/* ── SIDEBAR ────────────────────────────────────────────────────── */}
      <div className="sidebar">
        <div className="sidebar-head">
          <span className="eyebrow">{sidebarTitle[view].eyebrow}</span>
          <span className="title">{sidebarTitle[view].title}</span>
        </div>
        <div className="sidebar-body">
          <div className="side-section">Tier I · Story</div>
          <div className={`side-item ${view === "bible" ? "active" : ""}`} onClick={() => setView("bible")}>
            <span className="ico"><Icon name="book" style={{ width: 14, height: 14 }} /></span>
            <span>Story Bible</span>
            <span className="num">{project.revision}</span>
          </div>

          <div className="side-section">Tier II · Scenes</div>
          {scenes.map((s) => (
            <div
              key={s.no}
              className={`side-item ${activeSceneNo === s.no && view === "composition" ? "active" : ""}`}
              onClick={() => { setActiveScene(s.no); setView("composition"); }}
            >
              <span style={{
                display: "inline-block", width: 9, height: 9, borderRadius: "50%",
                border: `1.5px solid ${
                  s.status === "rendered" ? "var(--st-rendered)" :
                  s.status === "gen" ? "var(--st-gen)" :
                  s.status === "ready" ? "var(--st-ready)" : "var(--st-draft)"
                }`,
                background: s.status === "rendered" ? "var(--st-rendered)" : "transparent",
                flexShrink: 0,
              }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12 }}>{s.no} · {s.title}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                  {s.duration} · rev.{s.rev}
                </span>
              </span>
            </div>
          ))}

          <div className="side-section">Tier III · Generate</div>
          <div className={`side-item ${view === "tts" ? "active" : ""}`} onClick={() => setView("tts")}>
            <span className="ico" style={{ color: "var(--tts)" }}><Icon name="mic" style={{ width: 14, height: 14 }} /></span>
            <span>Voice · Dialogue</span>
            <span className="num">2</span>
          </div>
          <div className={`side-item ${view === "sfx" ? "active" : ""}`} onClick={() => setView("sfx")}>
            <span className="ico" style={{ color: "var(--sfx)" }}><Icon name="waves" style={{ width: 14, height: 14 }} /></span>
            <span>Sound design</span>
            <span className="num">1</span>
          </div>
          <div className={`side-item ${view === "music" ? "active" : ""}`} onClick={() => setView("music")}>
            <span className="ico" style={{ color: "var(--music)" }}><Icon name="music" style={{ width: 14, height: 14 }} /></span>
            <span>Score</span>
            <span className="num">1</span>
          </div>

          <div className="side-section">Cast · {cast.length}</div>
          {cast.map((c) => (
            <div key={c.id} className="side-item">
              <span className="ico">
                <span style={{
                  display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                  background: `oklch(0.7 0.06 ${(c.id.charCodeAt(0) * 13) % 360})`,
                  border: "1px solid var(--line-2)",
                }} />
              </span>
              <span>{c.name}</span>
              <span className="num">{c.scenes}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── CANVAS ─────────────────────────────────────────────────────── */}
      <div className="canvas">
        {view === "pyramid" && (
          <PyramidView
            project={project}
            scenes={scenes}
            cast={cast}
            activeSceneNo={activeSceneNo}
            onOpenScene={(no) => { setActiveScene(no); setView("composition"); }}
            onOpenBible={() => setView("bible")}
          />
        )}
        {view === "composition" && (
          <CompositionView
            scene={scene}
            scenes={scenes}
            tracks={MOCK_TRACKS}
            assets={assets}
            onSwitchScene={(no) => setActiveScene(no)}
            onOpenPyramid={() => setView("pyramid")}
            onUpdateScene={updateScene}
          />
        )}
        {view === "bible" && <StoryBibleView project={project} cast={cast} />}
        {view === "tts"   && <TTSPanel cast={cast} scenes={scenes} defaultScene={activeSceneNo} />}
        {view === "sfx"   && <SFXPanel scenes={scenes} defaultScene={activeSceneNo} />}
        {view === "music" && <MusicPanel scenes={scenes} defaultScene={activeSceneNo} />}
      </div>

      {/* ── RIGHT RAIL ─────────────────────────────────────────────────── */}
      <div className="right">
        <div className="right-tabs">
          {(["agent", "assets", "jobs"] as RightTab[]).map((tab) => (
            <button
              key={tab}
              className={`right-tab ${rightTab === tab ? "active" : ""}`}
              onClick={() => setRightTab(tab)}
            >
              {tab === "jobs" ? `Jobs · ${runningJobs}` : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        <div className="right-body">
          {rightTab === "agent"  && <AgentFeed log={MOCK_AGENT_LOG} />}
          {rightTab === "assets" && <AssetBrowser assets={assets} />}
          {rightTab === "jobs"   && <JobQueue jobs={jobs} />}
        </div>
      </div>

      {/* ── TRANSPORT ──────────────────────────────────────────────────── */}
      <div className="transport">
        <div className="tp-controls">
          <button className="tp-btn"><Icon name="skip_back" style={{ width: 14, height: 14 }} /></button>
          <button
            className="tp-btn play"
            onClick={() => isPlaying ? pause() : play()}
          >
            <Icon name={isPlaying ? "pause" : "play"} style={{ width: 12, height: 12 }} />
          </button>
          <button className="tp-btn"><Icon name="skip_fwd" style={{ width: 14, height: 14 }} /></button>
          <button className="tp-btn" style={{ color: "oklch(0.78 0.14 30)" }}>
            <Icon name="record" style={{ width: 14, height: 14 }} />
          </button>
          <span style={{ marginLeft: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>
            {formatMs(positionMs)} / {scene.duration}
          </span>
        </div>
        <div className="tp-mini">
          <span className="tp-mini-label">{scene.no} · {scene.title}</span>
          <div className="tp-wave">
            <Wave width={500} height={24} seed={scene.no.charCodeAt(2)} count={140} color="var(--fg-2)" opacity={0.65} />
          </div>
          <span className="tp-time">−{scene.duration}</span>
        </div>
        <div className="tp-meta">
          <div>−14.2 LU · −1.8 dB TP</div>
          <div style={{ color: "var(--fg-4)", marginTop: 2 }}>48 kHz · 24-bit · stereo</div>
        </div>
      </div>
    </div>
  );
}
