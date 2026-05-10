import React, { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, Icon, Wave, PeaksWave } from "./atoms";
import { PlayButton } from "./PlayButton";
import { useJobStore, takeKey } from "../../store/jobStore";
import { useProjectStore } from "../../store/projectStore";
import { useUiStore } from "../../store/uiStore";
import { useRegenerateStore } from "../../store/regenerateStore";
import { useToastStore } from "../../store/toastStore";
import {
  listGeneratedAudioAssets,
  readScript,
  readSidecar,
  updateScriptRow,
  updateSidecarQa,
} from "../../lib/tauriCommands";
import {
  ASSET_DRAG_MIME,
  ASSET_POINTER_DROP_EVENT,
  clearCurrentDraggedAsset,
  routeAudioToScene,
  SCRIPT_ASSETS_CHANGED_EVENT,
  setCurrentDraggedAsset,
  type DraggedAssetPayload,
  type RoutableAssetKind,
} from "../../lib/assetRouting";
import type { GeneratedAudioAsset, Job, MockAssets, QaJobStatus, ScriptRow } from "../../lib/types";

interface AssetBrowserProps {
  assets: MockAssets;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function truncate(text: string, maxChars = 100): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

const KIND_COLOR: Record<string, string> = {
  tts:   "var(--tts)",
  sfx:   "var(--sfx)",
  music: "var(--music)",
};

interface PersistentAsset {
  id: string;
  kind: RoutableAssetKind;
  audioPath: string;
  name: string;
  prompt: string;
  model: string;
  durationMs: number | null;
  qaStatus: QaJobStatus;
  rowIndex: number | null;
  track: string | null;
  character: string | null;
  active: boolean;
}

function kindFromRowType(type: ScriptRow["type"]): RoutableAssetKind | null {
  if (type === "DIALOGUE") return "tts";
  if (type === "SFX" || type === "BED") return "sfx";
  if (type === "MUSIC") return "music";
  return null;
}

function durationFromRow(row: ScriptRow): number | null {
  const parsed = Number(row.duration_ms);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function setAssetDragData(event: React.DragEvent, payload: DraggedAssetPayload): void {
  const serialized = JSON.stringify(payload);
  setCurrentDraggedAsset(payload);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(ASSET_DRAG_MIME, serialized);
  event.dataTransfer.setData("application/json", serialized);
  event.dataTransfer.setData("text/plain", serialized);
}

function beginAssetPointerDrag(event: React.PointerEvent, payload: DraggedAssetPayload): void {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, input, select, textarea, a")) return;

  setCurrentDraggedAsset(payload);

  const handlePointerUp = (upEvent: PointerEvent) => {
    window.dispatchEvent(new CustomEvent(ASSET_POINTER_DROP_EVENT, {
      detail: { asset: payload, clientX: upEvent.clientX, clientY: upEvent.clientY },
    }));
    clearCurrentDraggedAsset();
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerCancel);
  };
  const handlePointerCancel = () => {
    clearCurrentDraggedAsset();
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerCancel);
  };

  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
}

// ── Take group ─────────────────────────────────────────────────────────────

const QA_COLORS: Record<QaJobStatus, string> = {
  unreviewed: "var(--fg-4)",
  approved:   "var(--st-rendered)",
  rejected:   "var(--sfx)",
};

interface TakeGroupProps {
  jobs: Job[];            // all completed takes for one row, oldest-first
  activeJobId: string | null;
  scriptRows: ScriptRow[];
  onUse: (job: Job) => void;
  onQa: (job: Job, status: QaJobStatus) => void;
  onRegenerate: (job: Job) => void;
}

