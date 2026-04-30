import type {
  MockProject, MockCastMember, MockScene, MockTrack,
  MockAssets, AgentLogEntry, Job
} from "./types";

export const MOCK_PROJECT: MockProject = {
  title: "The Salt Path",
  subtitle: "Episode 03 · The Vault Beneath",
  logline: "After her brother's disappearance in the salt flats, a forensic linguist follows a trail of broken radio signals into a town that doesn't appear on any map.",
  season: "S01",
  episode: "E03",
  runtime: "32:14",
  genre: "Mystery / Folk Horror",
  creator: "M. Verheul",
  revision: "REV.07",
  lastSync: "2026-04-30 14:22",
};

export const MOCK_CAST: MockCastMember[] = [
  { id: "VERA",  name: "Vera Halloran",       voice: "elv·burnish-04", scenes: 9 },
  { id: "ABEL",  name: "Abel Reese",          voice: "elv·grain-11",   scenes: 6 },
  { id: "CONST", name: "Constance Mire",      voice: "elv·hollow-02",  scenes: 4 },
  { id: "RADIO", name: "Voice on the Radio",  voice: "elv·smoke-09",   scenes: 7 },
  { id: "NARR",  name: "Narrator",            voice: "elv·patina-01",  scenes: 12 },
];

export const MOCK_SCENES: MockScene[] = [
  {
    no: "S01", rev: "07", title: "The Switchback Road",
    desc: "Vera drives through fog. The car radio drifts between a hymn and a man counting backward in Dutch.",
    script: "INT. CAR — DUSK\n\nVERA, 38, drives. Headlights find the fog and stop. The radio drifts.\n\nVERA\n(quiet, to herself)\nThirty-six switchbacks. Abel said thirty-six.\n\nThe radio: a hymn, then a man counting backward in Dutch.\n\nRADIO (V.O.)\n…drie-en-veertig… twee-en-veertig…",
    status: "rendered", duration: "3:12", nodes: [{k:"tts",n:4},{k:"sfx",n:3},{k:"music",n:1}],
  },
  {
    no: "S02", rev: "07", title: "Salt Diner, 04:18",
    desc: "A diner kept open by one waitress. Coffee, jukebox, a stranger who knows Vera's name.",
    script: "INT. SALT DINER — 04:18\n\nA bell over the door. CONSTANCE, 60s, behind the counter.\n\nCONSTANCE\nYou'll want it black. We don't have anything else.",
    status: "rendered", duration: "5:48", nodes: [{k:"tts",n:6},{k:"sfx",n:4},{k:"music",n:0}],
  },
  {
    no: "S03", rev: "08", title: "Dispatch / Static",
    desc: "Constance reads aloud from her brother's last transmission. Tape hiss, partial words.",
    script: "INT. DINER — BACK ROOM\n\nA reel-to-reel. CONSTANCE threads tape with steady fingers.\n\nCONSTANCE\nHe was speaking, then he wasn't. Listen.",
    status: "ready", duration: "2:51", nodes: [{k:"tts",n:2},{k:"sfx",n:5},{k:"music",n:0}],
  },
  {
    no: "S04", rev: "08", title: "The Vault Beneath",
    desc: "Descent into the salt mine. Drips, distant generator, footsteps doubling back on themselves.",
    script: "INT. SALT MINE — DESCENDING\n\nVera's lamp finds carved walls. Footsteps double back.\n\nVERA\nIt can't go this deep.\n(beat)\nWho carved this?",
    status: "gen", duration: "6:04", nodes: [{k:"tts",n:4},{k:"sfx",n:5},{k:"music",n:3}],
  },
  {
    no: "S05", rev: "05", title: "Counting Backward",
    desc: "Vera meets the man on the radio. He has been speaking for forty-one years.",
    script: "INT. CHAMBER\n\nA figure at a desk, microphone, candle. ABEL.\n\nABEL\nForty-one years. They count the salt.",
    status: "draft", duration: "4:29", nodes: [{k:"tts",n:3},{k:"sfx",n:0},{k:"music",n:2}],
  },
  {
    no: "S06", rev: "03", title: "Surface, Dawn",
    desc: "Vera emerges. The town is gone. A child is waiting beside the car.",
    script: "EXT. SALT FLATS — DAWN\n\nThe town is gone. A CHILD waits by the car.",
    status: "draft", duration: "3:40", nodes: [{k:"tts",n:0},{k:"sfx",n:3},{k:"music",n:2}],
  },
];

