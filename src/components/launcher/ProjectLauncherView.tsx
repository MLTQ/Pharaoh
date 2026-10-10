import React, { useState, useEffect } from "react";
import { listProjects, createProject, getProjectsDir, listScenes, listSeries } from "../../lib/tauriCommands";
import { RebuildWizard } from "./RebuildWizard";
import { SeriesColumn } from "./SeriesColumn";
import { useProjectStore } from "../../store/projectStore";
import { useUiStore } from "../../store/uiStore";
import type { Project, Series } from "../../lib/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7)  return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── New project form ──────────────────────────────────────────────────────────

const NewProjectForm: React.FC<{ onCreated: (p: Project) => void; onCancel: () => void }> = ({ onCreated, onCancel }) => {
  const [title, setTitle]     = useState("");
  const [logline, setLogline] = useState("");
  const [tone, setTone]       = useState("");
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  const handleCreate = async () => {
    if (!title.trim()) { setErr("Title is required."); return; }
    setBusy(true); setErr(null);
    try {
      const project = await createProject({ title: title.trim(), logline, tone });
      onCreated(project);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      padding: "24px", borderRadius: 4,
      border: "1px solid var(--tts)",
      background: "color-mix(in oklch, var(--tts) 5%, var(--bg-2))",
      marginBottom: 20,
    }}>
      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-0)", marginBottom: 16 }}>
        New project
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Title *</label>
        <input
          className="input"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") onCancel(); }}
          placeholder="The Salt Path"
          style={{ width: "100%", fontSize: 14 }}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Logline</label>
        <input
          className="input"
          value={logline}
          onChange={(e) => setLogline(e.target.value)}
          placeholder="A one-sentence story premise…"
          style={{ width: "100%", fontSize: 12 }}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Tone / genre</label>
        <input
          className="input"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          placeholder="e.g. Mystery / Folk Horror"
          style={{ width: "100%", fontSize: 12 }}
        />
      </div>

      {err && <div style={{ fontSize: 11, color: "var(--sfx)", marginBottom: 10 }}>{err}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={busy}
          style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-0)" }}
        >
          {busy ? "Creating…" : "Create project"}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
};

// ── Project card ──────────────────────────────────────────────────────────────

const ProjectCard: React.FC<{
  project: Project;
  onOpen: (p: Project) => void;
  loading: boolean;
}> = ({ project, onOpen, loading }) => (
  <div
    onClick={() => !loading && onOpen(project)}
    style={{
      padding: "16px 20px", marginBottom: 10,
      border: "1px solid var(--line-1)", borderRadius: 3,
      background: "var(--bg-2)",
      cursor: loading ? "wait" : "pointer",
      transition: "border-color 0.1s, background 0.1s",
    }}
    onMouseEnter={(e) => {
      (e.currentTarget as HTMLElement).style.borderColor = "var(--tts)";
      (e.currentTarget as HTMLElement).style.background = "color-mix(in oklch, var(--tts) 4%, var(--bg-2))";
    }}
    onMouseLeave={(e) => {
      (e.currentTarget as HTMLElement).style.borderColor = "var(--line-1)";
      (e.currentTarget as HTMLElement).style.background = "var(--bg-2)";
    }}
  >
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
      <span style={{ fontWeight: 600, fontSize: 15, color: "var(--fg-0)" }}>{project.title}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)", letterSpacing: "0.05em" }}>
        {relativeDate(project.updated_at)}
      </span>
    </div>
    {project.logline && (
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
        {project.logline.slice(0, 140)}
        {project.logline.length > 140 ? "…" : ""}
      </div>
    )}
    {(project.tone || project.characters.length > 0) && (
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {project.tone && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.04em",
            color: "var(--tts)", background: "color-mix(in oklch, var(--tts) 10%, transparent)",
            padding: "1px 6px", borderRadius: 2,
          }}>{project.tone}</span>
        )}
        {project.characters.length > 0 && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.04em",
            color: "var(--fg-4)",
          }}>{project.characters.length} character{project.characters.length !== 1 ? "s" : ""}</span>
        )}
      </div>
    )}
  </div>
);

// ── Main view ─────────────────────────────────────────────────────────────────