const TakeGroup: React.FC<TakeGroupProps> = ({ jobs, activeJobId, scriptRows, onUse, onQa, onRegenerate }) => {
  const color = KIND_COLOR[jobs[0].model] ?? "currentColor";
  return (
    <div style={{ borderBottom: "1px solid var(--line-1)" }}>
      {jobs.map((job, ti) => {
        const isActive = job.id === activeJobId;
        const qaColor = QA_COLORS[job.qa_status];
        const row = job.row_index != null ? scriptRows[job.row_index] : undefined;
        const sub = truncate(job.description);
        const kind = job.model as RoutableAssetKind;
        const dragPayload = job.output_path ? {
          kind,
          audioPath: job.output_path,
          label: basename(job.output_path),
          prompt: row?.prompt || job.description,
          durationMs: row ? durationFromRow(row) : null,
          track: row?.track ?? null,
          character: row?.character ?? null,
        } satisfies DraggedAssetPayload : null;
        return (
          <div
            key={job.id}
            className={`asset-row ${job.model}`}
            draggable={!!job.output_path}
            onDragStart={(event) => {
              if (!dragPayload) return;
              setAssetDragData(event, dragPayload);
            }}
            onPointerDown={(event) => dragPayload && beginAssetPointerDrag(event, dragPayload)}
            onDragEnd={clearCurrentDraggedAsset}
            style={{
              background: isActive ? `color-mix(in oklch, ${color} 8%, var(--bg-1))` : undefined,
              borderLeft: isActive ? `2px solid ${color}` : "2px solid transparent",
              cursor: job.output_path ? "grab" : undefined,
            }}
            onContextMenu={(e) => {
              // Right-click → regenerate with same params (reads sidecar)
              e.preventDefault();
              onRegenerate(job);
            }}
            title="Right-click to regenerate with same params"
          >
            <div className="swatch" />
            <div className="wave">
              {job.peaks ? (
                <PeaksWave peaks={job.peaks} width={120} height={24} color={color} opacity={0.85} />
              ) : (
                <Wave width={120} height={24} seed={job.id.charCodeAt(0) + job.id.charCodeAt(1)} count={28} color={color} opacity={0.7} />
              )}
            </div>
            <div className="meta">
              <span className="name" title={job.output_path ?? undefined}>
                take {ti + 1} · {basename(job.output_path!)}
              </span>
              <span className="sub" title={job.description}>{sub}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <PlayButton path={job.output_path} size={12} />
              {/* QA approve/reject */}
              <button
                className="btn btn-sm"
                style={{
                  padding: "2px 4px", minWidth: 0,
                  color: job.qa_status === "approved" ? "var(--st-rendered)" : "var(--fg-4)",
                  borderColor: job.qa_status === "approved" ? "var(--st-rendered)" : undefined,
                }}
                title="Approve take"
                onClick={() => onQa(job, job.qa_status === "approved" ? "unreviewed" : "approved")}
              >✓</button>
              <button
                className="btn btn-sm"
                style={{
                  padding: "2px 4px", minWidth: 0,
                  color: job.qa_status === "rejected" ? "var(--sfx)" : "var(--fg-4)",
                  borderColor: job.qa_status === "rejected" ? "var(--sfx)" : undefined,
                }}
                title="Reject take"
                onClick={() => onQa(job, job.qa_status === "rejected" ? "unreviewed" : "rejected")}
              >✕</button>
              {/* QA badge */}
              {job.qa_status !== "unreviewed" && (
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.06em",
                  color: qaColor, textTransform: "uppercase",
                }}>{job.qa_status}</span>
              )}
              {/* Use / using button */}
              <button
                className={`btn btn-sm${isActive ? " btn-primary" : ""}`}
                style={isActive ? { borderColor: color, color } : undefined}
                onClick={() => !isActive && onUse(job)}
                disabled={isActive}
              >
                {isActive ? "using" : "use"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

interface PersistentAssetRowProps {
  asset: PersistentAsset;
  onUse: (asset: PersistentAsset) => void;
  onQa: (asset: PersistentAsset, status: QaJobStatus) => void;
}

const PersistentAssetRow: React.FC<PersistentAssetRowProps> = ({ asset, onUse, onQa }) => {
  const color = KIND_COLOR[asset.kind] ?? "currentColor";
  const qaColor = QA_COLORS[asset.qaStatus];
  const sub = truncate(asset.prompt || asset.model);
  const dragPayload: DraggedAssetPayload = {
    kind: asset.kind,
    audioPath: asset.audioPath,
    label: asset.name,
    prompt: asset.prompt,
    durationMs: asset.durationMs,
    track: asset.track,
    character: asset.character,
  };
  return (
    <div
      className={`asset-row ${asset.kind}`}
      draggable
      onDragStart={(event) => setAssetDragData(event, dragPayload)}
      onPointerDown={(event) => beginAssetPointerDrag(event, dragPayload)}
      onDragEnd={clearCurrentDraggedAsset}
      style={{
        background: asset.active ? `color-mix(in oklch, ${color} 8%, var(--bg-1))` : undefined,
        borderLeft: asset.active ? `2px solid ${color}` : "2px solid transparent",
        cursor: "grab",
      }}
    >
      <div className="swatch" />
      <div className="wave">
        <Wave width={120} height={24} seed={asset.audioPath.charCodeAt(0) + asset.audioPath.length} count={28} color={color} opacity={0.7} />
      </div>
      <div className="meta">
        <span className="name" title={asset.audioPath}>
          {asset.active && asset.rowIndex != null ? `row ${asset.rowIndex + 1} · ` : ""}{asset.name}
        </span>
        <span className="sub" title={asset.prompt || asset.model}>{sub}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <PlayButton path={asset.audioPath} size={12} />
        <button
          className="btn btn-sm"
          style={{
            padding: "2px 4px", minWidth: 0,
            color: asset.qaStatus === "approved" ? "var(--st-rendered)" : "var(--fg-4)",
            borderColor: asset.qaStatus === "approved" ? "var(--st-rendered)" : undefined,
          }}
          title="Approve asset"
          onClick={() => onQa(asset, asset.qaStatus === "approved" ? "unreviewed" : "approved")}
        >✓</button>
        <button
          className="btn btn-sm"
          style={{
            padding: "2px 4px", minWidth: 0,
            color: asset.qaStatus === "rejected" ? "var(--sfx)" : "var(--fg-4)",
            borderColor: asset.qaStatus === "rejected" ? "var(--sfx)" : undefined,
          }}
          title="Reject asset"
          onClick={() => onQa(asset, asset.qaStatus === "rejected" ? "unreviewed" : "rejected")}
        >✕</button>
        {asset.qaStatus !== "unreviewed" && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.06em",
            color: qaColor, textTransform: "uppercase",
          }}>{asset.qaStatus}</span>
        )}
        <button
          className={`btn btn-sm${asset.active ? " btn-primary" : ""}`}
          style={asset.active ? { borderColor: color, color } : undefined}
          onClick={() => !asset.active && onUse(asset)}
          disabled={asset.active}
        >
          {asset.active ? "using" : "use"}
        </button>
      </div>
    </div>
  );
};

// ── Asset browser ─────────────────────────────────────────────────────────

export const AssetBrowser: React.FC<AssetBrowserProps> = ({ assets }) => {
  const { jobs, activeTakes, setActiveTake, setQaStatus } = useJobStore();
  const { realProjectId, activeSceneSlug } = useProjectStore();
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAudioAsset[]>([]);
  const [scriptRows, setScriptRows] = useState<ScriptRow[]>([]);

  const refreshPersistentAssets = useCallback(() => {
    if (!realProjectId || !activeSceneSlug) {
      setGeneratedAssets([]);
      setScriptRows([]);
      return;
    }
    Promise.all([
      listGeneratedAudioAssets(realProjectId),
      readScript({ projectId: realProjectId, sceneSlug: activeSceneSlug }),
    ])
      .then(([nextAssets, nextRows]) => {
        setGeneratedAssets(nextAssets);
        setScriptRows(nextRows);
      })
      .catch((error) => {
        console.error("[AssetBrowser] failed to refresh assets", error);
        setGeneratedAssets([]);
        setScriptRows([]);
      });
  }, [realProjectId, activeSceneSlug]);

  const completedJobsKey = useMemo(
    () => jobs
      .filter((job) => job.status === "complete" || job.status === "failed")
      .map((job) => `${job.id}:${job.status}:${job.output_path ?? ""}`)
      .join("|"),
    [jobs],
  );

  useEffect(refreshPersistentAssets, [refreshPersistentAssets, completedJobsKey]);

  useEffect(() => {
    window.addEventListener(SCRIPT_ASSETS_CHANGED_EVENT, refreshPersistentAssets);
    return () => window.removeEventListener(SCRIPT_ASSETS_CHANGED_EVENT, refreshPersistentAssets);
  }, [refreshPersistentAssets]);

  const completedByModel = (model: "tts" | "sfx" | "music") =>
    jobs.filter(j =>
      j.model === model
      && j.status === "complete"
      && j.output_path
      && j.scene_slug === activeSceneSlug
    );

  const completedOutputPaths = useMemo(
    () => new Set(jobs.filter((job) => job.status === "complete" && job.output_path).map((job) => job.output_path!)),
    [jobs],
  );

  const persistentAssets = useMemo(() => {
    const catalog = new Map(generatedAssets.map((asset) => [asset.audio_path, asset]));
    const assigned = scriptRows
      .map((row, index): PersistentAsset | null => {
        if (!row.file.trim()) return null;
        const kind = kindFromRowType(row.type);
        if (!kind) return null;
        const catalogAsset = catalog.get(row.file);
        return {
          id: `script:${index}:${row.file}`,
          kind,
          audioPath: row.file,
          name: catalogAsset?.name ?? basename(row.file),
          prompt: row.prompt || catalogAsset?.prompt || "",
          model: catalogAsset?.model ?? "assigned",
          durationMs: catalogAsset?.duration_ms ?? durationFromRow(row),
          qaStatus: catalogAsset?.qa_status ?? "unreviewed",
          rowIndex: index,
          track: row.track,
          character: row.character,
          active: true,
        };
      })
      .filter((asset): asset is PersistentAsset => !!asset);
    const assignedPaths = new Set(assigned.map((asset) => asset.audioPath));
    const localUnassigned = generatedAssets
      .filter((asset) =>
        asset.scene_slug === activeSceneSlug
        && !assignedPaths.has(asset.audio_path)
        && !completedOutputPaths.has(asset.audio_path)
      )
      .map((asset): PersistentAsset => ({
        id: `asset:${asset.audio_path}`,
        kind: asset.kind,
        audioPath: asset.audio_path,
        name: asset.name,
        prompt: asset.prompt,
        model: asset.model,
        durationMs: asset.duration_ms,
        qaStatus: asset.qa_status,
        rowIndex: null,
        track: null,
        character: null,
        active: false,
      }));
    return [...assigned, ...localUnassigned];
  }, [activeSceneSlug, completedOutputPaths, generatedAssets, scriptRows]);

  // Group completed jobs by "{scene_slug}:{row_index}", sort each group oldest-first
  function groupByRow(completed: Job[]): Map<string, Job[]> {
    const map = new Map<string, Job[]>();
    // Jobs are newest-first in the store; reverse so takes are oldest-first
    [...completed].reverse().forEach((j) => {
      if (j.scene_slug == null || j.row_index == null) return;
      const k = takeKey(j.scene_slug, j.row_index);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(j);
    });
    return map;
  }

  const handleQa = (job: Job, status: QaJobStatus) => {
    setQaStatus(job.id, status);
    if (job.output_path) {
      updateSidecarQa({
        audioPath: job.output_path,
        qaStatus: status,
        qaNotes: "",
      }).catch(console.error);
    }
  };

  const handleUse = (job: Job) => {
    if (!job.output_path || job.scene_slug == null || job.row_index == null) return;
    setActiveTake(job.scene_slug, job.row_index, job.id);
    if (realProjectId) {
      updateScriptRow({
        projectId: realProjectId,
        sceneSlug: job.scene_slug,
        rowIndex: job.row_index,
        fields: { file: job.output_path },
      }).catch(console.error);
    }
  };

  const handleUsePersistent = async (asset: PersistentAsset) => {
    if (!realProjectId || !activeSceneSlug || asset.active) return;
    try {
      await routeAudioToScene({
        projectId: realProjectId,
        sceneSlug: activeSceneSlug,
        kind: asset.kind,
        audioPath: asset.audioPath,
        durationMs: asset.durationMs,
      });
      refreshPersistentAssets();
    } catch (error) {
      pushToast({ kind: "error", title: `Could not send asset to scene: ${error}` });
    }
  };

  const handlePersistentQa = (asset: PersistentAsset, status: QaJobStatus) => {
    updateSidecarQa({
      audioPath: asset.audioPath,
      qaStatus: status,
      qaNotes: "",
    })
      .then(refreshPersistentAssets)
      .catch((error) => pushToast({ kind: "error", title: `QA update failed: ${error}` }));
  };

  // Read the sidecar for the asset and route the user to the matching
  // generator panel with the original params loaded. The panel watches
  // useRegenerateStore and hydrates its inputs.
  const setRegenerate = useRegenerateStore((s) => s.setPending);
  const setView = useUiStore((s) => s.setView);
  const pushToast = useToastStore((s) => s.push);
  const handleRegenerate = async (job: Job) => {
    if (!job.output_path) return;
    try {
      const meta = await readSidecar(job.output_path);
      if (!meta) {
        pushToast({ kind: "warn", title: "No sidecar — can't regenerate with same params" });
        return;
      }
      const model = job.model === "post" ? "tts" : job.model;
      setRegenerate({ model, meta, source_path: job.output_path });
      setView(model);
      pushToast({ kind: "info", title: `Regenerating with same params · ${model}` });
    } catch (e) {
      pushToast({ kind: "error", title: `Read sidecar failed: ${e}` });
    }
  };

  function renderSection(
    label: string,
    eyebrow: string,
    model: "tts" | "sfx" | "music",
    color: string,
    mockItems: typeof assets.dialogue,
    seed0: number,
    barCount: number,
  ) {
    const completed = completedByModel(model);
    const groups = groupByRow(completed);
    const persistent = persistentAssets.filter((asset) => asset.kind === model);
    const total = mockItems.length + completed.length + persistent.length;

    return (
      <>
        <div className="asset-group-head">
          <span>{label} · {total}</span>
          <span style={{ color: "var(--fg-4)" }}>{eyebrow}</span>
        </div>
        {total === 0 && (
          <EmptyState
            icon={model === "tts" ? "mic" : model === "sfx" ? "waves" : "music"}
            title={`No ${label.toLowerCase()} yet`}
            body={`Generated ${label.toLowerCase()} for this scene appears here.`}
            compact
          />
        )}
        {Array.from(groups.entries()).map(([key, groupJobs]) => (
          <TakeGroup
            key={key}
            jobs={groupJobs}
            activeJobId={activeTakes[key] ?? null}
            scriptRows={scriptRows}
            onUse={handleUse}
            onQa={handleQa}
            onRegenerate={handleRegenerate}
          />
        ))}
        {persistent.map((asset) => (
          <PersistentAssetRow
            key={asset.id}
            asset={asset}
            onUse={handleUsePersistent}
            onQa={handlePersistentQa}
          />
        ))}
        {mockItems.map((a, i) => (
          <div key={a.id} className={`asset-row ${a.kind}`}>
            <div className="swatch" />
            <div className="wave">
              {a.peaks ? (
                <PeaksWave peaks={a.peaks} width={120} height={24} color={color} opacity={0.85} />
              ) : (
                <Wave width={120} height={24} seed={i + seed0} count={barCount} color={color} opacity={0.7} />
              )}
            </div>
            <div className="meta">
              <span className="name">{a.name}</span>
              <span className="sub" title={a.sub}>{truncate(a.sub)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <PlayButton path={a.file_path} size={12} />
              <span className={`badge ${a.state}`}>{a.state}</span>
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <div>
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--line-1)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <Icon name="search" style={{ width: 14, height: 14, color: "var(--fg-3)" }} />
        <input
          className="input"
          style={{ background: "transparent", border: "none", padding: 0, fontSize: 12 }}
          placeholder="Search assets…"
        />
      </div>

      {renderSection("DIALOGUE", "elv·*",    "tts",   "var(--tts)",   assets.dialogue, 30, 28)}
      {renderSection("SFX",      "sfx-v3",   "sfx",   "var(--sfx)",   assets.sfx,      60, 32)}
      {renderSection("MUSIC",    "score-v2", "music", "var(--music)", assets.music,    90, 36)}
    </div>
  );
};
