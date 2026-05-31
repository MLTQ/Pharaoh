import React, { useEffect, useState } from "react";
import { Icon, Wave } from "./components/shared/atoms";
import { PyramidView } from "./components/pyramid/PyramidView";
import { StoryBibleView } from "./components/pyramid/StoryBibleView";
import { CharacterDesignerView } from "./components/characters/CharacterDesignerView";
import { LibraryView } from "./components/library/LibraryView";
import { CompositionView } from "./components/timeline/CompositionView";
import { TTSPanel } from "./components/generators/TTSPanel";
import { SFXPanel } from "./components/generators/SFXPanel";
import { MusicPanel } from "./components/generators/MusicPanel";
import { AgentFeed } from "./components/shared/AgentFeed";
import { AssetBrowser } from "./components/shared/AssetBrowser";
import { JobQueue } from "./components/shared/JobQueue";
import { SettingsView } from "./components/settings/SettingsView";
import { ModelsView } from "./components/models/ModelsView";
import { UpscaleView } from "./components/upscale/UpscaleView";
import { ClipStudioView } from "./components/post/ClipStudioView";
import { FinalAssemblyView } from "./components/post/FinalAssemblyView";
import { ProjectLauncherView } from "./components/launcher/ProjectLauncherView";
import { ProjectChooser } from "./components/launcher/ProjectChooser";
import { ToastHost } from "./components/shared/ToastHost";
import { SetupBanner } from "./components/shared/SetupBanner";
import { useProjectStore } from "./store/projectStore";
import { useJobStore } from "./store/jobStore";
import { useUiStore } from "./store/uiStore";
import { useModelStore } from "./store/modelStore";
import { useRenderMetaStore } from "./store/renderMetaStore";
import { useAudioStore } from "./store/audioStore";
import { useToastStore } from "./store/toastStore";
import type { ViewId, WorkspaceId, RightTab } from "./lib/types";
import { WORKSPACE_OF } from "./lib/types";

// ── Rail = workspace switcher ────────────────────────────────────────────────
//
// Five top-level workspace modes. The sidebar's content swaps based on which
// workspace is active. Voice/SFX/Score live inside the Scenes workspace as
// inline tabs, not separate top-level destinations.

type RailItem = {
  id: WorkspaceId;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
};

const RAIL_WORKSPACES: RailItem[] = [
  { id: "pyramid", icon: "pyramid",  label: "Pyramid" },
  { id: "story",   icon: "book",     label: "Story" },
  { id: "scenes",  icon: "timeline", label: "Scenes" },
  { id: "polish",  icon: "sparkle",  label: "Polish" },
  { id: "app",     icon: "settings", label: "App" },
];

// Sub-tabs within the Scenes workspace — shown as a tab strip above the canvas
// when a scene workspace view is active.
const SCENE_SUBTABS: { id: ViewId; label: string; accent: string }[] = [
  { id: "composition", label: "Compose", accent: "var(--fg-1)" },
  { id: "tts",         label: "Voice",   accent: "var(--tts)" },
  { id: "sfx",         label: "Sound",   accent: "var(--sfx)" },
  { id: "music",       label: "Score",   accent: "var(--music)" },
];

const STATUS_COLOR: Record<string, string> = {
  online:  "var(--st-rendered)",
  offline: "var(--sfx)",
  loading: "var(--st-gen)",
  unknown: "var(--fg-4)",
};

