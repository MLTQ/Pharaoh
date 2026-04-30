import React from "react";
import type { MockProject, MockCastMember } from "../../lib/types";

interface StoryBibleViewProps {
  project: MockProject;
  cast: MockCastMember[];
}

const VOICE_DIRECTIONS: Record<string, string> = {
  VERA:  "Burnished alto. Forensic, attentive. Understates fear.",
  ABEL:  "Lower, hoarser. Long breaths between phrases.",
  CONST: "Warm but professionally distant. Knows more than she says.",
  RADIO: "Disembodied. Counts backward in Dutch.",
  NARR:  "Patinated, third-person.",
};

export const StoryBibleView: React.FC<StoryBibleViewProps> = ({ project, cast }) => (
  <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--bg-1)" }}>
    <div className="grain" />
    <div className="doc">
      <div style={{ borderBottom: "1px solid var(--line-1)", paddingBottom: 22, marginBottom: 24 }}>
        <div className="kicker" style={{ marginBottom: 8 }}>
          Story Bible · {project.revision} · last sync {project.lastSync}
        </div>
        <h1 style={{ fontSize: 34, margin: "0 0 8px", fontWeight: 600, letterSpacing: "-0.015em", color: "var(--fg-0)" }}>
          {project.title}
        </h1>
        <div style={{ color: "var(--fg-2)", fontSize: 14, fontStyle: "italic" }}>{project.subtitle}</div>
      </div>

      <h2>Logline</h2>
      <p style={{ fontStyle: "italic", color: "var(--fg-0)", fontSize: 14 }}>"{project.logline}"</p>

      <h2>Synopsis</h2>
      <p>
        Vera Halloran has spent three winters cataloguing the disappearing dialects of the salt belt.
        When her brother Abel sends a final transmission consisting only of a hymn and a man counting
        backward in Dutch, Vera drives north toward a town called Sluis that no satellite has ever photographed.
      </p>
      <p>
        What she finds beneath the salt is older than the mine. The voice on the radio has been speaking
        for forty-one years. It knows her name.
      </p>

      <h3>Cast &amp; voice direction</h3>
      {cast.map((c) => (
        <div
          key={c.id}
          style={{
            padding: "12px 0", borderBottom: "1px solid var(--line-1)",
            display: "grid", gridTemplateColumns: "120px 1fr 100px", gap: 16, alignItems: "baseline",
          }}
        >
          <div style={{ fontFamily: "var(--font-mono)", color: "var(--fg-3)", fontSize: 11, letterSpacing: "0.1em" }}>
            {c.id}
          </div>
          <div>
            <div style={{ color: "var(--fg-0)", fontWeight: 500, marginBottom: 4 }}>{c.name}</div>
            <div style={{ fontSize: 12, color: "var(--fg-2)" }}>{VOICE_DIRECTIONS[c.id] ?? ""}</div>
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--tts)", textAlign: "right" }}>
            {c.voice}
          </div>
        </div>
      ))}
    </div>
  </div>
);
