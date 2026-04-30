import React from "react";

interface Preset {
  label: string;
  insert: string;
}

interface RichDirectorProps {
  tags: string[];
  setTags: (tags: string[]) => void;
  value: string;
  setValue: (v: string | ((prev: string) => string)) => void;
  accent: string;
  allTags: string[];
  presets: Preset[];
}

export const RichDirector: React.FC<RichDirectorProps> = ({
  tags, setTags, value, setValue, accent, allTags, presets,
}) => (
  <div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      {allTags.map((t) => {
        const on = tags.includes(t);
        return (
          <button
            key={t}
            onClick={() => setTags(on ? tags.filter((x) => x !== t) : [...tags, t])}
            style={{
              padding: "4px 10px",
              border: `1px solid ${on ? accent : "var(--line-2)"}`,
              background: on ? `color-mix(in oklch, ${accent} 14%, transparent)` : "var(--bg-2)",
              color: on ? "var(--fg-0)" : "var(--fg-2)",
              borderRadius: 1,
              fontFamily: "var(--font-mono)", fontSize: 10,
              letterSpacing: "0.05em", cursor: "pointer",
            }}
          >
            {t}
          </button>
        );
      })}
    </div>
    <textarea
      className="textarea"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      style={{ minHeight: 160, fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6 }}
    />
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
      {presets.map((p) => (
        <button
          key={p.label}
          onClick={() => setValue((v) => v + p.insert)}
          className="btn btn-sm"
          style={{ borderColor: accent, color: accent }}
        >
          + {p.label}
        </button>
      ))}
    </div>
  </div>
);

// ── Scene router ─────────────────────────────────────────────────────────────

import { Icon } from "../shared/atoms";
import type { MockScene } from "../../lib/types";

interface SceneRouterProps {
  scenes: MockScene[];
  scene: string;
  setScene: (no: string) => void;
  accent: string;
  onSend: () => void;
}

export const SceneRouter: React.FC<SceneRouterProps> = ({ scenes, scene, setScene, accent, onSend }) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
    border: `1px solid ${accent}`,
    background: `color-mix(in oklch, ${accent} 8%, var(--bg-2))`,
    borderRadius: 2,
  }}>
    <span className="kicker" style={{ color: accent }}>ROUTE TO</span>
    <select
      className="select"
      style={{ flex: 1, background: "var(--bg-0)" }}
      value={scene}
      onChange={(e) => setScene(e.target.value)}
    >
      {scenes.map((s) => (
        <option key={s.no} value={s.no}>{s.no} · {s.title}</option>
      ))}
    </select>
    <button className="btn btn-primary" onClick={onSend}>
      <Icon name="download" style={{ width: 14, height: 14 }} /> Send to scene
    </button>
  </div>
);
