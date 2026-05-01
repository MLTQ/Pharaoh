import React, { useState, useRef } from "react";
import { useProjectStore } from "../../store/projectStore";
import type { Character } from "../../lib/types";

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

// ── Inline editable field helpers ──────────────────────────────────────────

interface EditableTextProps {
  value: string;
  onSave: (v: string) => void;
  tag?: keyof React.JSX.IntrinsicElements;
  style?: React.CSSProperties;
  placeholder?: string;
  multiline?: boolean;
}

const EditableText: React.FC<EditableTextProps> = ({
  value, onSave, style, placeholder, multiline,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };

  if (!editing) {
    return (
      <span
        style={{
          cursor: "text",
          borderBottom: "1px dashed transparent",
          transition: "border-color 0.15s",
          ...style,
        }}
        title="Click to edit"
        onMouseEnter={(e) => ((e.target as HTMLElement).style.borderBottomColor = "var(--line-2)")}
        onMouseLeave={(e) => ((e.target as HTMLElement).style.borderBottomColor = "transparent")}
        onClick={() => { setDraft(value); setEditing(true); setTimeout(() => ref.current?.select(), 0); }}
      >
        {value || <em style={{ color: "var(--fg-4)", fontStyle: "italic" }}>{placeholder ?? "—"}</em>}
      </span>
    );
  }

  const shared: React.CSSProperties = {
    background: "var(--bg-2)", border: "1px solid var(--tts)",
    borderRadius: 2, color: "var(--fg-0)", outline: "none",
    fontFamily: "inherit", fontSize: "inherit", fontStyle: "inherit",
    fontWeight: "inherit", lineHeight: "inherit", letterSpacing: "inherit",
    padding: "1px 4px", ...style,
  };

  return multiline ? (
    <textarea
      ref={ref as React.Ref<HTMLTextAreaElement>}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Escape") { setEditing(false); setDraft(value); } }}
      style={{ ...shared, width: "100%", minHeight: 60, resize: "vertical" }}
      autoFocus
    />
  ) : (
    <input
      ref={ref as React.Ref<HTMLInputElement>}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setEditing(false); setDraft(value); }
      }}
      style={{ ...shared, width: "100%" }}
      autoFocus
    />
  );
};

// ── Character row ──────────────────────────────────────────────────────────

interface CharRowProps {
  char: Character;
  onSaveName:    (v: string) => void;
  onSaveDesc:    (v: string) => void;
  onSaveInstruct:(v: string) => void;
}

const CharRow: React.FC<CharRowProps> = ({ char, onSaveName, onSaveDesc, onSaveInstruct }) => {
  const hue   = CHAR_HUE(char.id);
  const color = `oklch(0.7 0.12 ${hue})`;
  const va    = char.voice_assignment;

  const modelLabel = va.model === "Clone"
    ? (va.ref_audio_path ? "clone ✓" : "clone — no ref")
    : va.model === "VoiceDesign" ? "voice design"
    : "custom";

  return (
    <div style={{
      padding: "14px 0",
      borderBottom: "1px solid var(--line-1)",
      display: "grid",
      gridTemplateColumns: "110px 1fr 110px",
      gap: 16,
      alignItems: "start",
    }}>
      {/* ID column */}
      <div style={{ paddingTop: 2 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontFamily: "var(--font-mono)", color: "var(--fg-3)",
          fontSize: 11, letterSpacing: "0.1em",
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: color, display: "inline-block", flexShrink: 0,
          }} />
          {char.id}
        </div>
        <div style={{
          marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 9,
          color: va.ref_audio_path ? "var(--st-rendered)" : "var(--fg-4)",
          letterSpacing: "0.05em",
        }}>
          {modelLabel}
        </div>
      </div>

      {/* Name + bio + voice direction */}
      <div>
        <div style={{ fontWeight: 500, marginBottom: 4, color: "var(--fg-0)", fontSize: 14 }}>
          <EditableText
            value={char.name}
            onSave={onSaveName}
            placeholder="Character name"
            style={{ display: "block", width: "100%" }}
          />
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 6 }}>
          <EditableText
            value={char.description}
            onSave={onSaveDesc}
            placeholder="Character bio — age, role, arc…"
            multiline
            style={{ display: "block", width: "100%" }}
          />
        </div>
        {/* Voice direction / instruct_default */}
        <div style={{
          fontSize: 11.5, color: "var(--fg-2)", fontStyle: "italic",
          paddingLeft: 10, borderLeft: `2px solid ${color}`,
        }}>
          <EditableText
            value={va.instruct_default ?? ""}
            onSave={onSaveInstruct}
            placeholder="Voice direction — delivery, timbre, cadence…"
            multiline
            style={{ fontStyle: "italic", display: "block", width: "100%" }}
          />
        </div>
      </div>

      {/* Voice model column */}
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: 10,
        color: "var(--tts)", textAlign: "right", paddingTop: 2,
        lineHeight: 1.5,
      }}>
        {va.model === "Clone" ? "Qwen3-TTS\nClone"
          : va.model === "VoiceDesign" ? "Qwen3-TTS\nVoice Design"
          : "Qwen3-TTS\nCustom"}
      </div>
    </div>
  );
};

