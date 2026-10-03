/**
 * RecordingClips.tsx
 *
 * "From the recording" inside a palette emotion: the character's own clips
 * from the dissected source whose delivery matches the emotion (emotion2vec
 * tags), best first. Play one, then "Use" makes it the emotion's reference —
 * Chatterbox copies a reference's delivery as much as its voice, so a real
 * angry moment gives angry lines.
 *
 * Shown only for characters with Dissect provenance. An import tagged before
 * emotion tagging existed offers "Read emotions" (a queue job) first.
 */

import React, { useEffect, useState } from "react";
import { dissectClip, dissectEmotionClips } from "../../lib/tauriCommands";
import type { EmotionClip, EmotionClips } from "../../lib/tauriCommands";
import { useAudioStore } from "../../store/audioStore";
import { useDissectStore } from "../../store/dissectStore";
import type { Character } from "../../lib/types";
import { labelStyle } from "./libraryShared";

const fmt = (s: number) => `${Math.floor(s / 3600) > 0 ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const RecordingClips: React.FC<{
  character: Character;
  emotion: string;
  disabled?: boolean;
  onUse: (importId: string, clip: EmotionClip) => Promise<void>;
}> = ({ character, emotion, disabled, onUse }) => {
  // One source per import; a character can merge several speakers of it.
  const sources = Object.values(
    (character.voice_provenance ?? [])
      .filter((p) => p.kind === "dissect" && p.import_id && p.speaker_id)
      .reduce<Record<string, { importId: string; name: string; speakers: string[] }>>((acc, p) => {
        const s = (acc[p.import_id] ??= { importId: p.import_id, name: p.source_name, speakers: [] });
        if (!s.speakers.includes(p.speaker_id)) s.speakers.push(p.speaker_id);
        return acc;
      }, {}),
  );
  const tagging = useDissectStore((s) => s.tagging);
  const ready = useDissectStore((s) => s.emotionsReady);
  const tagEmotions = useDissectStore((s) => s.tagEmotions);
  const [results, setResults] = useState<Record<string, EmotionClips | string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const play = useAudioStore((s) => s.play);
  const key = sources.map((s) => `${s.importId}:${s.speakers.join(",")}:${ready[s.importId] ?? 0}`).join("|");

  useEffect(() => {
    let live = true;
    for (const s of sources) {
      dissectEmotionClips(s.importId, s.speakers, emotion, 6)
        .then((r) => { if (live) setResults((m) => ({ ...m, [s.importId]: r })); })
        .catch((e) => { if (live) setResults((m) => ({ ...m, [s.importId]: String(e) })); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, emotion]);

  if (sources.length === 0) return null;

  const audition = async (importId: string, c: EmotionClip) => {
    const id = `${importId}:${c.start}`;
    setBusy(id);
    try {
      await play(await dissectClip(importId, "dialogue", c.start, c.end));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>From the recording</label>
      {sources.map((s) => {
        const r = results[s.importId];
        const status = tagging[s.importId];
        return (
          <div key={s.importId} style={{ marginBottom: 6 }}>
            {typeof r === "string" && <div style={{ fontSize: 11, color: "var(--sfx)" }}>{r}</div>}
            {r && typeof r !== "string" && !r.tagged && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-3)" }}>
                <span style={{ flex: 1 }}>
                  {status ? `Reading emotions in ${s.name} — ${status}` : `${s.name} hasn't had its emotions read yet.`}
                </span>
                {!status && (
                  <button className="btn btn-sm" onClick={() => void tagEmotions(s.importId, s.name)}
                          title="Tag every line of dialogue in this recording with an emotion (runs on the dissect server; a few minutes for a whole audiobook)">
                    Read emotions
                  </button>
                )}
              </div>
            )}
            {r && typeof r !== "string" && r.tagged && !r.class && (
              <div style={{ fontSize: 11, color: "var(--fg-4)" }}>
                The emotion reader has no "{emotion}" class (it knows angry, disgusted, fearful, happy, neutral, sad,
                surprised) — generate or upload this one.
              </div>
            )}
            {r && typeof r !== "string" && r.tagged && r.class && r.clips.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--fg-4)" }}>No clean {r.class} lines from this character in {s.name}.</div>
            )}
            {r && typeof r !== "string" && r.tagged && r.clips.map((c) => {
              const id = `${s.importId}:${c.start}`;
              const clear = c.top === r.class;
              return (
                <div key={id} style={{
                  display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 8, alignItems: "center",
                  padding: "4px 6px", borderBottom: "1px solid var(--line-1)", fontSize: 11,
                }}>
                  <button className="btn btn-sm" onClick={() => void audition(s.importId, c)} disabled={busy === id}
                          style={{ padding: "1px 7px" }} title="Play this clip">{busy === id ? "…" : "▶"}</button>
                  <span style={{ color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={c.text}>
                    {c.text || <em style={{ color: "var(--fg-4)" }}>(part of a longer line)</em>}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: clear ? "var(--st-rendered)" : "var(--fg-4)" }}
                        title={clear ? `Read as ${r.class}` : `Mostly ${c.top}; ${r.class} is secondary`}>
                    {Math.round(c.score * 100)}% {r.class}{clear ? "" : ` · ${c.top}`} · {fmt(c.start)} · {(c.end - c.start).toFixed(1)}s
                  </span>
                  <button className="btn btn-sm" disabled={disabled || busy != null}
                          onClick={async () => { setBusy(id); try { await onUse(s.importId, c); } finally { setBusy(null); } }}
                          title="Make this clip the reference for this emotion">Use</button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