export default function App() {
  const {
    project, scenes, assets, activeSceneNo,
    setActiveScene, updateScene, characters, realProjectId,
    reloadProjectFromDisk,
  } = useProjectStore();
  const { jobs, initListeners } = useJobStore();
  const { view, rightTab, colorTemp, density, setView, setWorkspace, setRightTab, agentActiveUntil } = useUiStore();
  const activeWorkspace = WORKSPACE_OF[view];
  // Transport state — single source of truth. audioStore is the real engine
  // (HTMLAudioElement + RAF position tracking); the old usePlaybackStore stub
  // has been removed.
  const audioPlayingPath = useAudioStore((s) => s.playing);
  const audioPositionSec = useAudioStore((s) => s.position);
  const stopAudio       = useAudioStore((s) => s.stop);
  const isPlaying = audioPlayingPath !== null;
  const positionMs = Math.round(audioPositionSec * 1000);
  const { tts, sfx, music, post, pollHealth, initListeners: initModelListeners } = useModelStore();

  const [_tick, setTick] = useState(0);
  useEffect(() => {
    if (!agentActiveUntil) return;
    const remaining = agentActiveUntil - Date.now();
    if (remaining <= 0) return;
    const id = setTimeout(() => setTick((t) => t + 1), remaining + 50);
    return () => clearTimeout(id);
  }, [agentActiveUntil]);
  const agentActive = agentActiveUntil !== null && Date.now() < agentActiveUntil;

  const scene = scenes.find((s) => s.no === activeSceneNo) ?? scenes[0];
  const renderMeta = useRenderMetaStore((s) => (scene?.slug ? s.metaBySlug[scene.slug] ?? null : null));

  useEffect(() => {
    document.documentElement.dataset.colorTemp = colorTemp === "forest" ? "" : colorTemp;
    document.documentElement.dataset.density   = density === "compact" ? "compact" : "";
  }, [colorTemp, density]);

  // ── Global keyboard shortcuts ──
  // Single listener that gates on active element so it doesn't fire while
  // typing into inputs / textareas / contenteditable. Only the project chooser
  // and scene navigation work cross-view; per-surface shortcuts (J/K/L scrub,
  // Cmd-Z, etc.) live in their own components.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const inEditor = target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
      const cmd = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl-K — quick project switcher (the rail folder icon's gesture)
      if (cmd && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        // Anchor near the rail's folder icon (bottom-left)
        setProjectChooser({ x: 56, y: window.innerHeight - 80 });
        return;
      }

      // Cmd/Ctrl-S — confirm save. We already autosave; this just reassures
      // users with the muscle-memory and triggers an explicit flush via the
      // beforeunload-style listeners that components install.
      if (cmd && e.key.toLowerCase() === "s" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        // Dispatch a synthetic beforeunload so any debounced writers flush
        // immediately. They install with `addEventListener("beforeunload", flush)`.
        window.dispatchEvent(new Event("beforeunload"));
        useToastStore.getState().push({ kind: "info", title: "Saved" });
        return;
      }

      // Skip the rest when the user is typing
      if (inEditor) return;

      // ← / → arrow keys: previous/next scene when no input is focused.
      // Loops at the ends — better than dead-stopping for long episodes.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && scenes.length > 1) {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const idx = Math.max(0, scenes.findIndex((s) => s.no === activeSceneNo));
        const next = scenes[(idx + dir + scenes.length) % scenes.length];
        setActiveScene(next.no);
        return;
      }

      // Space — stop audio if anything's playing. Per-surface space handlers
      // (ClipStudio crop preview) take precedence by stopping propagation
      // before this fires.
      if (e.code === "Space" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (audioPlayingPath) {
          e.preventDefault();
          stopAudio();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenes, activeSceneNo, audioPlayingPath, setActiveScene, stopAudio]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    initListeners().then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Reload project from disk whenever the window regains focus — this keeps
  // the in-memory store in sync when MCP tools (or any external process) have
  // written to project.json while the app was in the background.
  useEffect(() => {
    const onFocus = () => { if (realProjectId) reloadProjectFromDisk(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [realProjectId, reloadProjectFromDisk]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    initModelListeners().then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    pollHealth();
    const id = setInterval(pollHealth, 30_000);
    return () => clearInterval(id);
  }, []);

  const runningJobs = jobs.filter((j) => j.status === "running").length;

  const formatMs = (ms: number) => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60).toString().padStart(2, "0");
    const s = (total % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // Project chooser popover anchor — toggled by the rail's folder icon.
  // Declared before the launcher early-return so hook order is stable across
  // realProjectId transitions (otherwise React errors on hook count change).
  const [projectChooser, setProjectChooser] = useState<{ x: number; y: number } | null>(null);
  const [launcherPanel, setLauncherPanel] = useState<"projects" | "settings">("projects");

  // ── No project: launcher shell ───────────────────────────────────────────
  if (!realProjectId) {
    return (
      <div className="app" style={{ gridTemplateColumns: "56px minmax(0, 1fr)", gridTemplateRows: "1fr" }}>
        {/* Minimal rail */}
        <div className="rail" style={{ gridRow: "1" }}>
          <button
            className={`rail-btn ${launcherPanel === "projects" ? "active" : ""}`}
            title="Projects"
            onClick={() => setLauncherPanel("projects")}
          >
            <Icon name="folder" style={{ width: 18, height: 18 }} />
          </button>
          <div className="rail-spacer" />
          <button
            className={`rail-btn ${launcherPanel === "settings" ? "active" : ""}`}
            title="Settings"
            onClick={() => setLauncherPanel("settings")}
          >
            <Icon name="settings" style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* Full-area content */}
        <div style={{ gridColumn: 2, gridRow: 1, position: "relative" }}>
          {launcherPanel === "settings" ? (
            <SettingsView />
          ) : (
            <ProjectLauncherView onOpenSettings={() => setLauncherPanel("settings")} />
          )}
        </div>
        {/* Setup banner is part of the launcher experience too — first-run
            users hit ffmpeg-missing before any project exists. */}
        <SetupBanner />
      </div>
    );
  }

  // ── Project open: full layout ─────────────────────────────────────────────

  const breadcrumb = (() => {
    if (view === "pyramid")     return [{ k: "Project", v: project.title, active: true }];
    if (view === "bible")       return [{ k: "Project", v: project.title }, { k: "Tier I", v: "Story Bible", active: true }];
    if (view === "characters")  return [{ k: "Project", v: project.title }, { k: "Tier I", v: "Cast & Voices", active: true }];
    if (view === "library")     return [{ k: "Project", v: project.title }, { k: "Tier I", v: "Character Library", active: true }];
    if (view === "settings")    return [{ k: "Project", v: project.title }, { k: "App", v: "Settings", active: true }];
    if (view === "models")      return [{ k: "Project", v: project.title }, { k: "App", v: "Models", active: true }];
    if (view === "clip-studio") return [{ k: "Project", v: project.title }, { k: "Post", v: "Clip Studio", active: true }];
    if (view === "upscale")     return [{ k: "Project", v: project.title }, { k: "Post", v: "Audio Upscale", active: true }];
    if (view === "final")       return [{ k: "Project", v: project.title }, { k: "Post", v: "Final Assembly", active: true }];
    if (view === "composition" && scene) {
      return [{ k: "Project", v: project.title }, { k: "Tier II", v: scene.no }, { k: "Composition", v: scene.title, active: true }];
    }
    if (view === "tts" && scene)   return [{ k: "Project", v: project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Dialogue", active: true }];
    if (view === "sfx" && scene)   return [{ k: "Project", v: project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Sound design", active: true }];
    if (view === "music" && scene) return [{ k: "Project", v: project.title }, { k: scene.no, v: scene.title }, { k: "Generate", v: "Score", active: true }];
    return [{ k: "Project", v: project.title, active: true }];
  })();

  // Sidebar header is now keyed by workspace, not view.
  const sidebarTitle: Record<WorkspaceId, { eyebrow: string; title: string }> = {
    pyramid: { eyebrow: "Project", title: "Pyramid" },
    story:   { eyebrow: "Tier I",  title: "Story" },
    scenes:  { eyebrow: "Tier II", title: "Scenes" },
    polish:  { eyebrow: "Post",    title: "Polish" },
    app:     { eyebrow: "App",     title: "Settings" },
  };
  const sidebar = sidebarTitle[activeWorkspace];

  // Per-channel running-job counts (powers per-channel color dots on the
  // Scenes rail icon and the badges on each Scene sub-tab).
  const ttsJobsRunning = jobs.filter((j) => j.status === "running" && j.model === "tts").length;
  const sfxJobsRunning = jobs.filter((j) => j.status === "running" && j.model === "sfx").length;
  const musicJobsRunning = jobs.filter((j) => j.status === "running" && j.model === "music").length;
  const sceneJobsRunning = ttsJobsRunning + sfxJobsRunning + musicJobsRunning;

  return (
    <div className="app">
      {/* ── TOPBAR ──────────────────────────────────────────────────────── */}
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
          {([
            ["tts", "TTS", tts],
            ["sfx", "SFX", sfx],
            ["music", "MUSIC", music],
            ["post", "AUDIOSR", post],
          ] as const).map(([key, label, s]) => {
            return (
              <span
                key={key}
                title={`${label} server: ${s}`}
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
                {label}
              </span>
            );
          })}
        </div>

        <div className="status-pills">
          {project.lastSync && (
            <span className="status-pill"><span className="dot" /> autosaved {project.lastSync.split(" ")[1]}</span>
          )}
          {runningJobs > 0 && (
            <span className="status-pill"><span className="dot warn" /> {runningJobs} job{runningJobs !== 1 ? "s" : ""} running</span>
          )}
        </div>
        {agentActive && (
          <div className="agent-pill">
            <span className="pulse" /> Agent active
            <button>Take over</button>
          </div>
        )}
      </div>

      {/* ── RAIL (workspace switcher) ────────────────────────────────── */}
      <div className="rail">
        {RAIL_WORKSPACES.map((r) => {
          const isActive = activeWorkspace === r.id;
          // Per-channel color dots on the Scenes icon when generation is running —
          // restores the channel-color signal from the old per-model rail items.
          const showChannelDots = r.id === "scenes" && sceneJobsRunning > 0;
          return (
            <button
              key={r.id}
              className={`rail-btn ${isActive ? "active" : ""}`}
              title={r.label}
              onClick={() => setWorkspace(r.id)}
              style={{ position: "relative" }}
            >
              <Icon name={r.icon} style={{ width: 18, height: 18 }} />
              {showChannelDots && (
                <span style={{
                  position: "absolute", top: 4, right: 4,
                  display: "flex", flexDirection: "column", gap: 2,
                }}>
                  {ttsJobsRunning > 0 && (
                    <span title={`${ttsJobsRunning} voice job${ttsJobsRunning !== 1 ? "s" : ""}`} style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: "var(--tts)", boxShadow: "0 0 4px var(--tts)",
                    }} />
                  )}
                  {sfxJobsRunning > 0 && (
                    <span title={`${sfxJobsRunning} sound job${sfxJobsRunning !== 1 ? "s" : ""}`} style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: "var(--sfx)", boxShadow: "0 0 4px var(--sfx)",
                    }} />
                  )}
                  {musicJobsRunning > 0 && (
                    <span title={`${musicJobsRunning} score job${musicJobsRunning !== 1 ? "s" : ""}`} style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: "var(--music)", boxShadow: "0 0 4px var(--music)",
                    }} />
                  )}
                </span>
              )}
            </button>
          );
        })}
        <div className="rail-spacer" />
        <button
          className={`rail-btn ${projectChooser ? "active" : ""}`}
          title="Switch project"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setProjectChooser({ x: rect.right, y: rect.top + rect.height / 2 });
          }}
        >
          <Icon name="folder" style={{ width: 18, height: 18 }} />
        </button>
      </div>

      {/* ── SIDEBAR ─────────────────────────────────────────────────────── */}
      <div className="sidebar">
        <div className="sidebar-head">
          <span className="eyebrow">{sidebar.eyebrow}</span>
          <span className="title">{sidebar.title}</span>
        </div>
        <div className="sidebar-body">
          {/* ── PYRAMID workspace ─────────────────────────────────── */}
          {activeWorkspace === "pyramid" && (
            <>
              <div className="side-section">Project</div>
              <div className={`side-item ${view === "pyramid" ? "active" : ""}`} onClick={() => setView("pyramid")}>
                <span className="ico"><Icon name="pyramid" style={{ width: 14, height: 14 }} /></span>
                <span>Pyramid</span>
              </div>
              <div className="side-section">Quick jump</div>
              <div className="side-item" onClick={() => setWorkspace("story")}>
                <span className="ico"><Icon name="book" style={{ width: 14, height: 14 }} /></span>
                <span>Story Bible</span>
                <span className="num">{project.revision}</span>
              </div>
              <div className="side-item" onClick={() => setWorkspace("scenes")}>
                <span className="ico" style={{ color: "var(--fg-1)" }}><Icon name="timeline" style={{ width: 14, height: 14 }} /></span>
                <span>Scenes</span>
                <span className="num">{scenes.length}</span>
              </div>
              <div className="side-item" onClick={() => setWorkspace("polish")}>
                <span className="ico" style={{ color: "var(--sfx)" }}><Icon name="sparkle" style={{ width: 14, height: 14 }} /></span>
                <span>Polish</span>
              </div>
            </>
          )}

          {/* ── STORY workspace ───────────────────────────────────── */}
          {activeWorkspace === "story" && (
            <>
              <div className="side-section">Tier I · Story</div>
              <div className={`side-item ${view === "bible" ? "active" : ""}`} onClick={() => setView("bible")}>
                <span className="ico"><Icon name="book" style={{ width: 14, height: 14 }} /></span>
                <span>Story Bible</span>
                <span className="num">{project.revision}</span>
              </div>
              <div className={`side-item ${view === "characters" ? "active" : ""}`} onClick={() => setView("characters")}>
                <span className="ico" style={{ color: "var(--tts)" }}><Icon name="person" style={{ width: 14, height: 14 }} /></span>
                <span>Cast & Voices</span>
                <span className="num">{characters.length}</span>
              </div>
              <div className={`side-item ${view === "library" ? "active" : ""}`} onClick={() => setView("library")}>
                <span className="ico" style={{ color: "var(--tts)" }}><Icon name="folder" style={{ width: 14, height: 14 }} /></span>
                <span>Character Library</span>
              </div>
              <div className="side-section">Cast · {characters.length}</div>
              {characters.map((c) => (
                <div key={c.id} className="side-item" onClick={() => setView("characters")}>
                  <span className="ico">
                    <span style={{
                      display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                      background: `oklch(0.7 0.12 ${(c.id.charCodeAt(0) * 13) % 360})`,
                      border: "1px solid var(--line-2)",
                    }} />
                  </span>
                  <span>{c.name}</span>
                </div>
              ))}
              {characters.length === 0 && (
                <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--fg-4)", fontStyle: "italic" }}>
                  No characters yet
                </div>
              )}
            </>
          )}

          {/* ── SCENES workspace ──────────────────────────────────── */}
          {activeWorkspace === "scenes" && (
            <>
              <div className="side-section">Tier II · Scenes</div>
              {scenes.length === 0 && (
                <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--fg-4)", fontStyle: "italic" }}>
                  No scenes yet
                </div>
              )}
              {scenes.map((s) => (
                <div
                  key={s.no}
                  className={`side-item ${activeSceneNo === s.no ? "active" : ""}`}
                  onClick={() => { setActiveScene(s.no); setView("composition"); }}
                >
                  <span style={{
                    display: "inline-block", width: 9, height: 9, borderRadius: "50%",
                    border: `1.5px solid ${
                      s.status === "rendered" ? "var(--st-rendered)" :
                      s.status === "gen"      ? "var(--st-gen)"      :
                      s.status === "ready"    ? "var(--st-ready)"    : "var(--st-draft)"
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
              <div className="side-section">Cast · {characters.length}</div>
              {characters.map((c) => (
                <div key={c.id} className="side-item" onClick={() => setWorkspace("story")} title="Open Cast & Voices">
                  <span className="ico">
                    <span style={{
                      display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                      background: `oklch(0.7 0.12 ${(c.id.charCodeAt(0) * 13) % 360})`,
                      border: "1px solid var(--line-2)",
                    }} />
                  </span>
                  <span>{c.name}</span>
                </div>
              ))}
            </>
          )}

          {/* ── POLISH workspace ──────────────────────────────────── */}
          {activeWorkspace === "polish" && (
            <>
              <div className="side-section">Post · Polish</div>
              <div className={`side-item ${view === "clip-studio" ? "active" : ""}`} onClick={() => setView("clip-studio")}>
                <span className="ico" style={{ color: "var(--fg-1)" }}><Icon name="fit" style={{ width: 14, height: 14 }} /></span>
                <span>Clip Studio</span>
              </div>
              <div className={`side-item ${view === "upscale" ? "active" : ""}`} onClick={() => setView("upscale")}>
                <span className="ico" style={{ color: "var(--sfx)" }}><Icon name="sparkle" style={{ width: 14, height: 14 }} /></span>
                <span>Audio Upscale</span>
              </div>
              <div className="side-section">Deliver</div>
              <div className={`side-item ${view === "final" ? "active" : ""}`} onClick={() => setView("final")}>
                <span className="ico" style={{ color: "var(--st-rendered)" }}><Icon name="download" style={{ width: 14, height: 14 }} /></span>
                <span>Final Assembly</span>
              </div>
            </>
          )}

          {/* ── APP workspace ─────────────────────────────────────── */}
          {activeWorkspace === "app" && (
            <>
              <div className="side-section">App</div>
              <div className={`side-item ${view === "settings" ? "active" : ""}`} onClick={() => setView("settings")}>
                <span className="ico"><Icon name="settings" style={{ width: 14, height: 14 }} /></span>
                <span>Settings</span>
              </div>
              <div className={`side-item ${view === "models" ? "active" : ""}`} onClick={() => setView("models")}>
                <span className="ico"><Icon name="settings" style={{ width: 14, height: 14 }} /></span>
                <span>Models</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── CANVAS ──────────────────────────────────────────────────────── */}
      <div className="canvas" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Sub-tab strip — only inside the Scenes workspace.
            Carries scene context across compose/voice/sound/score sub-views. */}
        {activeWorkspace === "scenes" && scene && (
          <div style={{
            display: "flex", alignItems: "center", gap: 0,
            borderBottom: "1px solid var(--line-1)",
            background: "var(--bg-1)",
            flexShrink: 0,
            padding: "0 12px",
          }}>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
              color: "var(--fg-4)", textTransform: "uppercase",
              padding: "8px 14px 8px 0", borderRight: "1px solid var(--line-1)",
              marginRight: 6,
            }}>
              {scene.no} · {scene.title}
            </span>
            {SCENE_SUBTABS.map((tab) => {
              const isActive = view === tab.id;
              const jobBadge = tab.id === "tts" ? ttsJobsRunning
                            : tab.id === "sfx" ? sfxJobsRunning
                            : tab.id === "music" ? musicJobsRunning
                            : 0;
              const isGenTab = tab.id !== "composition";
              // Filled active state for generation tabs (loud channel color);
              // subtle active state for the Compose tab so the timeline isn't shouty.
              const activeBg = isGenTab
                ? `color-mix(in oklch, ${tab.accent} 14%, transparent)`
                : "var(--bg-2)";
              const inactiveColor = isGenTab
                ? `color-mix(in oklch, ${tab.accent} 70%, var(--fg-3))`
                : "var(--fg-3)";
              return (
                <button
                  key={tab.id}
                  onClick={() => setView(tab.id)}
                  style={{
                    background: isActive ? activeBg : "transparent",
                    border: "none",
                    borderBottom: isActive ? `2px solid ${tab.accent}` : "2px solid transparent",
                    color: isActive ? tab.accent : inactiveColor,
                    padding: "8px 14px",
                    fontSize: 11.5,
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                    fontWeight: isActive ? 600 : 500,
                    letterSpacing: isGenTab ? "0.02em" : 0,
                    transition: "background-color 0.1s, color 0.1s",
                  }}
                >
                  {/* Channel color dot before generation tab labels — visible
                      even when the tab is inactive, so the channel identity
                      reads at a glance. */}
                  {isGenTab && (
                    <span style={{
                      width: 7, height: 7, borderRadius: "50%",
                      background: tab.accent,
                      opacity: isActive ? 1 : 0.55,
                      boxShadow: jobBadge > 0 ? `0 0 5px ${tab.accent}` : "none",
                    }} />
                  )}
                  {tab.label}
                  {jobBadge > 0 && (
                    <span style={{
                      background: tab.accent, color: "var(--bg-0)",
                      fontSize: 9, fontFamily: "var(--font-mono)", fontWeight: 600,
                      padding: "1px 5px", borderRadius: 8, lineHeight: 1.2,
                    }}>{jobBadge}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {view === "settings" && <SettingsView />}
        {view === "models"   && <ModelsView />}
        {view === "clip-studio" && <ClipStudioView />}
        {view === "upscale"  && <UpscaleView />}
        {view === "final"    && <FinalAssemblyView />}
        {view === "pyramid" && (
          <PyramidView
            project={project}
            scenes={scenes}
            cast={[]}
            activeSceneNo={activeSceneNo}
            onOpenScene={(no) => { setActiveScene(no); setView("composition"); }}
            onOpenBible={() => setView("bible")}
          />
        )}
        {view === "bible"      && <StoryBibleView />}
        {view === "characters" && <CharacterDesignerView />}
        {view === "library"    && <LibraryView />}

        {/* Scenes workspace: all 4 sub-views stay mounted at once and toggle
            via display, so flipping Compose/Voice/Sound/Score is instant
            instead of paying a fresh-mount + Tauri-IPC tax every click. */}
        {activeWorkspace === "scenes" && (
          <>
            <div style={{ display: view === "composition" ? "block" : "none", position: "absolute", inset: 0 }}>
              {scene ? (
                <CompositionView
                  scene={scene}
                  scenes={scenes}
                  tracks={[]}
                  assets={assets}
                  onSwitchScene={(no) => setActiveScene(no)}
                  onOpenPyramid={() => setView("pyramid")}
                  onUpdateScene={updateScene}
                />
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--fg-4)", fontSize: 13 }}>
                  No scenes yet — create one in the Pyramid.
                </div>
              )}
            </div>
            <div style={{ display: view === "tts" ? "block" : "none", position: "absolute", inset: 0 }}>
              <TTSPanel scenes={scenes} defaultScene={activeSceneNo} />
            </div>
            <div style={{ display: view === "sfx" ? "block" : "none", position: "absolute", inset: 0 }}>
              <SFXPanel scenes={scenes} defaultScene={activeSceneNo} />
            </div>
            <div style={{ display: view === "music" ? "block" : "none", position: "absolute", inset: 0 }}>
              <MusicPanel scenes={scenes} defaultScene={activeSceneNo} />
            </div>
          </>
        )}
        </div>
      </div>

      {/* ── RIGHT RAIL ──────────────────────────────────────────────────── */}
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
          {rightTab === "agent"  && <AgentFeed log={[]} />}
          {rightTab === "assets" && <AssetBrowser assets={assets} />}
          {rightTab === "jobs"   && <JobQueue jobs={jobs} />}
        </div>
      </div>

      {/* ── TRANSPORT ───────────────────────────────────────────────────── */}
      <div className="transport">
        <div className="tp-controls">
          <button className="tp-btn"><Icon name="skip_back" style={{ width: 14, height: 14 }} /></button>
          {/* When audio is actually playing, the button stops it. When idle,
              there's nothing to "play" without a clip selected — the per-clip
              PlayButtons elsewhere are how users initiate playback. */}
          <button
            className="tp-btn play"
            onClick={() => { if (audioPlayingPath) stopAudio(); }}
            disabled={!audioPlayingPath}
            title={audioPlayingPath ? "Stop preview" : "Nothing playing — start from a clip's play button"}
            style={!audioPlayingPath ? { opacity: 0.5, cursor: "default" } : undefined}
          >
            <Icon name={isPlaying ? "pause" : "play"} style={{ width: 12, height: 12 }} />
          </button>
          <button className="tp-btn"><Icon name="skip_fwd" style={{ width: 14, height: 14 }} /></button>
          <button className="tp-btn" style={{ color: "oklch(0.78 0.14 30)" }}>
            <Icon name="record" style={{ width: 14, height: 14 }} />
          </button>
          <span style={{ marginLeft: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>
            {formatMs(positionMs)} / {scene?.duration ?? "—"}
          </span>
        </div>
        <div className="tp-mini">
          <span className="tp-mini-label">{scene ? `${scene.no} · ${scene.title}` : "No scene"}</span>
          {scene && (
            <div className="tp-wave">
              <Wave width={500} height={24} seed={scene.no.charCodeAt(2)} count={140} color="var(--fg-2)" opacity={0.65} />
            </div>
          )}
          <span className="tp-time">{scene ? `−${scene.duration}` : ""}</span>
        </div>
        <div className="tp-meta">
          {renderMeta ? (() => {
            // Spec compliance: green if within 1 LU of target, yellow within 2,
            // red beyond. True peak: green if ≤ -1.0 dBTP, yellow ≤ 0, red above.
            const dev = Math.abs(renderMeta.integrated_lufs - renderMeta.target_lufs);
            const lufsColor = dev <= 1 ? "var(--st-rendered)" : dev <= 2 ? "var(--st-gen)" : "var(--sfx)";
            const tpColor = renderMeta.true_peak_dbtp <= -1.0 ? "var(--st-rendered)"
                          : renderMeta.true_peak_dbtp <=  0.0 ? "var(--st-gen)"
                          : "var(--sfx)";
            return (
              <>
                <div title={`Target ${renderMeta.target_lufs.toFixed(1)} LUFS · LRA ${renderMeta.loudness_range_lu.toFixed(1)} LU`}>
                  <span style={{ color: lufsColor }}>{renderMeta.integrated_lufs.toFixed(1)} LUFS</span>
                  <span style={{ color: "var(--fg-4)" }}> · </span>
                  <span style={{ color: tpColor }}>{renderMeta.true_peak_dbtp.toFixed(1)} dBTP</span>
                </div>
                <div style={{ color: "var(--fg-4)", marginTop: 2 }}>
                  48 kHz · 24-bit · stereo · target {renderMeta.target_lufs.toFixed(0)}
                </div>
              </>
            );
          })() : (
            <>
              <div style={{ color: "var(--fg-4)" }}>—  · —</div>
              <div style={{ color: "var(--fg-4)", marginTop: 2 }}>render to measure</div>
            </>
          )}
        </div>
      </div>
      <ToastHost />
      <SetupBanner />
      {projectChooser && (
        <ProjectChooser
          anchorX={projectChooser.x}
          anchorY={projectChooser.y}
          onClose={() => setProjectChooser(null)}
        />
      )}
    </div>
  );
}