export const ProjectLauncherView: React.FC<{ onOpenSettings?: () => void }> = ({ onOpenSettings }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [series, setSeries]     = useState<Series[]>([]);
  const [projectsDir, setProjectsDir] = useState("");
  const [loading, setLoading]   = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [showNew, setShowNew]   = useState(false);
  const [showRebuild, setShowRebuild] = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  const { loadRealProject } = useProjectStore();
  const { setView }          = useUiStore();

  useEffect(() => {
    // Series failing (e.g. an older mesh host) must not hide the one-shots.
    Promise.all([listProjects(), getProjectsDir(), listSeries().catch(() => [] as Series[])])
      .then(([ps, dir, ss]) => { setProjects(ps); setProjectsDir(dir); setSeries(ss); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleOpen = async (project: Project) => {
    setOpeningId(project.id);
    try {
      const [scenes, dir] = await Promise.all([
        listScenes(project.id),
        getProjectsDir(),
      ]);
      loadRealProject(project, dir, scenes);
      setView("pyramid");
    } catch (e) {
      setErr(String(e));
    } finally {
      setOpeningId(null);
    }
  };

  // Episodes live under their series; this column is one-shots only.
  const oneShots = projects.filter((p) => !p.series_id);

  const handleCreated = async (project: Project) => {
    const dir = await getProjectsDir().catch(() => "");
    loadRealProject(project, dir, []);
    setView("pyramid");
  };

  return (
    <div style={{
      position: "absolute", inset: 0, overflow: "auto",
      background: "var(--bg-0)", display: "flex", flexDirection: "column",
      alignItems: "center",
    }}>
      {/* margin:auto centres vertically without clipping the top when tall */}
      <div style={{ width: "100%", maxWidth: 1180, padding: "32px 24px", margin: "auto 0" }}>

        {/* Logo / wordmark */}
        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.2em",
            color: "var(--tts)", textTransform: "uppercase", marginBottom: 6,
          }}>
            PHARAOH
          </div>
          <div style={{ fontWeight: 600, fontSize: 28, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>
            Audio Drama Suite
          </div>
          {projectsDir && (
            <div style={{
              marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 9.5,
              color: "var(--fg-4)", letterSpacing: "0.04em",
            }}>
              {projectsDir}
            </div>
          )}
        </div>

        {/* Error */}
        {err && (
          <div style={{
            padding: "10px 14px", marginBottom: 16,
            background: "color-mix(in oklch, var(--sfx) 10%, var(--bg-2))",
            border: "1px solid var(--sfx)", borderRadius: 3,
            fontSize: 11, color: "var(--sfx)",
          }}>
            {err}
          </div>
        )}

        <div style={{
          display: "grid", gap: 32, alignItems: "start",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
        }}>
        <SeriesColumn series={series} projects={projects} loading={loading} />

        <div>
        {/* New project form */}
        {showNew && (
          <NewProjectForm
            onCreated={handleCreated}
            onCancel={() => setShowNew(false)}
          />
        )}

        {/* Project list header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 12, minHeight: 28, flexWrap: "wrap", gap: 8,
        }}>
          <span style={{ whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            {loading ? "Loading…" : `One-shots · ${oneShots.length}`}
          </span>
          {!showNew && (
            <span style={{ display: "flex", gap: 8 }}>
              <button
                className="btn"
                onClick={() => setShowRebuild(true)}
                title="Turn a finished audio drama back into a project: scenes, script, characters, voices, sounds"
                style={{ fontSize: 12 }}
              >
                ⤓ Rebuild from a recording
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setShowNew(true)}
                style={{
                  background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-0)",
                  fontSize: 12,
                }}
              >
                + New project
              </button>
            </span>
          )}
        </div>

        {/* Project cards */}
        {!loading && oneShots.length === 0 && !showNew && (
          <div style={{
            padding: "40px 24px", textAlign: "center",
            border: "1px dashed var(--line-2)", borderRadius: 3,
            fontSize: 12, color: "var(--fg-4)", lineHeight: 1.7,
          }}>
            No one-shots yet.
            <br />
            <button
              className="btn"
              onClick={() => setShowNew(true)}
              style={{ marginTop: 12 }}
            >
              Create your first project →
            </button>
            <br />
            <button className="btn btn-sm" onClick={() => setShowRebuild(true)} style={{ marginTop: 8 }}>
              …or rebuild one from an existing recording
            </button>
          </div>
        )}

        {oneShots.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onOpen={handleOpen}
            loading={openingId === p.id}
          />
        ))}
        </div>
        </div>

        {showRebuild && <RebuildWizard onClose={() => setShowRebuild(false)} />}

        {/* Settings link */}
        <div style={{ marginTop: 24, textAlign: "center" }}>
          <button
            className="btn btn-sm"
            onClick={onOpenSettings ?? (() => setView("settings"))}
            style={{ fontSize: 10.5, color: "var(--fg-4)" }}
          >
            ⚙ Settings
          </button>
        </div>

      </div>
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
