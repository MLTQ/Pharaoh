import React, { useCallback, useEffect, useRef, useState } from "react";
import { getProjectsDir, getSeries, listLibraryCharacters, listSeriesEpisodes, updateSeries } from "../../lib/tauriCommands";
import { formatLabel } from "../../lib/archetypes";
import { openProjectById } from "../../lib/openProject";
import { reportError } from "../../lib/errors";
import { useSeriesStore } from "../../store/seriesStore";
import { useProjectStore } from "../../store/projectStore";
import { LibraryView } from "../library/LibraryView";
import type { LibraryCharacterSummary, Project, Series } from "../../lib/types";
import { EpisodesTab } from "./EpisodesTab";
import { BibleTab } from "./BibleTab";
import { CastTab } from "./CastTab";
import { SetsTab } from "./SetsTab";
import { SoundTab } from "./SoundTab";
import { StyleTab } from "./StyleTab";
import { CanonTab } from "./CanonTab";
import { monoMeta } from "./seriesUi";

// Series home: the show bible above its episodes. Bible edits autosave to
// series.json; canon has its own file and save. An episode opens in the
// ordinary project workspace.

type Tab = "episodes" | "bible" | "cast" | "sets" | "sound" | "style" | "canon" | "voices";

/** Drop the blank lines left by one-item-per-line editing. */
function clean(s: Series): Series {
  const nonEmpty = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return {
    ...s,
    themes: nonEmpty(s.themes),
    cast: s.cast.map((m) => ({
      ...m,
      catchphrases: nonEmpty(m.catchphrases),
      lazzi: nonEmpty(m.lazzi),
      relationships: m.relationships.filter((r) => r.dynamic.trim()),
    })),
    style: { ...s.style, banned: nonEmpty(s.style.banned) },
  };
}

