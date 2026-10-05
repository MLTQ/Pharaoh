# dissect_emotion.py

## Purpose
Emotion tags for dissected dialogue, so a character's palette can use real moments from the recording (a genuinely angry line, a frightened one) as clone references. A clone copies a reference's delivery as much as its voice.

## Components

### `utterances(turns)`
- **Does**: Joins consecutive same-speaker turns (pause ≤ 0.6 s) into utterances of up to 12 s, splits longer turns evenly, drops fragments under 1 s, and carries the overlap flag.
- **Rationale**: Diarization turns are short (median ~2 s); clone references and emotion classification both want a few seconds.

### `prosody` / `speaking_rate` / `syllables`
- **Does**: Per utterance: `loud_db` (RMS of active frames), `f0_hz` / `f0_var` (yin pitch median and semitone std), `flat` (spectral flatness — breathy/whispered), `voiced`, and `rate` (syllables per second of actual speech from the word timings; pauses past 0.25 s don't count).
- **Rationale**: The seven classes can't tell tender from happy or furious from annoyed; delivery can. Compared per character in `commands/emotions.rs` (z-scores), since a mix's levels and a voice's pitch are its own.

### `EmotionTagger`
- **Does**: emotion2vec+ large through FunASR (`emotion2vec/emotion2vec_plus_large`); utterance-level scores over angry, disgusted, fearful, happy, neutral, sad, surprised ("other" and "<unk>" dropped, so the seven can sum well under 1 — the reader couldn't tell) and the L2-normalised 1024-d embedding, written as `emotion_vecs.f16` (N × 1024 float16, utterance order) for "more like this".

### `tag` / `result` / `tag_file`
- **Does**: Scores utterances in batches of 32, adding `scores` and the top `emotion`. `tag_file` reads a 16 kHz mono file by seeking (the standalone `/generate/emotions` path).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `dissect_pipeline.run` | Writes `emotions.json` beside the manifest (`manifest.emotions`); never fatal | Raising instead of warning |
| `commands/emotions.rs` | `{model, version: 2, labels, vectors, embedding_dim, utterances:[{speaker,start,end,text,overlap,scores,emotion,rate,loud_db,f0_hz,f0_var,flat,voiced}]}` + `emotion_vecs.f16` in utterance order | Renaming fields or classes; reordering vectors |

## Notes
- *Goblet of Fire* (20 h): 13,750 utterances tagged in ~3.5 min including the upload.
