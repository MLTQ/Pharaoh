# dissect_emotion.py

## Purpose
Emotion tags for dissected dialogue, so a character's palette can use real moments from the recording (a genuinely angry line, a frightened one) as clone references. Chatterbox copies a reference's delivery as much as its voice.

## Components

### `utterances(turns)`
- **Does**: Joins consecutive same-speaker turns (pause ≤ 0.6 s) into utterances of up to 12 s, splits longer turns evenly, drops fragments under 1 s, and carries the overlap flag.
- **Rationale**: Diarization turns are short (median ~2 s); clone references and emotion classification both want a few seconds.

### `EmotionTagger`
- **Does**: emotion2vec+ large through FunASR (`emotion2vec/emotion2vec_plus_large`); utterance-level scores over angry, disgusted, fearful, happy, neutral, sad, surprised ("other" and "<unk>" dropped). ~10 ms per utterance on a 4090.

### `tag` / `result` / `tag_file`
- **Does**: Scores utterances in batches of 32, adding `scores` and the top `emotion`. `tag_file` reads a 16 kHz mono file by seeking (the standalone `/generate/emotions` path).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `dissect_pipeline.run` | Writes `emotions.json` beside the manifest (`manifest.emotions`); never fatal | Raising instead of warning |
| `commands/emotions.rs` | `{model, labels, utterances:[{speaker,start,end,text,overlap,scores,emotion}]}` | Renaming fields or classes |

## Notes
- *Goblet of Fire* (20 h): 13,750 utterances tagged in ~3.5 min including the upload.
