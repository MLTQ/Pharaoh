import React from "react";
import { Label } from "./settingsShared";

export interface RvcCardProps {
  splitServers: boolean;
  urls: Record<string, string>;
  setUrls: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onRvcUrlBlur: () => void;
}

/** The RVC (voice lock) server's URL — split-servers mode only; unified mode
 *  derives it from the inference host. */
export function RvcCard({ splitServers, urls, setUrls, onRvcUrlBlur }: RvcCardProps) {
  if (!splitServers) return null;
  return (
    <UrlCard
      title="RVC" port={18006} subtitle="Voice lock (optional) · Applio v2"
      value={urls.rvc}
      onChange={(v) => setUrls((prev) => ({ ...prev, rvc: v }))}
      onBlur={onRvcUrlBlur}
    />
  );
}

/** A server card that only carries a URL field (used in split-servers mode). */
function UrlCard({ title, port, subtitle, value, onChange, onBlur }: {
  title: string;
  port: number;
  subtitle: string;
  value: string | undefined;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  return (
    <div style={{
      border: "1px solid var(--line-1)", background: "var(--bg-1)",
      borderRadius: 3, marginBottom: 14, overflow: "hidden",
    }}>
      <div style={{
        borderBottom: "1px solid var(--line-1)", padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", marginLeft: 2 }}>:{port}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{subtitle}</span>
      </div>
      <div style={{ padding: "14px 16px" }}>
        <Label>Server URL</Label>
        <input
          type="text"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          style={{
            width: "100%", fontFamily: "var(--font-mono)", fontSize: 11,
            background: "var(--bg-0)", border: "1px solid var(--line-1)",
            borderRadius: 2, padding: "5px 8px", color: "var(--fg-1)",
            boxSizing: "border-box",
          }}
        />
      </div>
    </div>
  );
}
