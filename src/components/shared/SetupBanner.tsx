import React, { useEffect, useState } from "react";
import { checkSetup, type SetupReport } from "../../lib/tauriCommands";

// Persistent banner that surfaces missing required tools at startup.
// Renders only when something is actually wrong — silent in the happy path.
//
// Hidden behind a localStorage dismiss key per-tool so a user who's chosen
// to skip an optional tool (sox) doesn't keep seeing the warning. Required
// tools (ffmpeg) can't be dismissed: without them most flows hard-fail.

const DISMISS_KEY = "pharaoh-setup-banner-dismissed";

function loadDismissals(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}");
  } catch { return {}; }
}
function saveDismissals(next: Record<string, boolean>) {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch {}
}

interface ProblemRow {
  key: "ffmpeg" | "sox";
  name: string;
  required: boolean;
  hint: string;
}

export const SetupBanner: React.FC = () => {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [dismissals, setDismissals] = useState<Record<string, boolean>>(loadDismissals);

  useEffect(() => {
    checkSetup()
      .then((r) => setReport(r))
      .catch(() => {
        // In browser preview / non-Tauri contexts checkSetup throws — just
        // hide the banner. Real Tauri always succeeds.
        setReport(null);
      });
  }, []);

  if (!report) return null;

  const problems: ProblemRow[] = [];
  if (!report.ffmpeg.ok) {
    problems.push({ key: "ffmpeg", name: "ffmpeg", required: true, hint: report.ffmpeg.hint });
  }
  if (!report.sox.ok && !dismissals.sox) {
    problems.push({ key: "sox", name: "sox", required: false, hint: report.sox.hint });
  }
  if (problems.length === 0) return null;

  return (
    <div style={{
      position: "fixed",
      bottom: 80, // sits just above the transport
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 800,
      maxWidth: 640,
      width: "calc(100% - 80px)",
      background: "var(--bg-1)",
      border: "1px solid var(--sfx)",
      borderLeft: "3px solid var(--sfx)",
      borderRadius: 4,
      padding: "10px 14px",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
      }}>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em",
          color: "var(--sfx)", textTransform: "uppercase",
        }}>
          Setup
        </span>
        <span style={{ fontSize: 12, color: "var(--fg-1)" }}>
          {problems.some((p) => p.required)
            ? `Missing required tool${problems.filter((p) => p.required).length > 1 ? "s" : ""} — render and generation will fail until installed.`
            : "Optional tools missing — most flows still work."
          }
        </span>
      </div>
      {problems.map((p) => (
        <div key={p.key} style={{
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 11,
          color: "var(--fg-2)",
          padding: "4px 0",
          borderTop: "1px solid var(--line-1)",
        }}>
          <span style={{
            fontFamily: "var(--font-mono)",
            color: p.required ? "var(--sfx)" : "var(--st-gen)",
            minWidth: 60,
            fontWeight: 600,
          }}>
            {p.name}
          </span>
          <code style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--fg-1)",
            background: "var(--bg-2)",
            padding: "1px 6px",
            borderRadius: 2,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }} title={p.hint}>
            {p.hint}
          </code>
          {!p.required && (
            <button
              className="btn btn-sm"
              onClick={() => {
                const next = { ...dismissals, [p.key]: true };
                setDismissals(next);
                saveDismissals(next);
              }}
              style={{ padding: "1px 6px", fontSize: 9 }}
              title="Hide until next install change"
            >
              dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
