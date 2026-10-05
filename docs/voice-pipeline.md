# Pharaoh Character Voice Pipeline

How a character's voice is built and how each script line is voiced.

The normal path is short: Breeze TTS 2 clones the character's reference and
performs each line's direction. Voice lock (RVC) is an optional extra step for
characters whose calm lines should sound closer to a real recording.

---

## Pipeline overview

```
STAGE 1 — VOICE
  A gold reference clip: a real line from a dissected recording, or a
  voice-design take. Its transcript must match it (Breeze checks and fixes it
  with Whisper).

       ↓

STAGE 2 — EMOTIONAL PALETTE
  Named emotional states, each with a written direction and (ideally) a real
  reference line in that mood. A dissected recording fills this from
  emotion2vec scores ("Build from recording").

       ↓

PRODUCTION (every dialogue line)
  1. Breeze clones the palette emotion's reference (or the gold clip) and
     performs the line's direction plus the emotion's direction.
     Vocal events in parentheses — (laughs), (sighs) — are performed, not read.
  2. Voice lock, if on: calm lines pass through the character's RVC model.
  3. AudioSR, if on: the take is cleaned up (speech model).

OPTIONAL — VOICE LOCK (Corpus → Model, folded away in the UI)
  Corpus: the character's own clean lines from the dissected recording
          ("Use lines from the recording"), at least 5 minutes.
  Model:  RVC trained on that corpus (~20–30 min on the GPU box).
```

Without Breeze installed, Qwen3-TTS serves the TTS port and clones the voice
(it doesn't perform direction); voice lock runs after either.

---

## When voice lock helps

A blind test on 2026-10-04 compared one Breeze take of five Dumbledore lines
against the same take run through RVC trained on 15 minutes of his real lines.
Ratings were out of 5: likeness first, then delivery.

| Line | Breeze alone | RVC 0.35 | RVC 0.5 |
|---|---|---|---|
| neutral | 2 / 2 | 5 / 4 | 4 / 4 |
| angry | 3 / 4 | 3 / 3 | 2 / 3 |
| laugh | 3 / 5 | 3 / 3 | 3 / 4 |
| sigh | 2 / 5 | 2 / 3 | 3 / 4 |
| whisper | 3 / 5 | 4 / 2 | 4 / 4 |

The lock made the voice more like the character (TitaNet likeness 0.67 → 0.74).
It also flattened expressive deliveries: RVC re-voices everything, so whispers
lose their air, sighs lose their breath, and anger loses its edge.

Hence the defaults:

- **Calm lines only.** Lines whose text has vocal events, or whose text or
  direction mentions whispering, sighing, laughing, crying, shouting or fear,
  keep Breeze's take. "Every line" is available on the Model tab.
- **Index rate 0.5.** It sounded as much like the character as 0.35 and kept
  delivery better. This is the opposite of the older advice to lower the index
  rate to protect sighs.

---

## Parameters

| Setting | Default | Notes |
|---|---|---|
| Voice lock | off | Switched on automatically when a model finishes training. |
| Apply to | calm lines | `rvc.lock_lines`: `"calm"` or `"all"`. |
| Index rate | 0.5 | How hard takes are pulled toward the trained voice. |
| Protect | 0.33 | Shields voiceless consonants (t, s, k, f); raise if sibilants smear. |
| Pitch shift | 0 | Semitones. |

---

## File layout

```
characters/{character_id}/
  imports/                      ← real reference lines from a dissected recording
  palette/                      ← palette references and takes
  rvc_corpus/                   ← voice-lock training lines (optional)
  rvc/
    {name}.pth                  ← trained RVC model
    {name}.index                ← FAISS retrieval index
    {name}.server.json          ← where the RVC server keeps its copy (remote)
scenes/{scene}/assets/
  {char}_{ts}.wav               ← Breeze take
  {char}_{ts}.lock.wav          ← voice-locked take (bound to the row when made)
```

With a remote RVC server, training uploads the corpus and `finish_rvc_train`
downloads the model into `rvc/`. Conversion uploads the model once if the
server doesn't have it, for example after importing a character.

---

## CLI

`pharaoh generate row|all scene …` applies the same chain: Breeze, then the
voice lock on calm lines when the character has it on. The take's sidecar notes
`voice lock (RVC, index 0.50)`. If the lock fails, the Breeze take is kept and a
warning is printed.

The MCP `train_rvc_model` / `rvc_convert` tools still assume the RVC server
shares this machine's filesystem.
