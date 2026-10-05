/**
 * ProseScriptDialog — turn a prose chapter into scenes.
 *
 * Paste the chapter (or open a .txt/.md file), convert, look over the
 * Fountain, then add its scenes to the project. Claude decides who speaks
 * each line, where scenes break and which sounds to add, when an Anthropic
 * key is set; otherwise dialogue tags and turn-taking decide. The chapter's
 * words are kept as written. With "Name voices" on, the narrator names each
 * character after their first line in a scene ("Said Hagrid.") unless the
 * prose already does.
 */

import React, { useState } from "react";
import { createPortal } from "react-dom";
import { importScriptText, proseToScript, type ProseScriptResult } from "../../lib/tauriCommands";
import { useProjectStore } from "../../store/projectStore";

const label: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em",
  textTransform: "uppercase", color: "var(--fg-3)",
};

export const ProseScriptDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { realProjectId, realProject, reloadProjectFromDisk } = useProjectStore();
  const characters = realProject?.characters ?? [];
  const [text, setText] = useState("");
  const [narrator, setNarrator] = useState(() => characters.find((c) => /narrator/i.test(c.name))?.name ?? "Narrator");
  const [intros, setIntros] = useState(true);
  const [useClaude, setUseClaude] = useState(true);
  const [result, setResult] = useState<ProseScriptResult | null>(null);
  const [fountain, setFountain] = useState("");
  const [busy, setBusy] = useState<"" | "convert" | "import">("");
  const [error, setError] = useState<string | null>(null);

  const openFile = (f: File | undefined) => {
    if (!f) return;
    f.text().then(setText, (e) => setError(String(e)));
  };

  const convert = async () => {
    setBusy("convert");
    setError(null);
    try {
      const r = await proseToScript({
        text,
        cast: characters.map((c) => ({ name: c.name, description: c.description ?? "" })),
        narrator: narrator.trim() || undefined,
        intros,
        heuristic: !useClaude,
        apiKeyEnv: realProject?.llm_config?.api_key_env || undefined,
      });
      setResult(r);
      setFountain(r.fountain);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const addScenes = async () => {
    if (!realProjectId) return;
    setBusy("import");
    setError(null);
    try {
      await importScriptText({ projectId: realProjectId, fountain });
      await reloadProjectFromDisk();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const s = result?.stats;
  const sceneCount = (fountain.match(/^(INT\.|EXT\.|EST\.|I\/E\.)/gm) ?? []).length;

  return createPortal(
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklch, black 55%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-label="Script from prose" onClick={(e) => e.stopPropagation()} style={{ width: "min(860px, 100%)", height: "min(720px, 90vh)", display: "flex", flexDirection: "column", gap: 10, background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 4, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ ...label, fontSize: 9.5, color: "var(--fg-4)" }}>Script from prose</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
            Narration, dialogue and sound cues from a chapter. The words stay as written.
          </div>
        </div>

        {!result ? (
          <>
            <textarea
              className="input"
              placeholder="Paste a chapter here, or open a .txt / .md file"
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{ flex: 1, resize: "none", fontFamily: "var(--font-serif, Georgia, serif)", fontSize: 13, lineHeight: 1.5 }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
              <label className="btn btn-sm" style={{ cursor: "pointer" }}>
                Open file…
                <input type="file" accept=".txt,.md,.markdown,text/plain" style={{ display: "none" }} onChange={(e) => openFile(e.target.files?.[0])} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={label}>Narrator</span>
                <input className="input" value={narrator} onChange={(e) => setNarrator(e.target.value)} list="prose-cast" style={{ width: 160 }} />
                <datalist id="prose-cast">{characters.map((c) => <option key={c.id} value={c.name} />)}</datalist>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-2)" }} title='After a character&apos;s first line in each scene, the narrator says who spoke ("Said Hagrid.") unless the prose already names them'>
                <input type="checkbox" checked={intros} onChange={(e) => setIntros(e.target.checked)} />
                Name voices on their first line in a scene
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-2)" }} title="Claude picks speakers, scenes and sound cues (needs an Anthropic API key). Off: dialogue tags and turn-taking only, no cues.">
                <input type="checkbox" checked={useClaude} onChange={(e) => setUseClaude(e.target.checked)} />
                Use Claude
              </label>
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" disabled={!text.trim() || !!busy} onClick={convert}>
                {busy === "convert" ? (useClaude ? "Reading the chapter…" : "Converting…") : "Convert"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-3)" }}>
              <span>{s!.scenes} scene{s!.scenes === 1 ? "" : "s"}</span>
              <span>{s!.dialogue_lines} lines of dialogue</span>
              <span>{s!.narration_lines} narration</span>
              <span>{s!.cues} cues</span>
              <span>{s!.intros_added + s!.tags_named} voices named</span>
              <span>{result.mode === "claude" ? `by ${result.model}` : "from dialogue tags"}</span>
            </div>
            {result.note && <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{result.note}.</div>}
            {result.new_characters.length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                New characters: {result.new_characters.join(", ")}
                {s!.unknown > 0 && <span style={{ color: "var(--sfx)" }}> — {s!.unknown} line{s!.unknown === 1 ? "" : "s"} under UNKNOWN; reassign them in the script or merge the character after import.</span>}
              </div>
            )}
            <textarea
              className="input"
              value={fountain}
              onChange={(e) => setFountain(e.target.value)}
              spellCheck={false}
              style={{ flex: 1, resize: "none", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.5 }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn btn-sm" onClick={() => setResult(null)} disabled={!!busy}>Back</button>
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-sm btn-primary" disabled={!realProjectId || sceneCount === 0 || !!busy} onClick={addScenes}>
                {busy === "import" ? "Adding…" : `Add ${sceneCount} scene${sceneCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
        {error && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--sfx)" }}>{error}</div>}
      </div>
    </div>,
    document.body,
  );
};
