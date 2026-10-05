# CorpusBuilder.tsx

## Purpose
Stage 3 of the character voice pipeline: build the RVC training corpus.

## Corpus from a dissected recording
- **Does**: For characters with Dissect provenance, "⤓ Use lines from the recording" (`corpus_from_dissect`) fills the corpus with the character's own clean lines — no cross-talk, 2.5–15 s, a recognisable tone — taken round-robin across emotions up to 5–30 minutes, as 48 kHz mono WAVs with `.meta.json` sidecars (duration, text, emotion, source span). The actor's real voice: better RVC training data than synthetic takes, and no generation.
- Per-emotion counts read a clip's sidecar `emotion` before falling back to the filename prefix.

## Notes
- The corpus is the character's real voice only: "Use lines from the recording" (characters made from a dissected recording) and "Import audio files" (Library). The old Chatterbox auto-generate path is gone.
- Errors from Tauri arrive as strings; the panel shows them instead of a generic "Failed to start".