export const MOCK_TRACKS: MockTrack[] = [
  { id: "VERA", kind: "dialogue", name: "VERA", clips: [
    { start: 4,   len: 12, label: "\"It can't go this deep.\"",        take: 3 },
    { start: 28,  len: 18, label: "\"Hand me the lamp.\"",             take: 1 },
    { start: 64,  len: 22, label: "\"Who carved this?\"",              take: 2 },
    { start: 122, len: 14, label: "\"Abel? Is that you?\"",            take: 1 },
  ]},
  { id: "ABEL", kind: "dialogue", name: "ABEL", clips: [
    { start: 88,  len: 28, label: "\"Don't say my name down here.\"",  take: 4 },
    { start: 148, len: 26, label: "\"They count the salt, Vera.\"",    take: 2 },
  ]},
  { id: "FOLEY", kind: "sfx", name: "FOLEY", clips: [
    { start: 0,   len: 18, label: "footsteps · gravel slope",          take: 1 },
    { start: 22,  len: 16, label: "lamp click · metal",                take: 1 },
    { start: 50,  len: 30, label: "footsteps · echo chamber",          take: 2 },
    { start: 96,  len: 24, label: "rope creak · descent",              take: 1 },
    { start: 132, len: 20, label: "drip · slow",                       take: 1 },
    { start: 158, len: 18, label: "footsteps · doubling",              take: 3 },
  ]},
  { id: "BED", kind: "bed", name: "AMBIENT", clips: [
    { start: 0,  len: 90, label: "salt mine · room tone",              take: 1 },
    { start: 90, len: 90, label: "vault chamber · low rumble",         take: 1 },
  ]},
  { id: "MUSIC", kind: "music", name: "SCORE", clips: [
    { start: 0,   len: 64, label: "Cue 4A · Descent (3:04)",           take: 2 },
    { start: 76,  len: 60, label: "Cue 4B · Salt Hymn (2:48)",         take: 1 },
    { start: 142, len: 38, label: "Cue 4C · Counting (1:36)",          take: 1 },
  ]},
];

export const MOCK_ASSETS: MockAssets = {
  dialogue: [
    { id: "a01", kind: "tts", scene: "S04", name: "\"It can't go this deep.\"",          sub: "VERA · take 3 · 0:12 · elv·burnish-04", state: "resolved", file_path: null, peaks: null },
    { id: "a02", kind: "tts", scene: "S04", name: "\"Hand me the lamp.\"",                sub: "VERA · take 1 · 0:18 · elv·burnish-04", state: "resolved", file_path: null, peaks: null },
    { id: "a03", kind: "tts", scene: "S04", name: "\"Don't say my name down here.\"",     sub: "ABEL · take 4 · 0:28 · elv·grain-11",   state: "resolved", file_path: null, peaks: null },
    { id: "a04", kind: "tts", scene: "S04", name: "\"Who carved this?\"",                 sub: "VERA · take 2 · 0:22 · elv·burnish-04", state: "gen",      file_path: null, peaks: null },
    { id: "a05", kind: "tts", scene: "S02", name: "\"Black. We don't have anything else.\"", sub: "CONST · take 2 · 0:11 · elv·hollow-02", state: "resolved", file_path: null, peaks: null },
    { id: "a06", kind: "tts", scene: "S01", name: "\"Thirty-six switchbacks.\"",           sub: "VERA · take 1 · 0:09 · elv·burnish-04", state: "resolved", file_path: null, peaks: null },
  ],
  sfx: [
    { id: "s01", kind: "sfx", scene: "S04", name: "footsteps · gravel slope",   sub: "0:18 · sfx-v3 · seed 4412", state: "resolved", file_path: null, peaks: null },
    { id: "s02", kind: "sfx", scene: "S04", name: "lamp click · metal",         sub: "0:02 · sfx-v3 · seed 9981", state: "resolved", file_path: null, peaks: null },
    { id: "s03", kind: "sfx", scene: "S04", name: "rope creak · descent",       sub: "0:24 · library · foley-18", state: "resolved", file_path: null, peaks: null },
    { id: "s04", kind: "sfx", scene: "S04", name: "drip · slow",                sub: "0:20 · sfx-v3 · seed 0207", state: "resolved", file_path: null, peaks: null },
    { id: "s05", kind: "sfx", scene: "S04", name: "footsteps · doubling",       sub: "0:18 · sfx-v3 · seed 1188", state: "gen",      file_path: null, peaks: null },
    { id: "s06", kind: "sfx", scene: "S01", name: "fog · windscreen wipers",    sub: "0:32 · library · foley-04", state: "resolved", file_path: null, peaks: null },
    { id: "s07", kind: "sfx", scene: "S03", name: "reel-to-reel · threading",   sub: "0:14 · sfx-v3 · seed 2201", state: "resolved", file_path: null, peaks: null },
  ],
  music: [
    { id: "m01", kind: "music", scene: "S04", name: "Cue 4A · Descent",            sub: "3:04 · score-v2 · key Dm", state: "resolved", file_path: null, peaks: null },
    { id: "m02", kind: "music", scene: "S04", name: "Cue 4B · Salt Hymn",          sub: "2:48 · score-v2 · key Gm", state: "resolved", file_path: null, peaks: null },
    { id: "m03", kind: "music", scene: "S04", name: "Cue 4C · Counting Backward",  sub: "1:36 · score-v2 · key Am", state: "gen",      file_path: null, peaks: null },
    { id: "m04", kind: "music", scene: "S01", name: "Cue 1A · Switchback",         sub: "0:48 · score-v2 · key Dm", state: "resolved", file_path: null, peaks: null },
  ],
};

