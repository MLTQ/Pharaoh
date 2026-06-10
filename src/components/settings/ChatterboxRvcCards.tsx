import React from "react";
import { Label } from "./settingsShared";

export type ChatterboxHealth = "unknown" | "online" | "offline";

export interface ChatterboxRvcCardsProps {
  splitServers: boolean;
  urls: Record<string, string>;
  setUrls: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  effectiveUrl: (key: string) => string;
  chatterboxHealth: ChatterboxHealth;
  onCheckChatterboxHealth: () => void;
  onChatterboxUrlBlur: () => void;
  onRvcUrlBlur: () => void;
}

export function ChatterboxRvcCards({
  splitServers,
  urls,
  setUrls,
  effectiveUrl,
  chatterboxHealth,
  onCheckChatterboxHealth,
  onChatterboxUrlBlur,
  onRvcUrlBlur,
}: ChatterboxRvcCardsProps) {
  return (
    <>
      {/* ── Chatterbox Turbo card ──────────────────────────────────────── */}
      <div style={{
        border: "1px solid var(--line-1)", background: "var(--bg-1)",
        borderRadius: 3, marginBottom: 14, overflow: "hidden",
      }}>
        <div style={{
          borderBottom: "1px solid var(--line-1)", padding: "12px 16px",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: chatterboxHealth === "online" ? "#22c55e" : chatterboxHealth === "offline" ? "#ef4444" : "var(--fg-4)",
            boxShadow: chatterboxHealth === "online" ? "0 0 5px #22c55e" : "none",
            flexShrink: 0,
          }} />
          <span style={{ fontWeight: 600, fontSize: 13 }}>Chatterbox Turbo</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", marginLeft: 2 }}>:18005</span>
          <span style={{ flex: 1 }} />
          {!splitServers && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", marginRight: 8 }}>
              {effectiveUrl("chatterbox")}
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--fg-3)" }}>0-shot voice cloning + paralinguistic tags · 0.5B</span>
        </div>
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {splitServers ? (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <Label>Server URL</Label>
                <input
                  type="text"
                  value={urls.chatterbox}
                  onChange={(e) => setUrls((prev) => ({ ...prev, chatterbox: e.target.value }))}
                  onBlur={onChatterboxUrlBlur}
                  style={{
                    width: "100%", fontFamily: "var(--font-mono)", fontSize: 11,
                    background: "var(--bg-0)", border: "1px solid var(--line-1)",
                    borderRadius: 2, padding: "5px 8px", color: "var(--fg-1)",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                <Label>Health</Label>
                <button
                  onClick={onCheckChatterboxHealth}
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: 10,
                    padding: "4px 10px", background: "var(--bg-0)",
                    border: "1px solid var(--line-1)", borderRadius: 2,
                    color: chatterboxHealth === "online" ? "#22c55e" : chatterboxHealth === "offline" ? "#ef4444" : "var(--fg-4)",
                    cursor: "pointer",
                  }}
                >
                  {chatterboxHealth}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                background: chatterboxHealth === "online" ? "#22c55e" : chatterboxHealth === "offline" ? "#ef4444" : "var(--fg-4)",
              }} />
              <button
                onClick={onCheckChatterboxHealth}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: 10.5,
                  background: "none", border: "none", cursor: "pointer", padding: 0,
                  color: chatterboxHealth === "online" ? "#22c55e" : chatterboxHealth === "offline" ? "#ef4444" : "var(--fg-4)",
                }}
              >
                {chatterboxHealth} — click to ping
              </button>
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6 }}>
            Start with:{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 10, background: "var(--bg-0)", padding: "1px 4px", borderRadius: 2 }}>
              PHARAOH_INSTALL_CHATTERBOX=1 ./inference/setup.sh
            </code>
            {" "}then{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 10, background: "var(--bg-0)", padding: "1px 4px", borderRadius: 2 }}>
              inference/.venv-chatterbox/bin/python inference/chatterbox_server.py
            </code>
            . Model weights download from HuggingFace on first /load call.
          </div>
        </div>
      </div>

      {/* ── RVC card ──────────────────────────────────────────────────── */}
      {splitServers && (
        <div style={{
          border: "1px solid var(--line-1)", background: "var(--bg-1)",
          borderRadius: 3, marginBottom: 14, overflow: "hidden",
        }}>
          <div style={{
            borderBottom: "1px solid var(--line-1)", padding: "12px 16px",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>RVC</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", marginLeft: 2 }}>:18006</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--fg-3)" }}>Voice conversion · Applio v2</span>
          </div>
          <div style={{ padding: "14px 16px" }}>
            <Label>Server URL</Label>
            <input
              type="text"
              value={urls.rvc}
              onChange={(e) => setUrls((prev) => ({ ...prev, rvc: e.target.value }))}
              onBlur={onRvcUrlBlur}
              style={{
                width: "100%", fontFamily: "var(--font-mono)", fontSize: 11,
                background: "var(--bg-0)", border: "1px solid var(--line-1)",
                borderRadius: 2, padding: "5px 8px", color: "var(--fg-1)",
                boxSizing: "border-box",
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
