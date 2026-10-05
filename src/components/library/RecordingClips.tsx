/**
 * RecordingClips.tsx
 *
 * "From the recording" inside a palette emotion: the character's own clips
 * from the dissected source, ranked by the emotion's *recipe* — a blend of
 * emotion2vec's seven classes plus delivery targets (pace, loudness, pitch,
 * movement, breathiness) relative to the character's own average. Play one,
 * "Use" makes it the emotion's reference (a clone copies a reference's
 * delivery as much as its voice), "≈" finds the clips that sound most like
 * it — for moods no recipe names.
 *
 * Shown only for characters with Dissect provenance. An import tagged before
 * emotion tagging existed offers "Read emotions" (a queue job) first; one
 * tagged before delivery features existed offers a re-read.
 */

import React, { useEffect, useState } from "react";
import { dissectClip, dissectEmotionClips, dissectSimilarClips } from "../../lib/tauriCommands";
import type { EmotionClip, EmotionClips } from "../../lib/tauriCommands";
import { useAudioStore } from "../../store/audioStore";
import { useDissectStore } from "../../store/dissectStore";
import type { Character, EmotionRecipe } from "../../lib/types";
import { labelStyle } from "./libraryShared";

const CLASSES = ["angry", "disgusted", "fearful", "happy", "neutral", "sad", "surprised"] as const;
const DELIVERY: { key: keyof Omit<EmotionRecipe, "classes">; lo: string; hi: string }[] = [
  { key: "loud", lo: "softer", hi: "louder" },
  { key: "pace", lo: "slower", hi: "faster" },
  { key: "pitch", lo: "lower", hi: "higher" },
  { key: "movement", lo: "flatter", hi: "more animated" },
  { key: "breathy", lo: "clearer", hi: "breathier" },
];
const EMPTY: EmotionRecipe = { classes: {}, loud: 0, pace: 0, pitch: 0, movement: 0, breathy: 0 };

