import { readScript, updateScriptRow } from "./tauriCommands";
import type { TrackType } from "./types";

export type RoutableAssetKind = "tts" | "sfx" | "music";

export const SCRIPT_ASSETS_CHANGED_EVENT = "pharaoh:script-assets-changed";
export const ASSET_DRAG_MIME = "application/x-pharaoh-asset";
export const ASSET_POINTER_DROP_EVENT = "pharaoh:asset-pointer-drop";

export interface DraggedAssetPayload {
  kind: RoutableAssetKind;
  audioPath: string;
  label: string;
  prompt?: string;
  durationMs?: number | null;
  track?: string | null;
  character?: string | null;
}

export interface AssetPointerDropDetail {
  asset: DraggedAssetPayload;
  clientX: number;
  clientY: number;
}

let currentDraggedAsset: DraggedAssetPayload | null = null;

export function setCurrentDraggedAsset(asset: DraggedAssetPayload): void {
  currentDraggedAsset = asset;
}

export function getCurrentDraggedAsset(): DraggedAssetPayload | null {
  return currentDraggedAsset;
}

export function clearCurrentDraggedAsset(): void {
  currentDraggedAsset = null;
}

const ROW_TYPES_BY_KIND: Record<RoutableAssetKind, TrackType[]> = {
  tts: ["DIALOGUE"],
  sfx: ["SFX", "BED"],
  music: ["MUSIC"],
};

export async function routeAudioToScene(args: {
  projectId: string;
  sceneSlug: string;
  kind: RoutableAssetKind;
  audioPath: string;
  durationMs?: number | null;
}): Promise<{ rowIndex: number; replaced: boolean }> {
  const rows = await readScript({ projectId: args.projectId, sceneSlug: args.sceneSlug });
  const allowedTypes = ROW_TYPES_BY_KIND[args.kind];
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => allowedTypes.includes(row.type));
  const target = candidates.find(({ row }) => !row.file.trim()) ?? candidates[0];
  if (!target) {
    throw new Error(`selected scene has no ${allowedTypes.join("/")} rows`);
  }

  const replaced = target.row.file.trim().length > 0 && target.row.file !== args.audioPath;
  const fields: Record<string, string> = { file: args.audioPath };
  if (args.durationMs != null) fields.duration_ms = String(args.durationMs);

  await updateScriptRow({
    projectId: args.projectId,
    sceneSlug: args.sceneSlug,
    rowIndex: target.index,
    fields,
  });

  window.dispatchEvent(new CustomEvent(SCRIPT_ASSETS_CHANGED_EVENT, {
    detail: { projectId: args.projectId, sceneSlug: args.sceneSlug, rowIndex: target.index },
  }));

  return { rowIndex: target.index, replaced };
}