// ── Main view ──────────────────────────────────────────────────────────────

export const StoryBibleView: React.FC = () => {
  const {
    project, characters,
    updateProjectMeta, updateCharacter, updateVoiceAssignment,
  } = useProjectStore();

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--bg-1)" }}>
      <div className="grain" />
      <div className="doc">

        {/* Header */}
        <div style={{ borderBottom: "1px solid var(--line-1)", paddingBottom: 22, marginBottom: 24 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Story Bible · {project.revision} · last sync {project.lastSync}
          </div>
          <h1 style={{ fontSize: 34, margin: "0 0 8px", fontWeight: 600, letterSpacing: "-0.015em", color: "var(--fg-0)" }}>
            <EditableText
              value={project.title}
              onSave={(v) => updateProjectMeta({ title: v })}
              placeholder="Project title"
              style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.015em" }}
            />
          </h1>
          <div style={{ color: "var(--fg-2)", fontSize: 14, fontStyle: "italic" }}>
            <EditableText
              value={project.subtitle}
              onSave={(v) => updateProjectMeta({ subtitle: v })}
              placeholder="Subtitle / episode descriptor"
              style={{ fontSize: 14, fontStyle: "italic" }}
            />
          </div>
        </div>

        {/* Logline */}
        <h2>Logline</h2>
        <p style={{ fontStyle: "italic", color: "var(--fg-0)", fontSize: 14 }}>
          "<EditableText
            value={project.logline}
            onSave={(v) => updateProjectMeta({ logline: v })}
            placeholder="One-sentence logline…"
            multiline
            style={{ fontStyle: "italic", fontSize: 14 }}
          />"
        </p>

        {/* Synopsis */}
        <h2>Synopsis</h2>
        <div style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
          <EditableText
            value={project.synopsis}
            onSave={(v) => updateProjectMeta({ synopsis: v })}
            placeholder="Write a synopsis…"
            multiline
            style={{ fontSize: 14, display: "block", width: "100%" }}
          />
        </div>

        {/* Cast */}
        <h3>Cast &amp; voice direction</h3>
        <div style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 12, fontFamily: "var(--font-mono)", letterSpacing: "0.04em" }}>
          Click any field to edit. Changes sync to Cast &amp; Voices.
        </div>
        {characters.map((char) => (
          <CharRow
            key={char.id}
            char={char}
            onSaveName={(v)     => updateCharacter(char.id, { name: v })}
            onSaveDesc={(v)     => updateCharacter(char.id, { description: v })}
            onSaveInstruct={(v) => updateVoiceAssignment(char.id, { instruct_default: v })}
          />
        ))}

      </div>
    </div>
  );
};
