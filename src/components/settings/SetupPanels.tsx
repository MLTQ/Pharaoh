import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CopyableCommand,
  formatBytes,
  type HardwareProfile,
  type SetupProgress,
} from "./settingsShared";

// ── Woosh one-click setup ─────────────────────────────────────────────────────

export function WooshSetupPanel({ wooshDir, hw }: { wooshDir: string; hw: HardwareProfile | null }) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [steps, setSteps] = useState<SetupProgress[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  const uvSyncCmd = hw
    ? `cd ${wooshDir || "~/Code/Woosh"} && ${
        hw.gpu === "cuda" ? "uv sync --extra cuda" :
        hw.gpu === "mps"  ? "uv sync" :
                            "uv sync --extra cpu"
      }`
    : `cd ${wooshDir || "~/Code/Woosh"} && uv sync`;

  const start = async () => {
    if (!wooshDir) return;
    setPhase("running");
    setSteps([]);

    const unlisten = await listen<SetupProgress>("woosh_setup", (e) => {
      const p = e.payload;
      setSteps((prev) => {
        const next = [...prev];
        const idx = p.step - 1;
        next[idx] = p;
        return next;
      });
      if (p.done) { setPhase("done"); unlisten(); }
      if (p.error) { setPhase("error"); unlisten(); }
    });
    unlistenRef.current = unlisten;

    invoke<void>("setup_woosh", { destDir: wooshDir }).catch((e: unknown) => {
      setPhase("error");
      setSteps((prev) => [...prev, {
        step: -1, total_steps: 7, label: String(e),
        bytes_done: 0, bytes_total: 0, done: false, error: String(e),
      }]);
    });
  };

  useEffect(() => () => { unlistenRef.current?.(); }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {phase === "idle" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            className="btn"
            disabled={!wooshDir}
            onClick={start}
            style={{ borderColor: "var(--sfx)", color: "var(--sfx)", background: "color-mix(in oklch, var(--sfx) 10%, transparent)" }}
          >
            Set up automatically
          </button>
          <span style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
            Clones repo + downloads AE, TextConditionerA, DFlow (~3.2 GB total)
          </span>
        </div>
      )}

      {(phase === "running" || phase === "done" || phase === "error") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {Array.from({ length: 7 }, (_, i) => {
            const s = steps[i];
            const isActive = s && !s.done && !s.error;
            const isDone = s?.done || (s && !s.error && steps[i + 1] !== undefined);
            const isErr = s?.error;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 11, width: 14, textAlign: "center",
                  color: isErr ? "var(--sfx)" : isDone ? "var(--st-rendered)" : isActive ? "var(--fg-1)" : "var(--fg-4)",
                }}>
                  {isErr ? "✕" : isDone ? "✓" : isActive ? "›" : "○"}
                </span>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 11, color: isErr ? "var(--sfx)" : isDone ? "var(--fg-2)" : isActive ? "var(--fg-1)" : "var(--fg-4)" }}>
                    {s?.label ?? `Step ${i + 1}`}
                  </span>
                  {isActive && s.bytes_total > 0 && (
                    <div style={{ marginTop: 3 }}>
                      <div style={{
                        height: 3, background: "var(--line-1)", borderRadius: 2, overflow: "hidden",
                      }}>
                        <div style={{
                          height: "100%",
                          width: `${Math.min(100, (s.bytes_done / s.bytes_total) * 100).toFixed(1)}%`,
                          background: "var(--sfx)", transition: "width 0.2s",
                        }} />
                      </div>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)" }}>
                        {formatBytes(s.bytes_done)} / {formatBytes(s.bytes_total)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {phase === "done" && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: "var(--st-rendered)", marginBottom: 6 }}>
            ✓ Woosh is ready. Run this once to install Python dependencies:
          </div>
          <CopyableCommand command={uvSyncCmd} />
        </div>
      )}
    </div>
  );
}

// ── Generic setup.sh profile runner ───────────────────────────────────────────

export function ServerSetupPanel({
  profile,
  wooshDir,
  buttonLabel,
  detail,
  accent,
}: {
  profile: "core" | "audioldm" | "audiosr" | "all";
  wooshDir?: string;
  buttonLabel: string;
  detail: string;
  accent: string;
}) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [lines, setLines] = useState<SetupProgress[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  const start = async () => {
    setPhase("running");
    setLines([]);

    const unlisten = await listen<SetupProgress>("inference_setup", (e) => {
      const p = e.payload;
      setLines((prev) => [...prev.slice(-7), p]);
      if (p.done) { setPhase("done"); unlisten(); }
      if (p.error) { setPhase("error"); unlisten(); }
    });
    unlistenRef.current = unlisten;

    invoke("setup_inference_servers", {
      profile,
      wooshDir: wooshDir || null,
    }).catch((e: unknown) => {
      setPhase("error");
      setLines((prev) => [...prev, {
        step: -1,
        total_steps: 2,
        label: String(e),
        bytes_done: 0,
        bytes_total: 0,
        done: false,
        error: String(e),
      }]);
    });
  };

  useEffect(() => () => { unlistenRef.current?.(); }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          className="btn"
          disabled={phase === "running"}
          onClick={start}
          style={{
            borderColor: accent,
            color: accent,
            background: `color-mix(in oklch, ${accent} 10%, transparent)`,
          }}
        >
          {phase === "running" ? "Installing..." : buttonLabel}
        </button>
        <span style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
          {detail}
        </span>
      </div>

      {lines.length > 0 && (
        <div style={{
          border: "1px solid var(--line-1)",
          background: "var(--bg-0)",
          borderRadius: 2,
          padding: "7px 9px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxHeight: 150,
          overflow: "hidden",
        }}>
          {lines.map((line, idx) => (
            <div
              key={`${line.step}-${idx}-${line.label}`}
              style={{
                display: "flex",
                gap: 7,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                lineHeight: 1.45,
                color: line.error
                  ? "var(--sfx)"
                  : line.done
                    ? "var(--st-rendered)"
                    : "var(--fg-3)",
              }}
            >
              <span style={{ flexShrink: 0 }}>
                {line.error ? "x" : line.done ? "ok" : ">"}
              </span>
              <span style={{ wordBreak: "break-word" }}>{line.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
