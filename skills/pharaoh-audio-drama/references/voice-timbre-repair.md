# Voice timbre repair: reference diagnosis and redesign

## Generic case study

Mira's designed voice sounded thinner than Elias's approved clone. The useful lesson was to compare take provenance, raw audio, processing, and reference timbre before blaming upsampling or adding effects. A short synthetic reference can constrain the result, but thinness is not always a reference problem.

In a tested production pipeline, all compared takes used the same sample-rate/engine path and no AudioSR stage. That finding belongs to that pipeline, not every Pharaoh installation. Inspect the active voice-pipeline documentation and generated metadata rather than assuming identical processing.

## Diagnosis order

1. Read each take's actual speaker, model, and reference provenance. Wrong routing or an unintended preset can masquerade as a microphone/timbre issue.
2. Compare raw and processed takes to distinguish source timbre from spatial/EQ coloration.
3. Compare takes AND their references against a suitable approved voice, using matched playback loudness and representative text.
4. Inspect low/mid/high band energy as supporting evidence. Different voices need not have identical spectra; absolute band RMS without loudness control is misleading.
5. Listen to connected longer material as well as isolated short phrases.

Configure `FFMPEG` and `PROJECT_DIR`. An illustrative band measurement:

```bash
# Repeat with appropriate LO/HI values, e.g. 80/300, 300/3000, 3000/10000 Hz.
"$FFMPEG" -hide_banner -i "$PROJECT_DIR/take.wav" \
  -af "highpass=f=$LO,lowpass=f=$HI,volumedetect" -f null -
```

These broad frequency bands are diagnostic examples, not exact octave bands or objective voice-quality scores. Sample rate and filter behavior affect comparisons.

## Optional EQ auditions

EQ may restore perceived weight but does not create missing performance detail or harmonics. Use modest, loudness-matched comparisons and listen for muddiness, sibilance, and loss of intelligibility.

Example filters to audition, not required settings:

```text
bass=g=5:f=180:width_type=q:w=0.8
bass=g=6:f=200:width_type=q:w=0.7,treble=g=-2:f=5000:width_type=q:w=0.9
bass=g=6:f=180:width_type=q:w=0.7,equalizer=f=3000:t=q:w=1:g=-1.5,equalizer=f=6500:t=q:w=1.2:g=-2.5,lowpass=f=11000
```

Confirm filter support and meaningful cutoff frequencies for the input sample rate. Apply an appropriate comparison loudness target after processing. Do not use boosted bass as evidence that a reference problem has been fixed.

## Reference redesign workflow

Use the configured `PH` and current CLI documentation. A tested interface offered `generate tts-design` with text, voice description, and output path; confirm available commands and flags before running it.

1. Generate a small candidate set along one axis at a time: warmth, register, support, or perceived age. Use original fictional character descriptions rather than relying on a recognizable performer's identity.
2. Keep the same probe text within a round, but rotate text between rounds. Include a paragraph or connected exchange: a short probe can hide register drift or instability.
3. Loudness-match candidates; provide individual files plus an optional sequential audition with brief gaps. Use lossless files for binding; compressed previews are optional.
4. Describe each candidate plainly and present spectral measurements as notes, not verdicts. Listener approval on connected material outranks numerical band parity.
5. Preserve approved references in a durable asset location under `PROJECT_DIR` before binding them; do not rely on disposable scratch files.
6. Bind the chosen reference AND its exact transcript together. Inspect `ref_audio_path`, `ref_transcript`, and direction defaults by read-back.
7. Generate one representative row before bulk regeneration. Verify speaker, engine, and allowed provenance, then listen. Palette selection may legitimately use a different approved reference from the same character.
8. Regenerate/rebind affected rows deliberately, repair layout for new durations, restore curated overlaps, and render in context.

A candidate can be good but wrong for the current role. A more mature Mira voice can be banked as an optional future variant without replacing the approved present-day voice. Use clear variant names, distinct references, and exact assignment checks after import; parenthetical cue matching has been ambiguous in tested versions.

## Reference/transcript consistency pitfall

In tested cloning workflows, replacing a reference while retaining the previous clip's transcript degraded subsequent takes. A successful binding call did not certify consistency. Whenever a reference changes, supply that clip's actual words and verify the stored assignment plus generated provenance.

Do not infer a failed swap from file times alone. Read persisted values. Do not assume primary-reference-only provenance: a character's approved emotional palette can be a valid parent source. Do not swap actors to repair pacing, and do not chase spectral parity through endless regeneration after a listening-capable reviewer has approved the result.
