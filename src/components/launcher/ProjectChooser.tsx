import React, { useEffect, useRef, useState } from "react";
import { listProjects, listScenes, getProjectsDir } from "../../lib/tauriCommands";
import { useProjectStore } from "../../store/projectStore";
import { useUiStore } from "../../store/uiStore";
import type { Project } from "../../lib/types";

// Compact project chooser popover anchored next to the rail's folder button.
//
// Replaces the previous "switch project" gesture (which wiped state and
// dropped the user into the launcher with no warning). Now the user picks
// another project from the open list, or escapes back to their current
// session — the launcher full-screen is reachable via "open launcher…".

export interface ProjectChooserProps {
  // Pixel position to anchor the popover (viewport coords)
  anchorX: number;
  anchorY: number;
  onClose: () => void;
}

export const ProjectChooser: React.FC<ProjectChooserProps> = ({ anchorX, anchorY, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const { realProjectId, loadRealProject } = useProjectStore();
  const { setView } = useUiStore();

  useEffect(() => {
    listProjects()
      .then((ps) => setProjects(ps))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Outside-click + Esc dismiss. setTimeout(0) so the click that opened us
  // doesn't immediately close us.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const id = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handleOpen = async (project: Project) => {
    setOpeningId(project.id);
    try {
      const [scenes, dir] = await Promise.all([
        listScenes(project.id),
        getProjectsDir(),
      ]);
      loadRealProject(project, dir, scenes);
      setView("pyramid");
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setOpeningId(null);
    }
  };

  const openFullLauncher = () => {
    // Drop project state so the App-level guard renders the full launcher
    useProjectStore.setState({ realProjectId: null, scenes: [], characters: [] });
    setView("pyramid");
    onClose();
  };

  // Position: anchor to the right of the rail icon (clamped to viewport)
  const POP_W = 320;
  const POP_MAX_H = 480;
  const left = Math.min(Math.max(anchorX + 6, 8), window.innerWidth - POP_W - 8);
  const top = Math.min(Math.max(anchorY - POP_MAX_H / 2, 8), window.innerHeight - POP_MAX_H - 8);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left, top,
        width: POP_W, maxHeight: POP_MAX_H,
        background: "var(--bg-1)",
        border: "1px solid var(--line-2)",
        borderRadius: 4,
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        zIndex: 1000,
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--line-1)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            Projects
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>
            {projects.length} on disk
          </div>
        </div>
        <button
          className="btn btn-sm"
          onClick={onClose}
          style={{ padding: "1px 6px", fontSize: 12, lineHeight: 1 }}
          title="Close (Esc)"
        >×</button>
      </div>

      {/* Body */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {loading && (
          <div style={{ padding: 20, fontSize: 11, color: "var(--fg-4)", textAlign: "center" }}>
            loading…
          </div>
        )}
        {err && (
          <div style={{ padding: 14, fontSize: 11, color: "var(--sfx)", borderBottom: "1px solid var(--line-1)" }}>
            {err}
          </div>
        )}
        {!loading && projects.length === 0 && (
          <div style={{ padding: 20, fontSize: 12, color: "var(--fg-4)", textAlign: "center", lineHeight: 1.6 }}>
            No projects yet.
            <br />
            <button className="btn btn-sm" onClick={openFullLauncher} style={{ marginTop: 8 }}>
              Open launcher to create one →
            </button>
          </div>
        )}
        {projects.map((p) => {
          const isCurrent = p.id === realProjectId;
          const isOpening = openingId === p.id;
          return (
            <button
              key={p.id}
              onClick={() => !isCurrent && !isOpening && handleOpen(p)}
              disabled={isCurrent || isOpening}
              style={{
                width: "100%", textAlign: "left",
                background: isCurrent ? "color-mix(in oklch, var(--tts) 8%, var(--bg-1))" : "transparent",
                border: "none",
                borderLeft: isCurrent ? "2px solid var(--tts)" : "2px solid transparent",
                borderBottom: "1px solid var(--line-1)",
                padding: "10px 14px",
                cursor: isCurrent ? "default" : isOpening ? "wait" : "pointer",
                color: "var(--fg-1)",
                display: "block",
                opacity: isOpening ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { if (!isCurrent && !isOpening) e.currentTarget.style.background = "var(--bg-2)"; }}
              onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = isCurrent ? "color-mix(in oklch, var(--tts) 8%, var(--bg-1))" : "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.title || <em style={{ color: "var(--fg-4)" }}>untitled</em>}
                </span>
                {isCurrent && (
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.08em",
                    color: "var(--tts)", textTransform: "uppercase",
                  }}>
                    current
                  </span>
                )}
                {isOpening && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)" }}>
                    opening…
                  </span>
                )}
              </div>
              {p.logline && (
                <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 3, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.logline}
                </div>
              )}
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)", marginTop: 4, letterSpacing: "0.04em" }}>
                {p.characters?.length ?? 0} cast · updated {new Date(p.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{
        padding: "8px 14px",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        flexShrink: 0,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)" }}>
          Esc to close
        </span>
        <button className="btn btn-sm" onClick={openFullLauncher} title="Full launcher with new-project form">
          New project →
        </button>
      </div>
    </div>
  );
};
