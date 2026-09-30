/**
 * DissectSoundList.tsx
 *
 * Sounds found in a dissected recording — effects, vocal sounds, ambience or
 * music — with audition, AudioSet labels, position and chapter. Tick any
 * number and "Add to scene" copies them into that scene's assets as
 * sidecar-indexed WAVs (via dissect_extract_sound), ready to bind to rows.
 *
 * Auditions are cut on demand (dissect_clip) rather than played from the stem:
 * a long book's stem is gigabytes and would be decoded whole.
 */

import React, { useMemo, useState } from "react";
import type { DissectChapter, DissectSound, Scene } from "../../lib/types";
import { dissectClip, dissectExtractSound } from "../../lib/tauriCommands";
import { useAudioStore } from "../../store/audioStore";
import { useToastStore } from "../../store/toastStore";
import { Icon } from "../shared/atoms";

function fmt(s: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Play a span of a stem: cut (cached) on first click, then toggle. */
export const SpanPlayButton: React.FC<{ importId: string; stem: string; start: number; end: number }> = ({
  importId, stem, start, end,
}) => {
  const { playing, toggle } = useAudioStore();
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = path !== null && playing === path;
  return (
    <button
      className="btn btn-sm"
      style={{ padding: "2px 5px", minWidth: 0, lineHeight: 1 }}
      title={active ? "Stop" : "Audition"}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          let p = path;
          if (!p) {
            setBusy(true);
            p = await dissectClip(importId, stem, start, end);
            setPath(p);
          }
          await toggle(p);
        } catch (err) {
          useToastStore.getState().push({ kind: "error", title: "Couldn't cut that clip", body: String(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name={active ? "pause" : "play"} style={{ width: 12, height: 12 }} />
    </button>
  );
};

export const DissectSoundList: React.FC<{
  importId: string;
  sounds: DissectSound[];
  chapters: DissectChapter[];
  /** Scenes of the open project; empty when no project is open. */
  scenes: Scene[];
  projectId: string | null;
  empty: string;
}> = ({ importId, sounds, chapters, scenes, projectId, empty }) => {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scene, setScene] = useState<string>(scenes[0]?.slug ?? "");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sounds;
    return sounds.filter((s) =>
      s.name.toLowerCase().includes(q) || s.labels.some((l) => l.label.toLowerCase().includes(q)));
  }, [sounds, query]);

  // Label counts for quick filtering on long recordings.
  const topLabels = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of sounds) for (const l of s.labels.slice(0, 1)) n.set(l.label, (n.get(l.label) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [sounds]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const extract = async () => {
    if (!projectId || !scene || picked.size === 0) return;
    setBusy(true);
    const chosen = sounds.filter((s) => picked.has(s.id));
    let ok = 0;
    for (const s of chosen) {
      try {
        await dissectExtractSound({
          import_id: importId, stem: s.stem, start: s.start, end: s.end, name: s.name,
          kind: s.kind, project_id: projectId, scene_slug: scene, labels: s.labels.map((l) => l.label),
        });
        ok++;
        setAdded((prev) => new Set(prev).add(s.id));
      } catch (e) {
        useToastStore.getState().push({ kind: "error", title: `Couldn't add "${s.name}"`, body: String(e) });
      }
    }
    setPicked(new Set());
    setBusy(false);
    const title = scenes.find((x) => x.slug === scene)?.title ?? scene;
    if (ok) useToastStore.getState().push({ kind: "info", title: `Added ${ok} sound${ok === 1 ? "" : "s"} to ${title}` });
  };

  if (sounds.length === 0) {
    return <div style={{ padding: "18px 4px", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6 }}>{empty}</div>;
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <input
          value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Filter ${sounds.length} sounds…`}
          style={{
            flex: "1 1 180px", fontSize: 11.5, background: "var(--bg-0)", color: "var(--fg-1)",
            border: "1px solid var(--line-2)", borderRadius: 2, padding: "4px 8px",
          }}
        />
        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{picked.size} selected</span>
        {projectId && scenes.length > 0 ? (
          <>
            <select
              value={scene} onChange={(e) => setScene(e.target.value)}
              style={{ fontSize: 11.5, background: "var(--bg-0)", color: "var(--fg-1)", border: "1px solid var(--line-2)", borderRadius: 2, padding: "4px 6px", maxWidth: 220 }}
            >
              {scenes.map((s) => <option key={s.slug} value={s.slug}>{s.title || s.slug}</option>)}
            </select>
            <button
              className="btn btn-sm btn-primary" disabled={busy || picked.size === 0}
              style={{ opacity: busy || picked.size === 0 ? 0.45 : 1 }}
              onClick={extract}
            >{busy ? "Adding…" : "Add to scene"}</button>
          </>
        ) : (
          <span style={{ fontSize: 11, color: "var(--fg-4)" }}>Open a project with scenes to add sounds to it</span>
        )}
      </div>
      {topLabels.length > 1 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
          {topLabels.map(([label, n]) => (
            <button
              key={label} className="btn btn-sm"
              onClick={() => setQuery(query === label ? "" : label)}
              style={{
                padding: "1px 7px", fontSize: 10, textTransform: "none", letterSpacing: 0,
                borderColor: query === label ? "var(--sfx)" : undefined, color: query === label ? "var(--sfx)" : undefined,
              }}
            >{label} <span style={{ color: "var(--fg-4)" }}>{n}</span></button>
          ))}
        </div>
      )}

      {/* Rows */}
      <div style={{ border: "1px solid var(--line-1)", borderRadius: 2 }}>
        {shown.map((s) => {
          const ch = s.chapter !== null && s.chapter !== undefined ? chapters[s.chapter] : null;
          return (
            <div key={s.id} onClick={() => toggle(s.id)} style={{
              display: "grid", gridTemplateColumns: "18px 24px 1fr auto", gap: 8, alignItems: "center",
              padding: "5px 10px", borderBottom: "1px solid var(--line-1)", cursor: "pointer",
              background: picked.has(s.id) ? "var(--bg-2)" : undefined,
            }}>
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} onClick={(e) => e.stopPropagation()} />
              <SpanPlayButton importId={importId} stem={s.stem} start={s.start} end={s.end} />
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ fontSize: 12, color: "var(--fg-1)" }}>{s.name}</span>
                {s.role && <span style={{ fontSize: 10, color: "var(--fg-4)" }}> · {s.role}</span>}
                {added.has(s.id) && <span style={{ fontSize: 10.5, color: "var(--st-rendered)" }}> · added</span>}
                {s.labels.length > 1 && (
                  <span style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                    {" "}— {s.labels.slice(0, 3).map((l) => `${l.label} ${Math.round(l.score * 100)}%`).join(", ")}
                  </span>
                )}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", whiteSpace: "nowrap" }}
                    title={ch?.title ?? undefined}>
                {s.duration.toFixed(1)}s · @{fmt(s.start)}{ch ? ` · ${ch.title.slice(0, 22)}` : ""} · +{Math.round(s.prominence)} dB
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
