import React from "react";

interface RichDirectorProps {
  value: string;
  setValue: (v: string | ((prev: string) => string)) => void;
  accent: string;
}

export const RichDirector: React.FC<RichDirectorProps> = ({ value, setValue, accent: _accent }) => (
  <div>
    <textarea
      className="textarea"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      style={{ minHeight: 160, fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6 }}
    />
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