export const MOCK_JOBS: Job[] = [
  { id: "j1", model: "tts",   description: "VERA · S04 · \"Who carved this?\" — take 2",         status: "complete", progress: 100, eta: "done",   started_at: "14:21", scene_id: null, scene_slug: "04_the_vault_beneath", row_index: 2, output_path: null, peaks: null, error: null },
  { id: "j2", model: "sfx",   description: "footsteps doubling · echo chamber · 18s",            status: "running",  progress: 64,  eta: "12s",    started_at: "14:22", scene_id: null, scene_slug: "04_the_vault_beneath", row_index: 5, output_path: null, peaks: null, error: null },
  { id: "j3", model: "music", description: "Cue 4C · Counting Backward · 1:36 · variation 3",    status: "running",  progress: 22,  eta: "1m 40s", started_at: "14:22", scene_id: null, scene_slug: "04_the_vault_beneath", row_index: 7, output_path: null, peaks: null, error: null },
  { id: "j4", model: "tts",   description: "ABEL · S05 · \"Forty-one years\" — take 1",          status: "pending",  progress: 0,   eta: "queued", started_at: "—",     scene_id: null, scene_slug: "05_counting_backward",  row_index: 0, output_path: null, peaks: null, error: null },
  { id: "j5", model: "sfx",   description: "wind · salt flat · 0:42",                            status: "pending",  progress: 0,   eta: "queued", started_at: "—",     scene_id: null, scene_slug: "06_surface_dawn",       row_index: 1, output_path: null, peaks: null, error: null },
];

export const MOCK_AGENT_LOG: AgentLogEntry[] = [
  { who: "Pharaoh · Mixer",      body: "Auto-balanced VERA dialogue against AMBIENT bed in S04 (−3.2 LU). Two clips clipping; applied soft limiter.", t: "14:21" },
  { who: "Pharaoh · Director",   body: "Scene S05 reads as too static. Suggesting an inhale before \"forty-one years.\" Apply?", t: "14:18" },
  { who: "Pharaoh · Foley",      body: "Generated 'footsteps · doubling' at seed 1188. Compared to Take 1 — recommends Take 3 for the doubled-back walk pattern.", t: "14:15" },
  { who: "Pharaoh · Score",      body: "Cue 4C drafted in Am. Adjusting tempo to 64 BPM to land final beat on Vera's last line.", t: "14:11" },
  { who: "Pharaoh · Continuity", body: "Dropped consonant on ABEL · S04 take 1 (0:08). Re-rendered as take 4. Replacing in timeline.", t: "14:04" },
];
