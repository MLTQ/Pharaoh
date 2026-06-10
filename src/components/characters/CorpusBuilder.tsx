/**
 * CorpusBuilder.tsx
 *
 * Stage 3 of the character voice pipeline. Manages generation of the Chatterbox
 * training corpus used to train the character's RVC voice model.
 *
 * The corpus is a set of 50–100 WAV files stored under
 * <project>/characters/<char>/rvc_corpus/. Each WAV is synthesised with varied
 * paralinguistic tags ([sigh], [chuckle], etc.) across all approved palette emotions,
 * giving the RVC trainer diverse vocal texture to learn from.
 *
 * Key UX decisions:
 * - Generation is explicitly a background task — the UI makes this clear up front.
 * - Duration readiness (green ≥5 min, amber 2–5 min, red <2 min) matters more
 *   than raw count because short takes produce bad models.
 * - A "Clear Corpus" danger action is available for restarting the process.
 */

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/transport";
import type { Character } from "../../lib/types";
import { importAudioFilesIntoCorpus } from "../../lib/tauriCommands";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CorpusBuilderProps {
  projectId: string;
  character: Character;
  projectsDir: string;
  corpusCount: number;
  corpusDurationMs: number;
  corpusTarget: number;
  onCorpusUpdated: () => void;
}

interface EmotionCorpusCount {
  emotion: string;
  count: number;
}

interface BuildCorpusResult {
  job_id: string;
  total: number;
}

interface CorpusJobStatus {
  completed: number;
  total: number;
  done: boolean;
  error: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PARALINGUISTIC_TAGS = [
  "[sigh]",
  "[chuckle]",
  "[laugh]",
  "[gasp]",
  "[clears throat]",
  "[hmm]",
];

const STAGE_COLOR = "oklch(0.72 0.16 25)";

const DURATION_READY_MS   = 5 * 60 * 1000;  // 5 min → green
const DURATION_AMBER_MS   = 2 * 60 * 1000;  // 2 min → amber

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function readinessColor(durationMs: number): string {
  if (durationMs >= DURATION_READY_MS) return "var(--st-rendered)";
  if (durationMs >= DURATION_AMBER_MS) return "oklch(0.78 0.16 75)"; // amber
  return "oklch(0.72 0.18 25)"; // red-orange
}

function readinessLabel(durationMs: number): string {
  if (durationMs >= DURATION_READY_MS) return "Ready for training";
  if (durationMs >= DURATION_AMBER_MS) return "Minimal — more is better";
  return "Insufficient — add more takes";
}

// ── Sub-components ────────────────────────────────────────────────────────────

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    fontFamily: "var(--font-mono)",
    fontSize: 9.5,
    letterSpacing: "0.08em",
    color: "var(--fg-4)",
    textTransform: "uppercase",
    marginBottom: 8,
    paddingBottom: 5,
    borderBottom: "1px solid var(--line-1)",
  }}>
    {children}
  </div>
);

const TagChip: React.FC<{ label: string }> = ({ label }) => (
  <span style={{
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 7px",
    background: `color-mix(in oklch, ${STAGE_COLOR} 12%, var(--bg-2))`,
    border: `1px solid color-mix(in oklch, ${STAGE_COLOR} 30%, var(--line-1))`,
    borderRadius: "var(--r)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: STAGE_COLOR,
    letterSpacing: "0.02em",
  }}>
    {label}
  </span>
);

interface ProgressBarProps {
  value: number;   // 0..1
  color: string;
  height?: number;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ value, color, height = 6 }) => (
  <div style={{
    width: "100%",
    height,
    borderRadius: height / 2,
    background: "var(--bg-0)",
    border: "1px solid var(--line-1)",
    overflow: "hidden",
  }}>
    <div style={{
      width: `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`,
      height: "100%",
      background: color,
      borderRadius: height / 2,
      transition: "width 0.3s ease",
    }} />
  </div>
);

// ── Main component ───────────────────────────────────────────────────────────