export const SeriesHomeView: React.FC<{ seriesId: string }> = ({ seriesId }) => {
  const closeSeries = useSeriesStore((s) => s.closeSeries);
  const episodesVersion = useSeriesStore((s) => s.episodesVersion);
  const writing = useSeriesStore((s) => s.writing[seriesId]);
  const [draft, setDraft] = useState<Series | null>(null);
  const [episodes, setEpisodes] = useState<Project[]>([]);
  const [library, setLibrary] = useState<LibraryCharacterSummary[]>([]);
  const [tab, setTab] = useState<Tab>("episodes");
  const [voiceTarget, setVoiceTarget] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [err, setErr] = useState<string | null>(null);
  const savedJson = useRef("");

  useEffect(() => {
    getSeries(seriesId)
      .then((s) => {
        savedJson.current = JSON.stringify(clean(s));
        setDraft(s);
        if (s.cast.length === 0) setTab("bible");
      })
      .catch((e) => setErr(String(e)));
    // The library editor (Voices tab) resolves bundles through projectsDir.
    if (!useProjectStore.getState().projectsDir) {
      getProjectsDir().then((dir) => { if (dir) useProjectStore.setState({ projectsDir: dir }); }).catch(() => {});
    }
  }, [seriesId]);

  useEffect(() => {
    listSeriesEpisodes(seriesId).then(setEpisodes).catch((e) => reportError("List episodes", e));
  }, [seriesId, episodesVersion]);

  // Refresh voices whenever the cast or episodes view is shown (palette counts change in Voices).
  useEffect(() => {
    if (tab === "cast" || tab === "episodes") listLibraryCharacters().then(setLibrary).catch(() => {});
  }, [tab]);

  const save = useCallback(async (s: Series) => {
    const c = clean(s);
    const json = JSON.stringify(c);
    if (json === savedJson.current) { setSaveState("saved"); return; }
    setSaveState("saving");
    try {
      await updateSeries(c);
      savedJson.current = json;
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      reportError("Save series", e);
    }
  }, []);

  // Debounced autosave.
  useEffect(() => {
    if (!draft) return;
    if (JSON.stringify(clean(draft)) === savedJson.current) return;
    setSaveState("pending");
    const t = setTimeout(() => save(draft), 700);
    return () => clearTimeout(t);
  }, [draft, save]);

  const patch = (p: Partial<Series>) => setDraft((d) => (d ? { ...d, ...p } : d));

  if (err) {
    return (
      <Shell>
        <button className="btn btn-sm" onClick={closeSeries}>← All projects</button>
        <div style={{ marginTop: 16, fontSize: 12, color: "var(--sfx)" }}>{err}</div>
      </Shell>
    );
  }
  if (!draft) return <Shell><div style={{ fontSize: 12, color: "var(--fg-4)" }}>Loading…</div></Shell>;

  const openEpisode = async (id: string) => {
    await save(draft);
    try { await openProjectById(id); } catch (e) { reportError("Open episode", e); }
  };

  const tabs: [Tab, string][] = [
    ["episodes", `Episodes · ${episodes.length}`],
    ["bible", "Bible"],
    ["cast", `Cast · ${draft.cast.length}`],
    ["sets", `Sets · ${draft.sets.length}`],
    ["sound", `Sound · ${draft.sounds.length}`],
    ["style", "Style"],
    ["canon", "Canon"],
    ["voices", "Voices"],
  ];

  return (
    <Shell wide={tab === "voices"}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <button className="btn btn-sm" onClick={async () => { await save(draft); closeSeries(); }}>
          ← All projects
        </button>
        <span style={{ ...monoMeta, color: saveState === "error" ? "var(--sfx)" : "var(--fg-4)" }}>
          {writing ? `writing: ${writing.message.toLowerCase()} · ` : ""}
          {saveState === "saved" ? "saved" : saveState === "error" ? "save failed" : "saving…"}
        </span>
      </div>
      <div style={{ ...monoMeta, color: "var(--music)", textTransform: "uppercase", letterSpacing: "0.14em", marginBottom: 4 }}>
        Series · {formatLabel(draft.format)}
      </div>
      <div style={{ fontWeight: 600, fontSize: 26, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>{draft.title}</div>
      {draft.logline && <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.5 }}>{draft.logline}</div>}

      <div style={{ display: "flex", gap: 2, margin: "22px 0 20px", borderBottom: "1px solid var(--line-1)", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none" }}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => { if (id !== "voices") setVoiceTarget(null); setTab(id); }}
            style={{
              background: "none", border: "none", cursor: "pointer", whiteSpace: "nowrap",
              padding: "8px 12px", marginBottom: -1, fontSize: 12.5,
              color: tab === id ? "var(--fg-0)" : "var(--fg-3)",
              borderBottom: `2px solid ${tab === id ? "var(--music)" : "transparent"}`,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "episodes" && (
        <EpisodesTab series={draft} episodes={episodes} onOpen={openEpisode} beforeCreate={() => save(draft)} onGoTo={setTab} />
      )}
      {tab === "bible" && <BibleTab series={draft} patch={patch} />}
      {tab === "cast" && (
        <CastTab series={draft} library={library} patch={patch}
          onDesignVoice={(id) => { setVoiceTarget(id); setTab("voices"); }} />
      )}
      {tab === "sets" && <SetsTab series={draft} patch={patch} onGoToSound={() => setTab("sound")} />}
      {tab === "sound" && <SoundTab series={draft} patch={patch} />}
      {tab === "style" && <StyleTab series={draft} episodes={episodes} patch={patch} />}
      {tab === "canon" && <CanonTab series={draft} />}
      {tab === "voices" && (
        <div>
          <div style={{ fontSize: 11.5, color: "var(--fg-4)", marginBottom: 10, lineHeight: 1.6 }}>
            The character library, shared by every project. Design a voice, approve takes for its palette, then link it to a cast member in Cast.
          </div>
          <div style={{ position: "relative", height: "calc(100vh - 260px)", minHeight: 480, border: "1px solid var(--line-1)", borderRadius: 4, overflow: "hidden" }}>
            <LibraryView key={voiceTarget ?? "library"} initialSelectedId={voiceTarget} />
          </div>
        </div>
      )}
    </Shell>
  );
};

const Shell: React.FC<{ children: React.ReactNode; wide?: boolean }> = ({ children, wide }) => (
  <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--bg-0)" }}>
    <div style={{ maxWidth: wide ? 1400 : 980, margin: "0 auto", padding: "28px 24px 60px" }}>{children}</div>
  </div>
);
