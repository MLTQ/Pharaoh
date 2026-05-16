# Pharaoh Character Voice Pipeline

This document describes the four-stage process for building a production-ready
character voice in Pharaoh. The pipeline is designed to solve two competing
problems in AI voice synthesis:

- **Identity consistency** — the same character should sound like the same
  person on every line, in every scene, regardless of emotional state or line
  length.
- **Performance naturalness** — dialogue needs to feel like a real performance:
  varied breath patterns, paralinguistic events ([sigh], [chuckle], [laugh]),
  prosody that serves the scene.

No single model does both well. Pharaoh chains four stages so each one can
focus on what it does best.

---

## Pipeline overview

```
STAGE 1 — VOICE DESIGN
  Author a text description of the character's vocal identity.
  Qwen3 VoiceDesign synthesises test takes from that description.
  Goal: lock a compelling voice persona.

       ↓

STAGE 2 — EMOTIONAL PALETTE
  Define 2–5 named emotional states (neutral, tense, sardonic, broken, …).
  Each state gets its own Qwen3 take, conditioned on the base description
  plus a short emotional direction ("Flat, controlled fear. Each word measured.").
  Approve one reference WAV per state.
  Goal: capture how this character sounds across their emotional range.

       ↓ AudioSR (24 kHz → 48 kHz) applied to each palette reference

STAGE 3 — CHATTERBOX CORPUS
  Chatterbox Turbo clones each palette reference and generates 50–100 takes
  of the test line with varied paralinguistic tags:
    [sigh], [chuckle], [laugh], [gasp], [clears throat], [hmm], …
  These are NOT production lines — they are training data.
  Goal: a diverse corpus of the character's voice performing naturally,
  with tags intact, consistent timbre (from the palette refs), and varied
  prosodic texture.

       ↓ AudioSR on each corpus WAV

STAGE 4 — RVC MODEL TRAINING
  RVC (Retrieval-based Voice Conversion) trains on the Chatterbox corpus.
  Because all training data came from the same Chatterbox voice, RVC learns
  to normalise Chatterbox's own output — tightening consistency without
  needing a human recording session.

  Output: characters/{id}/rvc/{name}.pth + {name}.index

       ↓

PRODUCTION (every script line)
  1. Chatterbox clones from the matching palette reference
     (emotion column selects which state)
  2. Inline [tags] in the prompt text shape the performance
  3. AudioSR upsamples to 48 kHz
  4. RVC convert → final WAV

  Result: natural performance (from Chatterbox + tags) in a consistent
  voice (from RVC trained on Chatterbox's own output).
```

---

## Why this architecture

### Why not just use Chatterbox alone?

Chatterbox 0-shot cloning is excellent but drifts across a long production:
- Long lines and unusual prosody patterns push away from the reference timbre
- Emotional extremes (very quiet, very tense) drift more than neutral speech
- Different runs of the same line can have audible voice-texture differences

For a short demo this is acceptable. For a full audio drama episode, the same
character needs to sound identical in scene 1 and scene 8.

### Why train RVC on synthetic data instead of real recordings?

The traditional RVC workflow trains on human recordings. That works well but
requires a recording session (15–30 min of clean audio) for every character.

By training on Chatterbox's own output:
- No recording session needed
- The corpus is automatically diverse (varied tags, varied prosody)
- RVC is calibrated exactly to Chatterbox's voice space for this character
- The paralinguistic tags survive because RVC is converting Chatterbox
  output → more-consistent-Chatterbox-output, not human → Chatterbox

The trade-off: you cannot use a real voice actor's recordings as the source.
If you have a voice actor, the recommended path is: record them → use their
recordings as palette references → Chatterbox clones from real voice →
RVC trained on those clones. The pipeline is identical; the palette refs
are just real recordings instead of Qwen3 output.

### Why AudioSR between stages?

Qwen3 and Chatterbox both output at 24 kHz. When a 24 kHz Chatterbox output
is used as a clone reference for the next Chatterbox call, high-frequency
information is missing from the conditioning signal, which can cause the
output to sound slightly muffled.

AudioSR (audio super-resolution) fills in the 12–24 kHz band using a
diffusion model. This is not upsampling via interpolation — it generates
plausible high-frequency content conditioned on the low-frequency signal.
The improvement is most audible on sibilants (s, sh, f) and the "air" of
breath sounds.

