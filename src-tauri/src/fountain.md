# `fountain.rs` — Rust-side Fountain parser (CLI import)

## Intent

A scene-aware Fountain parser used by `pharaoh script import`. The browser-side
parser in `src/lib/fountain.ts` stays the canonical implementation for the
editor (round-trip with stable IDs across edits). This Rust version exists
because the CLI is a Rust binary and import is a one-shot, fresh-write
operation — round-trip semantics aren't needed.

## What it does that the TS version doesn't

- **Scene splitting**: tracks `INT./EXT./EST./.HEADING` lines as scene
  boundaries and emits one `ParsedScene` per heading. Each scene carries the
  blocks that fall under it.
- **Title page harvesting**: extracts `Title:` and `Author:` from the optional
  Fountain title page and skips it. Title isn't applied to the project
  automatically — the user already named the project; we just surface it in
  the import summary.
- **Location inference**: parses headings like `INT. MIRA'S APARTMENT - NIGHT`
  into `(title="Mira's Apartment", location="interior, night, mira's apartment")`.
  The location string lands in the new `Scene.location` field.

## What it shares with `fountain.ts`

- Same character-cue rule (ALL CAPS, optional `(V.O.)`/`(O.S.)` suffix).
- Same `SFX:` / `BED:` / `MUSIC:` audio-drama extension.
- Parenthetical lines → `Block.parenthetical`, which lands in `ScriptRow.instruct`.
- Stable `id:r-xxxxxx` token written into `ScriptRow.notes` so future round-trips
  through the editor keep block identity.

## Contract

```rust
parse_document(text: &str) -> ParsedDocument
blocks_to_rows(blocks, scene_no, character_id_for_name) -> Vec<ScriptRow>
```

`character_id_for_name` is supplied by the caller — `cli::script_import` looks
up existing characters by name (case-insensitive), creates IDs for new ones,
and threads that map into the compilation step so DIALOGUE rows land with the
right character ID.

## What this is not

- Not a full Fountain implementation: title-page-only directives like
  `Notes:` / `Draft date:`, dual dialogue, transitions (`>FADE TO:`), centered
  text, and explicit scene numbers are not supported. We can extend if a
  user's import needs them.
- Not used by the editor — the editor uses `fountain.ts` and runs in the browser.