export const CorpusBuilder: React.FC<CorpusBuilderProps> = ({
  projectId,
  character,
  projectsDir: _projectsDir,
  corpusCount,
  corpusDurationMs,
  corpusTarget,
  onCorpusUpdated,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [emotionCounts, setEmotionCounts] = useState<EmotionCorpusCount[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Bulk-import real audio recordings into the corpus (Pharaoh-mo0q). Routes
  // via the synthetic "_library" projectId when CorpusBuilder is mounted from
  // LibraryView — same path math works for project bundles too if we ever
  // re-add a project-side corpus tab.
  const handleBulkImport = useCallback(async () => {
    // The backend command currently expects a library_id (resolved via the
    // _library bundle layout). For project-character context, we'd need a
    // parallel command — defer until that surface exists.
    if (projectId !== "_library") {
      setError("Bulk audio import is currently only available in the Library Corpus tab.");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "Add audio files to corpus",
        multiple: true,
        filters: [{ name: "Audio", extensions: ["wav", "mp3", "aac", "ogg", "flac", "m4a"] }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked)
        ? picked.map((p) => typeof p === "string" ? p : (p as { path: string }).path)
        : [typeof picked === "string" ? picked : (picked as { path: string }).path];
      if (paths.length === 0) return;
      setImporting(true);
      setError(null);
      const result = await importAudioFilesIntoCorpus({
        libraryId: character.id,
        sourcePaths: paths,
      });
      await fetchEmotionCounts();
      onCorpusUpdated();
      const summary = result.skipped_count > 0
        ? `Imported ${result.copied_count} of ${paths.length} (${result.skipped_count} skipped). +${Math.round(result.total_duration_ms / 1000)}s of corpus audio.`
        : `Imported ${result.copied_count} files (+${Math.round(result.total_duration_ms / 1000)}s of corpus audio).`;
      window.alert(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk import failed");
    } finally {
      setImporting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id, projectId]);

  // Fetch per-emotion corpus counts on mount / when corpusCount changes
  const fetchEmotionCounts = useCallback(async () => {
    try {
      const counts = await invoke<EmotionCorpusCount[]>("get_corpus_emotion_counts", {
        projectId,
        characterId: character.id,
      });
      setEmotionCounts(counts);
    } catch {
      // Fail silently — not available until corpus commands are implemented
      setEmotionCounts([]);
    }
  }, [projectId, character.id]);

  useEffect(() => {
    fetchEmotionCounts();
  }, [fetchEmotionCounts, corpusCount]);

  // Poll for generation progress while a job is active
  useEffect(() => {
    if (!activeJobId) return;

    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        try {
          const status = await invoke<CorpusJobStatus>("get_corpus_job_status", {
            jobId: activeJobId,
          });

          if (cancelled) break;

          setGenerationProgress({ completed: status.completed, total: status.total });

          if (status.done) {
            setIsGenerating(false);
            setActiveJobId(null);
            onCorpusUpdated();
            if (status.error) setError(status.error);
            break;
          }
        } catch (e: unknown) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : "Lost contact with corpus job.");
            setIsGenerating(false);
            setActiveJobId(null);
          }
          break;
        }

        // Poll every 2 seconds
        await new Promise<void>((resolve) => { setTimeout(resolve, 2000); });
      }
    };

    poll();
    return () => { cancelled = true; };
  }, [activeJobId, onCorpusUpdated]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (isGenerating) return;
    setError(null);
    setIsGenerating(true);
    setGenerationProgress(null);

    try {
      const result = await invoke<BuildCorpusResult>("build_corpus", {
        projectId,
        characterId: character.id,
      });
      setGenerationProgress({ completed: 0, total: result.total });
      setActiveJobId(result.job_id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start corpus generation.");
      setIsGenerating(false);
    }
  }, [isGenerating, projectId, character.id]);

  const handleClear = useCallback(async () => {
    setConfirmClear(false);
    setError(null);
    try {
      await invoke("clear_corpus", { projectId, characterId: character.id });
      onCorpusUpdated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to clear corpus.");
    }
  }, [projectId, character.id, onCorpusUpdated]);

  // ── Derived values ────────────────────────────────────────────────────────

  const progressFraction = corpusCount / Math.max(1, corpusTarget);
  const genFraction = generationProgress
    ? generationProgress.completed / Math.max(1, generationProgress.total)
    : 0;
  const rColor = readinessColor(corpusDurationMs);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>

      {/* Description */}
      <p style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.7, marginBottom: 20 }}>
        The corpus is a set of {corpusTarget}+ short WAV files used to train {character.name}'s
        RVC voice model. Chatterbox generates each take with varied paralinguistic tags and emotions,
        giving the trainer enough vocal diversity to learn the character's fingerprint without
        overfitting to a single tone. More audio time (aim for 5+ minutes) consistently produces
        better models than raw take count alone.
      </p>

      {/* ── Overall progress ── */}
      <div style={{ marginBottom: 20 }}>
        <SectionTitle>Corpus progress</SectionTitle>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: "var(--fg-2)" }}>
            <strong style={{ fontSize: 18, fontFamily: "var(--font-mono)", color: "var(--fg-0)" }}>
              {corpusCount}
            </strong>
            {" / "}{corpusTarget} takes
          </span>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--fg-3)",
          }}>
            {formatDuration(corpusDurationMs)} recorded
          </span>
        </div>

        <ProgressBar value={progressFraction} color={STAGE_COLOR} height={7} />
      </div>

      {/* ── Readiness indicator ── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 20,
        padding: "8px 12px",
        background: `color-mix(in oklch, ${rColor} 8%, var(--bg-2))`,
        border: `1px solid color-mix(in oklch, ${rColor} 30%, var(--line-1))`,
        borderRadius: "var(--r)",
      }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: rColor,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 11, color: rColor, fontFamily: "var(--font-mono)" }}>
          {readinessLabel(corpusDurationMs)}
        </span>
        <span style={{ fontSize: 10, color: "var(--fg-4)", marginLeft: "auto" }}>
          {corpusDurationMs < DURATION_READY_MS
            ? `${formatDuration(DURATION_READY_MS - corpusDurationMs)} to go`
            : ""}
        </span>
      </div>

      {/* ── Per-emotion breakdown ── */}
      {emotionCounts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <SectionTitle>By emotion</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {emotionCounts.map(({ emotion, count }) => (
              <div key={emotion} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--fg-3)",
                  width: 90,
                  flexShrink: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {emotion}
                </span>
                <div style={{ flex: 1 }}>
                  <ProgressBar
                    value={count / Math.max(1, Math.ceil(corpusTarget / Math.max(1, emotionCounts.length)))}
                    color={STAGE_COLOR}
                    height={4}
                  />
                </div>
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--fg-4)",
                  width: 28,
                  textAlign: "right",
                  flexShrink: 0,
                }}>
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Paralinguistic tags ── */}
      <div style={{ marginBottom: 20 }}>
        <SectionTitle>Injected tags</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {PARALINGUISTIC_TAGS.map((tag) => (
            <TagChip key={tag} label={tag} />
          ))}
        </div>
        <p style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 7, lineHeight: 1.6 }}>
          These tags are randomly injected into corpus takes during generation to ensure
          the trained model preserves expressive vocal behaviours in production.
        </p>
      </div>

      {/* ── Generation progress ── */}
      {isGenerating && generationProgress && (
        <div style={{
          marginBottom: 16,
          padding: "10px 14px",
          background: `color-mix(in oklch, ${STAGE_COLOR} 8%, var(--bg-2))`,
          border: `1px solid color-mix(in oklch, ${STAGE_COLOR} 25%, var(--line-1))`,
          borderRadius: "var(--r)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: STAGE_COLOR, fontFamily: "var(--font-mono)" }}>
              Generating {generationProgress.completed} / {generationProgress.total} takes…
            </span>
            <span style={{ fontSize: 10, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
              running in background
            </span>
          </div>
          <ProgressBar value={genFraction} color={STAGE_COLOR} height={5} />
          <p style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 7, lineHeight: 1.5 }}>
            This takes 8–15 minutes. You can switch to other views — corpus generation
            continues in the background and this panel updates automatically.
          </p>
        </div>
      )}

      {/* ── Generating spinner (no count yet) ── */}
      {isGenerating && !generationProgress && (
        <div style={{
          marginBottom: 16,
          padding: "10px 14px",
          background: "var(--bg-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--r)",
          fontSize: 11,
          color: "var(--fg-3)",
          fontFamily: "var(--font-mono)",
        }}>
          Starting corpus generation…
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{
          marginBottom: 14,
          padding: "8px 12px",
          background: "color-mix(in oklch, var(--sfx) 8%, var(--bg-2))",
          border: "1px solid color-mix(in oklch, var(--sfx) 35%, var(--line-1))",
          borderRadius: "var(--r)",
          fontSize: 11,
          color: "var(--sfx)",
        }}>
          {error}
        </div>
      )}

      {/* ── Actions ── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn btn-primary"
          disabled={isGenerating || importing}
          onClick={handleGenerate}
          style={{
            background: STAGE_COLOR,
            borderColor: STAGE_COLOR,
            color: "var(--bg-0)",
            opacity: isGenerating ? 0.5 : 1,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.04em",
          }}
        >
          {isGenerating ? "Generating…" : corpusCount > 0 ? "Auto-Generate More" : "Auto-Generate Corpus"}
        </button>

        {projectId === "_library" && (
          <button
            className="btn btn-sm"
            disabled={isGenerating || importing}
            onClick={handleBulkImport}
            title="Add real audio files to the corpus (recordings of the actual voice actor — generally better RVC training data than Chatterbox-synthesized output)"
            style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
          >
            {importing ? "Importing…" : "Import audio files…"}
          </button>
        )}

        {corpusCount > 0 && !confirmClear && (
          <button
            className="btn btn-sm"
            disabled={isGenerating}
            onClick={() => setConfirmClear(true)}
            style={{
              color: "var(--sfx)",
              borderColor: "color-mix(in oklch, var(--sfx) 40%, var(--line-1))",
              background: "color-mix(in oklch, var(--sfx) 6%, transparent)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            Clear Corpus
          </button>
        )}

        {confirmClear && (
          <>
            <span style={{ fontSize: 11, color: "var(--sfx)", fontFamily: "var(--font-mono)" }}>
              Delete all {corpusCount} files?
            </span>
            <button
              className="btn btn-sm"
              onClick={handleClear}
              style={{
                background: "color-mix(in oklch, var(--sfx) 18%, transparent)",
                borderColor: "var(--sfx)",
                color: "var(--sfx)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
              }}
            >
              Yes, delete
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setConfirmClear(false)}
              style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {corpusCount === 0 && !isGenerating && (
        <p style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 8, lineHeight: 1.6 }}>
          Make sure you have approved palette entries before generating — each emotion
          needs at least one approved Chatterbox reference WAV.
        </p>
      )}
    </div>
  );
};