AudioSR runs on the post-server (port 18004). It is optional; the pipeline
degrades gracefully if it is not running.

### RVC parameters and paralinguistic tags

The key parameter for preserving tags is **index_rate** (0–1):

| index_rate | Behaviour |
|---|---|
| 0.0 | No retrieval; only the model's pitch conversion. |
| 0.3 | Light timbre tint. Tags mostly intact. Slight voice drift. |
| 0.5 | **Default.** Balanced for Chatterbox-sourced corpora. |
| 0.75 | Strong identity enforcement. Some tag degradation. |
| 1.0 | Maximum consistency. [sigh] breath quality may be lost. |

For production, `0.5` is the recommended starting point. If sighs or whispers
sound unnatural, drop to `0.35`. If consecutive scenes have noticeable voice
drift, raise to `0.65`.

The **protect** parameter (0–0.5) shields voiceless consonants (t, s, k, f)
from conversion. The default `0.33` prevents lisping on most voices; raise it
if you hear sibilant distortion.

---

## File layout

```
projects/{project_id}/
  characters/{character_id}/
    palette/
      neutral_0_1747000000.wav          ← Qwen3 VoiceDesign output
      neutral_0_1747000000.wav.meta.json
      neutral_rec_1747000001.wav        ← optional: directly recorded takes
      tense_7_1747000002.wav
      tense_7_1747000002.wav.meta.json
      ...
    rvc_corpus/
      neutral_0.wav                     ← Chatterbox takes for training
      neutral_0.wav.meta.json
      neutral_1.wav
      tense_0.wav
      tense_0.wav.meta.json
      ...  (50–100 files total)
    rvc/
      jack_rourke.pth                   ← trained RVC model (~80 MB)
      jack_rourke.index                 ← FAISS retrieval index (~8 MB)
```

---

## MCP agent workflow

The full pipeline can be driven by the MCP agent without opening the GUI:

```python
# 1. Check character status
corpus_status(project_id="...", character_id="jack_rourke")

# 2. Build corpus (runs in background, ~8 min)
build_corpus(project_id="...", character_id="jack_rourke", target_count=60)
# Returns a list of job_ids. Poll each with job_status(job_id).

# 3. Train model (runs in background, ~15 min on GPU)
train_rvc_model(project_id="...", character_id="jack_rourke")

# 4. Test the full pipeline on a sample line
rvc_convert(
    project_id="...",
    character_id="jack_rourke",
    input_path="/path/to/chatterbox_take.wav",
    output_path="/path/to/rvc_output.wav",
)

# 5. Generate production lines (generate_tts now routes through RVC automatically)
generate_tts(project_id="...", scene_slug="01_the_archive", row_index=3)
```

---

## Corpus quality guidelines

| Metric | Minimum | Recommended |
|---|---|---|
| Total WAV files | 20 | 50–100 |
| Total duration | 2 min | 5–15 min |
| Emotions covered | 2 | All approved palette states |
| Tag variety | Basic | [sigh] [chuckle] [laugh] [gasp] and clean (no tag) |

RVC training is robust to a few bad takes — the corpus does not need manual
QA. However, if a palette reference is significantly off-voice (wrong gender,
wrong accent), the resulting Chatterbox takes will carry that error into
training. Always approve palette references carefully before building the corpus.

---

## Troubleshooting

**"Voice drifts between scenes"**
Raise `index_rate` from 0.5 to 0.65. If the corpus is small (<20 files),
run `build_corpus` again to add more data and retrain.

**"[sigh] sounds like a normal exhale, not dramatic"**
RVC is stripping the breathy quality. Lower `index_rate` to 0.35.
This is the primary trade-off — consistency vs. tag fidelity.

**"Character sounds like two different people"**
A palette reference was approved that doesn't match the others.
Open the Palette tab, play all references back-to-back. Find the outlier,
revoke it, generate new takes, re-approve. Then rebuild corpus and retrain.

**"Training failed: CUDA out of memory"**
Lower `batch_size` in the training parameters (default 4, try 2).
Alternatively, run training on CPU (will take 2–4× longer).

**"RVC server not reachable"**
Start the RVC server:
```bash
cd inference && PHARAOH_INSTALL_RVC=1 ./setup.sh   # first time only
./.venv-rvc/bin/python rvc_server.py
```
