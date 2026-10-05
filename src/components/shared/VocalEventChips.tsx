/**
 * VocalEventChips — one-click vocal events for a line of dialogue.
 *
 * Breeze performs these 15 events rather than reading them aloud (all 15
 * were verified in the vocal-event probe). They're inserted in brackets —
 * "[laughs]" — which Breeze maps to its own "(laughs)" form, Chatterbox reads
 * as a tag, and Fountain keeps as dialogue text (a parenthesis on its own
 * line would become a parenthetical).
 */

import React from "react";

export const VOCAL_EVENTS: { tag: string; label: string; hint: string }[] = [
  { tag: "laughs", label: "laugh", hint: "A laugh" },
  { tag: "chuckles", label: "chuckle", hint: "A short, low laugh" },
  { tag: "sighs", label: "sigh", hint: "A sigh" },
  { tag: "gasps", label: "gasp", hint: "A sharp intake of breath" },
  { tag: "breath", label: "breath", hint: "An audible breath" },
  { tag: "whispers", label: "whisper", hint: "Whisper what follows" },
  { tag: "sobs", label: "sob", hint: "A sob" },
  { tag: "crying", label: "crying", hint: "Crying through the words" },
  { tag: "screams", label: "scream", hint: "A scream" },
  { tag: "groans", label: "groan", hint: "A groan" },
  { tag: "coughs", label: "cough", hint: "A cough" },
  { tag: "clears throat", label: "clear throat", hint: "Clears their throat" },
  { tag: "sniffs", label: "sniff", hint: "A sniff" },
  { tag: "yawns", label: "yawn", hint: "A yawn" },
  { tag: "hums", label: "hum", hint: "A hum" },
];

/** `text` with `[tag]` inserted at the caret (spaced from its neighbours),
 *  and where the caret goes afterwards. */
export function insertEvent(text: string, start: number, end: number, tag: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^\s/.test(after) ? " " : "";
  const ins = `${pre}[${tag}]${post}`;
  return { text: before + ins + after, caret: before.length + ins.length };
}

interface Props {
  /** The textarea the events go into (inserted at its caret). */
  target: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** Fewer chips for tight spaces. */
  compact?: boolean;
}

const COMPACT = new Set(["laughs", "chuckles", "sighs", "gasps", "whispers", "sobs"]);

export const VocalEventChips: React.FC<Props> = ({ target, value, onChange, compact }) => {
  const insert = (tag: string) => {
    const ta = target.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const next = insertEvent(value, start, end, tag);
    onChange(next.text);
    // Put the caret after the event once React has rendered the new text.
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = next.caret;
    });
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }} aria-label="Vocal events">
      {VOCAL_EVENTS.filter((e) => !compact || COMPACT.has(e.tag)).map((e) => (
        <button
          key={e.tag}
          type="button"
          // Keep focus (and the caret) in the textarea.
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => insert(e.tag)}
          title={`${e.hint} — inserts [${e.tag}]`}
          style={{
            padding: "1px 6px", fontSize: 9.5, lineHeight: 1.5,
            fontFamily: "var(--font-mono)", letterSpacing: "0.02em",
            color: "var(--fg-3)", background: "transparent",
            border: "1px dashed var(--line-2)", borderRadius: 10, cursor: "pointer",
          }}
        >
          {e.label}
        </button>
      ))}
    </div>
  );
};
