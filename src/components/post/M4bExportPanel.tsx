/**
 * M4bExportPanel.tsx
 *
 * Final Assembly's audiobook export: the rendered episode as a chaptered
 * .m4b with cover art and tags. One chapter per scene, at the positions
 * render_episode recorded (crossfade-adjusted). Presentation + the export
 * call only; chapter math and encoding live in commands/audiobook.rs.
 */

import React, { useEffect, useState } from "react";
import type { EpisodeChapter } from "../../lib/types";
import { exportEpisodeM4b, getEpisodeChapters, getProjectCover } from "../../lib/tauriCommands";
import { fileSrc } from "../../lib/transport";
import { useToastStore } from "../../store/toastStore";

const BITRATES = [
  { value: 64, label: "64 kbps · spoken word" },
  { value: 96, label: "96 kbps" },
  { value: 128, label: "128 kbps · default" },
  { value: 192, label: "192 kbps · music-heavy" },
];

function fmt(s: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Author / narrator are remembered per project in this browser only. */
function loadPrefs(projectId: string): { author: string; narrator: string; bitrate: number } {
  try {
    const raw = localStorage.getItem(`pharaoh.m4b.${projectId}`);
    if (raw) return { author: "", narrator: "", bitrate: 128, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { author: "", narrator: "", bitrate: 128 };
}

function savePrefs(projectId: string, prefs: { author: string; narrator: string; bitrate: number }) {
  try { localStorage.setItem(`pharaoh.m4b.${projectId}`, JSON.stringify(prefs)); } catch { /* ignore */ }
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", fontSize: 12,
  background: "var(--bg-0)", color: "var(--fg-1)",
  border: "1px solid var(--line-2)", borderRadius: 3, padding: "5px 8px",
};

export const M4bExportPanel: React.FC<{
  projectId: string;
  projectTitle: string;
  /** True once output/final.wav exists. */
  finalReady: boolean;
  /** Bumped by the parent after each episode render so chapters re-load. */
  renderVersion: number;
}> = ({ projectId, projectTitle, finalReady, renderVersion }) => {
  const pushToast = useToastStore((s) => s.push);
  const [chapters, setChapters] = useState<EpisodeChapter[]>([]);
  const [savedCover, setSavedCover] = useState<string | null>(null);
  const [pendingCover, setPendingCover] = useState<string | null>(null);
  const [author, setAuthor] = useState("");
  const [narrator, setNarrator] = useState("");
  const [bitrate, setBitrate] = useState(128);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const p = loadPrefs(projectId);
    setAuthor(p.author);
    setNarrator(p.narrator);
    setBitrate(p.bitrate);
    getProjectCover(projectId).then(setSavedCover).catch(() => setSavedCover(null));
  }, [projectId]);

  useEffect(() => {
    if (!finalReady) { setChapters([]); return; }
    getEpisodeChapters(projectId).then(setChapters).catch(() => setChapters([]));
  }, [projectId, finalReady, renderVersion]);

  const cover = pendingCover ?? savedCover;

  const chooseCover = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      title: "Choose cover art",
      multiple: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (picked) setPendingCover(typeof picked === "string" ? picked : (picked as { path: string }).path);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const safe = projectTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "episode";
      const target = await save({
        title: "Export audiobook",
        defaultPath: `${safe}.m4b`,
        filters: [{ name: "Audiobook", extensions: ["m4b"] }],
      });
      if (!target) return;
      savePrefs(projectId, { author, narrator, bitrate });
      const result = await exportEpisodeM4b({
        projectId,
        outputPath: typeof target === "string" ? target : (target as { path: string }).path,
        options: {
          cover_path: pendingCover,
          author: author.trim() || null,
          narrator: narrator.trim() || null,
          bitrate_kbps: bitrate,
        },
      });
      if (result.cover_path) { setSavedCover(result.cover_path); setPendingCover(null); }
      pushToast({
        kind: "info",
        title: `Exported ${result.chapters.length} chapter${result.chapters.length === 1 ? "" : "s"} · ${(result.bytes / 1024 / 1024).toFixed(1)} MB`,
        body: result.output_path,
      });
    } catch (e) {
      pushToast({ kind: "error", title: "Audiobook export failed", body: String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 18,
      padding: 16, marginBottom: 16,
      background: "var(--bg-1)", border: "1px solid var(--line-1)", borderRadius: 4,
    }}>
      {/* Cover */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="kicker">Audiobook · .m4b</div>
        <div
          onClick={chooseCover}
          title="Choose cover art (jpg / png, square, ≥ 1400 px recommended)"
          style={{
            width: 120, height: 120, borderRadius: 3, cursor: "pointer", overflow: "hidden",
            border: "1px solid var(--line-2)", background: "var(--bg-2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 10.5, color: "var(--fg-4)", textAlign: "center", whiteSpace: "pre-line",
          }}
        >
          {cover
            ? <img src={fileSrc(cover)} alt="Cover art" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : "No cover\nclick to add"}
        </div>
        <button className="btn btn-sm" onClick={chooseCover}>{cover ? "Change cover…" : "Add cover…"}</button>
      </div>

      {/* Tags */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          Author
          <input style={inputStyle} value={author} placeholder="Shown as the book's author"
                 onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          Narrator / cast
          <input style={inputStyle} value={narrator} placeholder="Optional"
                 onChange={(e) => setNarrator(e.target.value)} />
        </label>
        <label style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          Quality
          <select style={inputStyle} value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}>
            {BITRATES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </label>
        <button
          className="btn btn-primary"
          onClick={handleExport}
          disabled={!finalReady || exporting}
          title={finalReady ? undefined : "Render the episode first"}
          style={{ opacity: finalReady ? 1 : 0.5, alignSelf: "flex-start" }}
        >
          {exporting ? "Exporting…" : "Export .m4b…"}
        </button>
      </div>

      {/* Chapters */}
      <div style={{ minWidth: 0 }}>
        <div className="kicker" style={{ marginBottom: 6 }}>
          Chapters{chapters.length ? ` · ${chapters.length}` : ""}
        </div>
        {!finalReady ? (
          <div style={{ fontSize: 11, color: "var(--fg-4)", lineHeight: 1.5 }}>
            Render the episode first — each scene becomes a chapter, titled from the storyboard.
          </div>
        ) : chapters.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--fg-4)" }}>No chapter data for this render.</div>
        ) : (
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {chapters.map((c) => (
              <div key={c.slug} style={{ display: "flex", gap: 10, fontSize: 11.5, padding: "3px 0", color: "var(--fg-1)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-3)", width: 52, flexShrink: 0 }}>
                  {fmt(c.start_s)}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
