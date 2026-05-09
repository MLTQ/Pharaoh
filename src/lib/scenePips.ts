// Aggregate per-channel asset state for scene plate pips.
//
// Hollow ring under a scene plate = scripted but unplaced (`file` or
// `start_ms` empty). Filled square = on the timeline.
//
// `BED` rows are grouped under the SFX channel — the data model treats them
// as ambience, the UI uses one pip color for both.

import type { ScriptRow } from "./types";

export interface ChannelCounts { planned: number; placed: number }
export interface ScenePips { tts: ChannelCounts; sfx: ChannelCounts; music: ChannelCounts }

export function emptyPips(): ScenePips {
  return {
    tts:   { planned: 0, placed: 0 },
    sfx:   { planned: 0, placed: 0 },
    music: { planned: 0, placed: 0 },
  };
}

export function rowsToPips(rows: ScriptRow[]): ScenePips {
  const out = emptyPips();
  for (const r of rows) {
    const t = r.type.toUpperCase();
    if (t === "DIRECTION") continue;
    const placed = r.file !== "" && r.start_ms !== "";
    const channel: keyof ScenePips =
      t === "DIALOGUE" ? "tts" :
      t === "MUSIC"    ? "music" :
      "sfx"; // SFX, BED, anything else
    if (placed) out[channel].placed++;
    else out[channel].planned++;
  }
  return out;
}
