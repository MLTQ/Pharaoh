import React, { useState, useEffect } from "react";
import { Icon } from "../shared/atoms";
import type { Project } from "../../lib/types";
import { listProjects, createProject } from "../../lib/tauriCommands";

interface ProjectPickerProps {
  onOpen: (project: Project) => void;
}

type View = "list" | "create";

export const ProjectPicker: React.FC<ProjectPickerProps> = ({ onOpen }) => {
  const [view, setView] = useState<View>("list");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [title, setTitle] = useState("");
  const [logline, setLogline] = useState("");
  const [tone, setTone] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listProjects();
      setProjects(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const project = await createProject({ title: title.trim(), logline, tone });
      onOpen(project);
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  };

  const fmt = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return iso;
    }
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100vh", background: "var(--bg-0)",
    }}>
      <div style={{
        width: 560, background: "var(--bg-1)",
        border: "1px solid var(--line-1)", borderRadius: 4,
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "18px 24px", borderBottom: "1px solid var(--line-1)",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <Icon name="pyramid" style={{ width: 20, height: 20, color: "var(--fg-2)" }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>Pharaoh</div>
            <div className="kicker">AI Audio Drama Production Suite</div>
          </div>
          <div style={{ flex: 1 }} />
          {view === "list" && (
            <button className="btn btn-primary" onClick={() => setView("create")}>
              <Icon name="plus" style={{ width: 13, height: 13 }} /> New project
            </button>
          )}
          {view === "create" && (
            <button className="btn" onClick={() => setView("list")}>Cancel</button>
          )}
        </div>

        {/* Content */}
        {view === "list" && (
          <div style={{ padding: "12px 0", minHeight: 240 }}>
            {loading && (
              <div style={{ padding: "32px 24px", textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
                Loading projects…
              </div>
            )}
            {!loading && projects.length === 0 && (
              <div style={{ padding: "40px 24px", textAlign: "center" }}>
                <div style={{ color: "var(--fg-2)", fontSize: 13, marginBottom: 8 }}>No projects yet</div>
                <div style={{ color: "var(--fg-4)", fontSize: 11 }}>Create a project to get started.</div>
              </div>
            )}
            {!loading && projects.map((p) => (
              <div
                key={p.id}
                onClick={() => onOpen(p)}
                style={{
                  padding: "12px 24px", cursor: "pointer",
                  borderBottom: "1px solid var(--line-1)",
                  display: "flex", flexDirection: "column", gap: 3,
                  transition: "background 120ms",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "")}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{p.title}</span>
                  <span style={{ fontSize: 10, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
                    {fmt(p.updated_at)}
                  </span>
                </div>
                {p.logline && (
                  <span style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.4 }}>
                    {p.logline}
                  </span>
                )}
              </div>
            ))}
            {error && (
              <div style={{ padding: "12px 24px", color: "var(--sfx)", fontSize: 11 }}>{error}</div>
            )}
          </div>
        )}

        {view === "create" && (
          <form onSubmit={handleCreate} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <div className="field-label"><span>Title</span></div>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="The Reach"
                autoFocus
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <div className="field-label"><span>Logline</span><span className="hint">one sentence</span></div>
              <textarea
                className="textarea"
                value={logline}
                onChange={(e) => setLogline(e.target.value)}
                placeholder="After her brother's disappearance…"
                style={{ minHeight: 60 }}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <div className="field-label"><span>Tone</span><span className="hint">e.g. folk horror, dry comedy</span></div>
              <input
                className="input"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                placeholder="Mystery / Folk Horror"
              />
            </div>
            {error && <div style={{ color: "var(--sfx)", fontSize: 11 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
              <button type="button" className="btn" onClick={() => setView("list")}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!title.trim() || creating}>
                {creating ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
