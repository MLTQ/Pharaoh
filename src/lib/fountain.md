# `fountain.ts` — Fountain ⇄ ScriptRow round-trip

## Intent

Provide a **prose source of truth** for scene authoring while keeping `script.csv`
as the canonical compile target the audio pipeline operates on. The user writes
in Fountain (a plain-text screenplay format extended for audio drama). We parse
that into `FountainBlock[]`, then compile to `ScriptRow[]` while preserving any
audio metadata already attached to matching rows.

## Why Fountain

- It's the de-facto plain-text screenplay format. Existing screenwriting tools
  (Highland 2, Slugline, Final Draft) round-trip it.
- LLM agents draft cleanly into it without escaping headaches.
- It maps almost 1:1 onto our existing audio-event row model: each block becomes
  a row.

## Audio-drama extensions to base Fountain

| Syntax | Maps to | Notes |
|--------|---------|-------|
| `INT./EXT./EST.` line | (metadata, not a row) | scene heading, ignored |
| `ALL CAPS` line + dialogue lines | `DIALOGUE` row | character on its own line |
| `(text)` immediately after CHARACTER | appended to `instruct` | parenthetical / delivery note |
| `SFX: …` | `SFX` row | foley / spot effect |
| `BED: …` | `BED` row, `loop=true` | continuous ambience |
| `MUSIC: …` | `MUSIC` row | score cue |
| any other line | `DIRECTION` row | stage direction |

## Stable IDs

Each row is round-trip-keyed by an `id:r-xxxxxx` token in the `notes` field.
On parse, blocks without an ID get a fresh one; on compile, we carry forward
`file`/`start_ms`/`duration_ms`/etc. from the matching prior row. This means
**editing prose never destroys timeline placements**.

## Contract

```ts
parseFountain(text: string): FountainBlock[]
serializeFountain(blocks: FountainBlock[]): string  // includes id tags
compileBlocksToRows(blocks, sceneNo, characters, existing): ScriptRow[]
rowsToBlocks(rows, characters): FountainBlock[]
```

`compileBlocksToRows` is the merge step — call this whenever blocks change,
pass the existing rows so audio metadata survives.

## What this is not

- Not a full Fountain implementation: title pages, transitions, dual dialogue,
  centered text are all skipped. We support what an audio drama needs.
- Not a sync mechanism: callers debounce writes themselves.