const fmt = (s: number) => `${Math.floor(s / 3600) > 0 ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

type Source = { importId: string; name: string; speakers: string[] };

export const RecordingClips: React.FC<{
  character: Character;
  emotion: string;
  /** The entry's own recipe; undefined = the built-in recipe for its name. */
  recipe?: EmotionRecipe;
  onRecipeChange: (recipe: EmotionRecipe | undefined) => void;
  disabled?: boolean;
  onUse: (importId: string, clip: EmotionClip) => Promise<void>;
}> = ({ character, emotion, recipe, onRecipeChange, disabled, onUse }) => {
  // One source per import; a character can merge several speakers of it.
  const sources: Source[] = Object.values(
    (character.voice_provenance ?? [])
      .filter((p) => p.kind === "dissect" && p.import_id && p.speaker_id)
      .reduce<Record<string, Source>>((acc, p) => {
        const s = (acc[p.import_id] ??= { importId: p.import_id, name: p.source_name, speakers: [] });
        if (!s.speakers.includes(p.speaker_id)) s.speakers.push(p.speaker_id);
        return acc;
      }, {}),
  );
  const tagging = useDissectStore((s) => s.tagging);
  const ready = useDissectStore((s) => s.emotionsReady);
  const tagEmotions = useDissectStore((s) => s.tagEmotions);
  const [results, setResults] = useState<Record<string, EmotionClips | string>>({});
  const [like, setLike] = useState<{ source: Source; seed: EmotionClip; clips: EmotionClip[] | string | null } | null>(null);
  const [showRecipe, setShowRecipe] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const play = useAudioStore((s) => s.play);
  const recipeKey = JSON.stringify(recipe ?? null);
  const key = sources.map((s) => `${s.importId}:${s.speakers.join(",")}:${ready[s.importId] ?? 0}`).join("|");

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      for (const s of sources) {
        dissectEmotionClips(s.importId, s.speakers, emotion, recipe ?? null, 6)
          .then((r) => { if (live) setResults((m) => ({ ...m, [s.importId]: r })); })
          .catch((e) => { if (live) setResults((m) => ({ ...m, [s.importId]: String(e) })); });
      }
    }, 200); // slider drags re-rank without flooding
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, emotion, recipeKey]);

  if (sources.length === 0) return null;

  const first = Object.values(results).find((r): r is EmotionClips => typeof r !== "string");
  // What the editor shows: the entry's recipe, else the built-in one the server used.
  const effective: EmotionRecipe = recipe ?? first?.recipe ?? EMPTY;
  const edit = (patch: Partial<EmotionRecipe>) => onRecipeChange({ ...effective, ...patch });
  const setClass = (c: string, w: number) => {
    const classes = { ...effective.classes };
    if (Math.abs(w) < 0.05) delete classes[c]; else classes[c] = Math.round(w * 100) / 100;
    edit({ classes });
  };

  const audition = async (importId: string, c: EmotionClip) => {
    const id = `${importId}:${c.start}`;
    setBusy(id);
    try {
      await play(await dissectClip(importId, "dialogue", c.start, c.end));
    } finally {
      setBusy(null);
    }
  };

  const moreLike = (source: Source, seed: EmotionClip) => {
    setLike({ source, seed, clips: null });
    dissectSimilarClips(source.importId, source.speakers, seed.start, 6)
      .then((clips) => setLike((l) => (l && l.seed === seed ? { ...l, clips } : l)))
      .catch((e) => setLike((l) => (l && l.seed === seed ? { ...l, clips: String(e) } : l)));
  };

  const row = (s: Source, c: EmotionClip, similar: boolean) => {
    const id = `${s.importId}:${c.start}`;
    return (
      <div key={id} style={{
        display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto auto auto", gap: 6, alignItems: "center",
        padding: "4px 6px", borderBottom: "1px solid var(--line-1)", fontSize: 11,
      }}>
        <button className="btn btn-sm" onClick={() => void audition(s.importId, c)} disabled={busy === id}
                style={{ padding: "1px 7px" }} title="Play this clip">{busy === id ? "…" : "▶"}</button>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={c.text}>
            {c.text || <em style={{ color: "var(--fg-4)" }}>(part of a longer line)</em>}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)" }}>
            {c.strong && !similar && <span title="A clear example of this emotion" style={{ color: "var(--st-rendered)" }}>● </span>}
            {c.clarity < 0.3 ? <span title="The emotion reader couldn't place this line's tone">unclear tone</span> : <>{Math.round(c.top_score * 100)}% {c.top}</>}
            {c.traits.length > 0 && <> · <span style={{ color: "var(--fg-3)" }}>{c.traits.join(", ")}</span></>}
            {" · "}{fmt(c.start)} · {(c.end - c.start).toFixed(1)}s
            {similar && <> · {Math.round(c.fit * 100)}% alike</>}
          </span>
        </span>
        <span />
        <button className="btn btn-sm" onClick={() => moreLike(s, c)} disabled={busy != null}
                style={{ padding: "1px 7px" }} title="Find this character's clips that sound most like this one">≈</button>
        <button className="btn btn-sm" disabled={disabled || busy != null}
                onClick={async () => { setBusy(id); try { await onUse(s.importId, c); } finally { setBusy(null); } }}
                title={disabled ? "Save your changes first" : "Make this clip the reference for this emotion"}>Use</button>
      </div>
    );
  };

  const slider = (label: string, value: number, onChange: (v: number) => void, hint?: string) => (
    <label key={label} style={{ display: "grid", gridTemplateColumns: "92px 1fr 34px", gap: 6, alignItems: "center", fontSize: 10.5, color: "var(--fg-3)" }}
           title={hint}>
      <span>{label}</span>
      <input type="range" min={-1} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))}
             style={{ accentColor: "var(--tts)" }} />
      <span style={{ fontFamily: "var(--font-mono)", textAlign: "right", color: Math.abs(value) < 0.05 ? "var(--fg-4)" : "var(--fg-1)" }}>
        {value > 0 ? "+" : ""}{value.toFixed(2)}
      </span>
    </label>
  );

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <label style={{ ...labelStyle, marginBottom: 4, flex: 1 }}>From the recording</label>
        <button className="btn btn-sm" onClick={() => setShowRecipe((v) => !v)} style={{ padding: "1px 7px", fontSize: 10 }}
                title="How this emotion is found: a blend of emotions plus delivery">
          Recipe {showRecipe ? "▾" : "▸"}{recipe ? " · custom" : ""}
        </button>
      </div>

      {showRecipe && (
        <div style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r)", padding: "8px 10px", marginBottom: 8, background: "var(--bg-2)" }}>
          <div style={{ fontSize: 10.5, color: "var(--fg-4)", marginBottom: 6, lineHeight: 1.5 }}>
            Blend the seven emotions the reader knows (negative = avoid), then shape the delivery against this
            character's own average. {recipe ? "Edited — save to keep it." : first?.recipe ? `Built-in recipe for "${emotion}".` : `No built-in recipe for "${emotion}" — set one here.`}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {CLASSES.map((c) => slider(c, effective.classes[c] ?? 0, (v) => setClass(c, v)))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {DELIVERY.map((d) => slider(d.key, effective[d.key], (v) => edit({ [d.key]: Math.round(v * 100) / 100 }), `− ${d.lo} · + ${d.hi}`))}
              {recipe && (
                <button className="btn btn-sm" onClick={() => onRecipeChange(undefined)} style={{ alignSelf: "flex-start", marginTop: 4 }}>
                  Reset to built-in
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {like && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-3)", marginBottom: 2 }}>
            <button className="btn btn-sm" onClick={() => setLike(null)} style={{ padding: "1px 7px" }}>← back</button>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Sounds like “{like.seed.text || fmt(like.seed.start)}”
            </span>
          </div>
          {like.clips === null && <div style={{ fontSize: 11, color: "var(--fg-4)" }}>Listening…</div>}
          {typeof like.clips === "string" && <div style={{ fontSize: 11, color: "var(--sfx)" }}>{like.clips}</div>}
          {Array.isArray(like.clips) && like.clips.map((c) => row(like.source, c, true))}
        </div>
      )}

      {!like && sources.map((s) => {
        const r = results[s.importId];
        const status = tagging[s.importId];
        const readButton = (label: string) => !status && (
          <button className="btn btn-sm" onClick={() => void tagEmotions(s.importId, s.name)}
                  title="Tag every line of dialogue in this recording with emotion and delivery (runs on the dissect server; a few minutes for a whole audiobook)">
            {label}
          </button>
        );
        return (
          <div key={s.importId} style={{ marginBottom: 6 }}>
            {typeof r === "string" && <div style={{ fontSize: 11, color: "var(--sfx)" }}>{r}</div>}
            {r && typeof r !== "string" && !r.tagged && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-3)" }}>
                <span style={{ flex: 1 }}>
                  {status ? `Reading emotions in ${s.name} — ${status}` : `${s.name} hasn't had its emotions read yet.`}
                </span>
                {readButton("Read emotions")}
              </div>
            )}
            {r && typeof r !== "string" && r.tagged && r.needs_update && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--fg-4)", marginBottom: 4 }}>
                <span style={{ flex: 1 }}>
                  {status ? `Re-reading ${s.name} — ${status}` : "Read before delivery and “≈ more like this” existed — recipes use emotions only."}
                </span>
                {readButton("Re-read")}
              </div>
            )}
            {r && typeof r !== "string" && r.tagged && !r.recipe && (
              <div style={{ fontSize: 11, color: "var(--fg-4)" }}>
                No built-in recipe for "{emotion}" — open Recipe to blend one, or use ≈ on a clip that sounds right.
              </div>
            )}
            {r && typeof r !== "string" && r.tagged && r.recipe && r.clips.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--fg-4)" }}>No clean lines from this character in {s.name}.</div>
            )}
            {r && typeof r !== "string" && r.tagged && r.clips.map((c) => row(s, c, false))}
          </div>
        );
      })}
    </div>
  );
};
