/**
 * DissectReview.tsx
 *
 * A finished import, laid out for extraction: header (cover, title, author,
 * stats), the whole-recording overview, then four tabs —
 *
 *   Voices        speakers → Library characters (rights-gated, see below)
 *   Sound effects effects-stem events, plus vocal sounds (gasps, laughs …)
 *   Ambience      long effects-stem regions — beds
 *   Music         music-stem stings and cues
 *
 * The rights confirmation gates every voice "Add" — nothing reaches a
 * character until it is ticked, and the Rust side refuses without it too.
 * Sounds go to scene assets and carry no voice, so they aren't gated.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Character, DissectManifest, DissectStatus, DissectTurn, LibraryCharacterSummary, Scene } from "../../lib/types";
import { dissectAssignSpeaker, dissectReassign, dissectResetSpeakers, importCharacterFromLibrary, listLibraryCharacters } from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import { fileSrc } from "../../lib/transport";
import { DissectSpeakerCard, type AssignChoice, type SpeakerMove } from "./DissectSpeakerCard";
import { DissectOverview } from "./DissectOverview";
import { DissectSoundList } from "./DissectSoundList";

export const RIGHTS_STATEMENT =
  "I own this recording or have permission from the performer to clone this voice, " +
  "and I will not use it to impersonate them.";

type Tab = "voices" | "sfx" | "ambience" | "music";

// Voices with less speech than this are usually diarization fragments (a long
// book produced 59 of them); they're folded behind a toggle, not dropped.
const MINOR_S = 60;
const isMinor = (speechS: number) => speechS < MINOR_S;

export const DissectReview: React.FC<{
  status: DissectStatus;
  projectId: string | null;
  scenes: Scene[];
  onAssigned?: (character: Character, addedToProject: boolean) => void;
  /** Speaker corrections rewrite the manifest; the parent keeps the new one. */
  onManifest?: (manifest: DissectManifest) => void;
}> = ({ status, projectId, scenes, onAssigned, onManifest }) => {
  const manifest = status.manifest!;
  const importId = status.import_id;
  const [tab, setTab] = useState<Tab>("voices");
  const [library, setLibrary] = useState<LibraryCharacterSummary[]>([]);
  const [rights, setRights] = useState(false);
  const [addToCast, setAddToCast] = useState(!!projectId);
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  const [busySpeaker, setBusySpeaker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showVocal, setShowVocal] = useState(false);
  const [showMinor, setShowMinor] = useState(false);

  const refreshLibrary = useCallback(() => {
    listLibraryCharacters().then(setLibrary).catch((e) => reportError("List library", e));
  }, []);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);
  useEffect(() => { setAssigned({}); setTab("voices"); setError(null); setShowMinor(false); }, [importId]);

  const handleAssign = async (speakerId: string, choice: AssignChoice) => {
    if (!rights) return;
    setBusySpeaker(speakerId);
    setError(null);
    try {
      const character = await dissectAssignSpeaker({
        import_id: importId,
        speaker_id: speakerId,
        candidate_ids: choice.candidateIds,
        gold_candidate_id: choice.goldId,
        library_id: choice.libraryId,
        new_name: choice.newName,
        rights_confirmed: true,
        rights_statement: RIGHTS_STATEMENT,
        performer: choice.performer,
      });
      // Only brand-new characters go into the cast; an existing library
      // character is either already there or deliberately not.
      let addedToProject = false;
      if (projectId && addToCast && !choice.libraryId && character.library_id) {
        await importCharacterFromLibrary({ projectId, libraryId: character.library_id });
        addedToProject = true;
      }
      // Assigning also fills the palette from the performance (when its emotions were read).
      const emotions = character.voice_assignment.emotional_palette.filter((e) => e.qa_status === "approved" && e.ref_audio_path).length;
      setAssigned((prev) => ({ ...prev, [speakerId]: emotions > 0 ? `${character.name} · ${emotions} palette emotions from the performance` : character.name }));
      refreshLibrary();
      onAssigned?.(character, addedToProject);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySpeaker(null);
    }
  };

  const turnsBySpeaker = useMemo(() => {
    const by = new Map<string, DissectTurn[]>();
    for (const t of manifest.turns) {
      const list = by.get(t.speaker);
      if (list) list.push(t); else by.set(t.speaker, [t]);
    }
    for (const list of by.values()) list.sort((a, b) => a.start - b.start);
    return by;
  }, [manifest.turns]);

  const handleMove = async (from: string, move: SpeakerMove) => {
    setBusySpeaker(from);
    setError(null);
    try {
      const m = await dissectReassign({
        import_id: importId, from, to: move.to, new_label: move.newLabel,
        turn_starts: move.turnStarts, candidate_ids: move.candidateIds, all: move.all,
      });
      // A speaker added to a character keeps that; its moved clips no longer count.
      if (move.all) setAssigned((prev) => { const next = { ...prev }; delete next[from]; return next; });
      onManifest?.(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySpeaker(null);
    }
  };

  const handleReset = async () => {
    if (!window.confirm("Undo every speaker correction and go back to the detected speakers?")) return;
    try {
      onManifest?.(await dissectResetSpeakers(importId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Voices split off by hand always show, however short.
  const folded = (sp: { total_speech_s: number; split?: boolean }) => !sp.split && isMinor(sp.total_speech_s);
  const minorCount = manifest.speakers.filter(folded).length;
  const s = manifest.sounds;
  const chapters = manifest.chapters ?? [];
  const tabs: { key: Tab; label: string; n: number | null }[] = [
    { key: "voices", label: "Voices", n: manifest.speakers.length },
    { key: "sfx", label: "Sound effects", n: s ? s.sfx.length : null },
    { key: "ambience", label: "Ambience & beds", n: s ? s.ambience.length : null },
    { key: "music", label: "Music", n: s ? s.music.length : null },
  ];
  const title = manifest.source_tags?.album || manifest.source_tags?.title || manifest.source_name;
  const hours = manifest.duration_s >= 3600
    ? `${(manifest.duration_s / 3600).toFixed(1)} h`
    : `${Math.round(manifest.duration_s / 60)} min`;

  return (
    <div style={{ padding: "22px 26px", maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16 }}>
        {manifest.cover && (
          <img src={fileSrc(`${status.import_dir}/${manifest.cover}`)} alt=""
               style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 3, border: "1px solid var(--line-2)" }} />
        )}
        <div style={{ minWidth: 0 }}>
          <div className="kicker" style={{ marginBottom: 4 }}>Dissect</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--fg-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 3 }}>
            {manifest.source_tags?.artist ? `${manifest.source_tags.artist} · ` : ""}
            {hours}{chapters.length ? ` · ${chapters.length} chapters` : ""} · {manifest.speakers.length} voices
            {s ? ` · ${s.sfx.length} effects · ${s.ambience.length} ambience · ${s.music.length} music` : ""}
          </div>
        </div>
      </div>

      {manifest.warnings.map((w) => (
        <div key={w} style={{ marginBottom: 10, padding: "8px 12px", fontSize: 11.5, border: "1px solid var(--line-2)", color: "var(--tts)", borderRadius: 2 }}>{w}</div>
      ))}

      <div style={{ background: "var(--bg-1)", border: "1px solid var(--line-1)", borderRadius: 3, padding: "12px 14px", marginBottom: 16 }}>
        <DissectOverview manifest={manifest} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line-1)", marginBottom: 14 }}>
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className="btn btn-sm" style={{
            border: "none", borderBottom: `2px solid ${tab === t.key ? "var(--tts)" : "transparent"}`,
            borderRadius: 0, background: "transparent", color: tab === t.key ? "var(--fg-0)" : "var(--fg-3)",
            padding: "6px 12px", fontSize: 11,
          }}>
            {t.label}{t.n !== null ? <span style={{ color: "var(--fg-4)" }}> · {t.n}</span> : null}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ marginBottom: 12, padding: "8px 12px", fontSize: 11.5, border: "1px solid var(--tts-d)", color: "var(--tts)", borderRadius: 2, whiteSpace: "pre-wrap" }}>{error}</div>
      )}

      {tab === "voices" && (
        <>
          <label style={{
            display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", marginBottom: 12, borderRadius: 2,
            border: `1px solid ${rights ? "var(--line-2)" : "var(--tts-d)"}`,
            background: rights ? "var(--bg-1)" : "color-mix(in oklch, var(--tts) 8%, var(--bg-1))",
            fontSize: 12, color: "var(--fg-1)", lineHeight: 1.5, cursor: "pointer",
          }}>
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <strong>{RIGHTS_STATEMENT}</strong>
              <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
                Required before any voice is added. Pharaoh records this confirmation, the performer when known,
                and the source file on each character it creates.
              </span>
            </span>
          </label>
          {projectId && (
            <label style={{ fontSize: 11.5, color: "var(--fg-2)", display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
              <input type="checkbox" checked={addToCast} onChange={(e) => setAddToCast(e.target.checked)} />
              Also add new characters to this episode's cast
            </label>
          )}
          {(manifest.corrections ?? 0) > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, fontSize: 11.5, color: "var(--fg-2)" }}>
              {manifest.corrections} speaker correction{manifest.corrections === 1 ? "" : "s"}
              <button className="btn btn-sm" onClick={handleReset}>Reset speakers</button>
            </div>
          )}
          {manifest.speakers.length === 0 && <div style={{ fontSize: 12, color: "var(--fg-3)" }}>No speech found in this recording.</div>}
          {manifest.speakers.length === 1 && (
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 10, lineHeight: 1.5 }}>
              One voice throughout. Speaker detection follows voices, not characters — a single narrator
              performing every part (as in many audiobooks) is one speaker. Open its lines to move parts to their own voices.
            </div>
          )}
          {manifest.speakers.filter((sp) => showMinor || !folded(sp)).map((sp) => (
            <DissectSpeakerCard
              key={`${importId}-${sp.id}`}
              speaker={sp}
              importDir={status.import_dir}
              library={library}
              chapters={chapters}
              assignedTo={assigned[sp.id] ?? null}
              busy={busySpeaker === sp.id}
              rightsConfirmed={rights}
              onAssign={(choice) => handleAssign(sp.id, choice)}
              importId={importId}
              speakers={manifest.speakers}
              turns={turnsBySpeaker.get(sp.id) ?? []}
              onMove={(move) => handleMove(sp.id, move)}
            />
          ))}
          {minorCount > 0 && (
            <button className="btn btn-sm" onClick={() => setShowMinor((v) => !v)} style={{ marginTop: 4 }}>
              {showMinor
                ? "Hide minor voices"
                : `Show ${minorCount} minor voice${minorCount === 1 ? "" : "s"} (under ${MINOR_S} s of speech each — often fragments)`}
            </button>
          )}
        </>
      )}

      {!s && tab !== "voices" && (
        <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6 }}>
          This import predates sound detection. Retry it from the list to find effects, ambience and music.
        </div>
      )}
      {s && tab === "sfx" && (
        <>
          {s.vocal.length > 0 && (
            <label style={{ fontSize: 11.5, color: "var(--fg-2)", display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
              <input type="checkbox" checked={showVocal} onChange={(e) => setShowVocal(e.target.checked)} />
              Show vocal sounds too ({s.vocal.length} gasps, laughs, breaths… — performance, not effects)
            </label>
          )}
          <DissectSoundList
            key={`sfx-${showVocal}`}
            importId={importId}
            sounds={showVocal ? [...s.sfx, ...s.vocal].sort((a, b) => a.start - b.start) : s.sfx}
            chapters={chapters} scenes={scenes} projectId={projectId}
            empty={manifest.separated
              ? "No distinct sound effects found — on a dry reading the effects stem is mostly silence."
              : "Separation was off for this import, so there is no effects stem."}
          />
        </>
      )}
      {s && tab === "ambience" && (
        <DissectSoundList importId={importId} sounds={s.ambience} chapters={chapters} scenes={scenes} projectId={projectId}
          empty="No sustained ambience (rain, crowd, room tone) found on the effects stem." />
      )}
      {s && tab === "music" && (
        <DissectSoundList importId={importId} sounds={s.music} chapters={chapters} scenes={scenes} projectId={projectId}
          empty="No music found — regions on the music stem that the tagger didn't hear as music are dropped as bleed." />
      )}
    </div>
  );
};
