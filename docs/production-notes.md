# Pharaoh Production Notes — mix, ducking, spatialization, direction

Everything a session learns the hard way, generalized. No project-specific
content. Read alongside `docs/cli.md` (commands) and `docs/voice-pipeline.md`
(cast). This file is about *practice*: where things sit in the mix, how to
direct lines and music, what silently breaks, and the order to do it in.

## The mix hierarchy (house levels)

Loudness-normalized per-take targets −16 LUFS integrated / −1.5 dBTP. Relative
element levels (gain_db on rows):

| Element            | gain_db | Notes |
|--------------------|---------|-------|
| Dialogue (all)     | 0       | loudnorm handles consistency; do not gain-st dialogue |
| SFX                | −5      | start at −6 and expect one "touch louder/quieter" pass; iterate in 1 dB steps |
| Ambience beds      | −5      | same ladder as SFX |
| Music              | −6      | one step below SFX; music reads louder than meters suggest |

Two calibration truths:

1. **Effects/elements read hotter in context than in an A/B pack.** A treatment
   approved in isolation will still need one context pass (usually *toward
   subtlety*) once it's in the render. Plan that pass into the delivery —
   don't treat the first approved recipe as final.
2. **When someone says an element is too loud, move 1 dB and expect a second
   nudge.** Ears iterate downward in small steps; one big move overshoots and
   reads as "now it's gone."

`compose final --target-lufs -16` is the master gate; verify with
`loudnorm=print_format=summary` (Input Integrated) before delivery. Delivery
transcode: `ffmpeg -c:a aac -b:a 128k -ar 48000` to keep chat-file sizes sane;
keep `output/final.wav` as the lossless master.

## Ducking

`compose render scene` ducks beds/music under dialogue automatically. Trust it.
The failure modes are all manual:

- Hand-rolled gain staging on top of the auto-duck fights it — pick one.
- A SFX row placed *inside* a dialogue gap still gets full SFX level; that is
  correct (it's not under speech) but can read loud against nearby ducked beds.
  If a spot SFX jumps out, −1 dB on that row, not a global change.
- Music that starts *during* silence rides at full bed level until the next
  dialogue line ducks it — if the entrance startles, give the MUSIC row a
  `fade_in_ms` instead of cutting gain (fades are entrance work, gain is
  balance work).

## Spatialization and interior-voice treatment

### Verify the filter exists BEFORE promising the effect

Spatial prerender needs ffmpeg's `sofalizer`; a host ffmpeg without it aborts
the render with a truncated error (banner eats the 1500-char stderr budget —
the real cause is invisible). Probe at scene start:

```bash
ffmpeg -hide_banner -filters 2>/dev/null | grep -c sofalizer   # 0 = absent
```

If absent: report the blocker, offer options (build ffmpeg with libmysofa, or
flatten to dry stereo *with explicit approval*). Never silently flatten — a mix
that no longer matches the script's spatial intent is worse than a late render.

### Placement flags and the double-process trap

Rows carry `spatial_azimuth` / `spatial_elevation` (static) or `spatial_path`
(moving). **The render's spatial pass runs on ANY row with a non-empty
azimuth — regardless of what file is bound.** So if you offline-process a take
(HRTF baked in) and bind it, you MUST clear the row's spatial flags in the same
breath:

```bash
$PH script spatialize <project> <slug> <row> --clear
```

Otherwise the render sofalizes the processed file a SECOND time — double HF
loss, double pinning, the classic "tin can" coloration. Symptom check:
`.spatial/<row>.wav` mtimes == render time while the row's flags should have
been inert.

### Interior monologue: the E2s recipe (house sound)

Treat interior takes OFFLINE (Pharaoh has no per-row post-chain), bind the
processed file, clear flags, relayout, re-render:

```bash
SOFA=assets/sofa/mit-kemar-normal.sofa
fc="[0:a]aresample=48000[s0];[s0]sofalizer=sofa=$SOFA:type=freq:radius=0.75:rotation=10:elevation=0,lowpass=f=8500,aecho=0.8:0.85:70|130|220:0.22|0.15|0.09[out]"
ffmpeg -y -i raw.wav -filter_complex "$fc" -map "[out]" step.wav
ffmpeg -y -i step.wav -af "loudnorm=I=-16:TP=-1.5" interior_e2s_<row>.wav
$PH script update-row $P $S <row> --file <abs>/interior_e2s_<row>.wav
$PH script spatialize $P $S <row> --clear
```

Design logic (what each knob does perceptually):

- **radius** — source distance inside the head-picture; 0.75 = close but not
  inside-the-ear. Smaller = more intimate, faster toward "wrong mic" read.
- **rotation** — slight off-center placement; 10–15° reads "internal", 0° reads
  "colorless" (identical L/R).
- **lowpass 8500** — muffles the "room" out of the voice without telephone
  band-limiting. Lower (7500) = stronger effect, faster toward degraded.
- **aecho tails** — the "thought texture". 0.22|0.15|0.09 is subtle; 0.35|0.25|0.15
  announces itself; >0.5 becomes a cave. Delays 70|130|220 ms are roughly a
  natural slap pattern.

Calibration history: full recipe went through E (audition winner) → E2 (more
echo) → E2s (subtle, in-context) — each move was a real listener reaction. The
direction of travel was always *toward subtlety* once in the actual mix. Expect
the same on a fresh project: audition-pack numbers are a starting point, not a
destination.

**Define any effect set by SPEAKER (character id), never by row-flag state.**
Narrator attribution rows ("he said", "she thought") can carry old spatial flags
from an earlier compile; flag-state selection contaminates the narrator with
the interior effect. Filter by character, verify the set, then process.

## Directing lines: the two-channel rule

Every take gets BOTH:

1. **`instruct` — movement, not mood.** An adjective ("resigned") names a mood;
   direction describes movement: tempo, pitch trajectory, breath, effort, what
   the character is trying to do to the listener. "Flat, resigned, barely a
   word — he heard the shrug and it offended her" beats "resigned" every time.
2. **`[...]` paralinguistic tags in the text** — `[laughs]`, `[sighs]`,
   `[whispers]` are performed, not read aloud. Zero tags across a whole scene
   is the tell that direction never happened.

Placement semantics ("spatialised", "floating") must NOT leak into instruct —
the voice model can't act them and they starve the line.

**Re-read the script as a writer before generating.** Rows resolve, audio
generates, the render is the right length — and it can still be dead. The audit:
does every row carry a movement; where would a person breathe or falter; does it
read aloud; do silences do work; is every sentence of the source either voiced or
carried by the narrator (prose that exists only as action lines renders SILENT —
direction/action rows are skipped by generate/layout/render without warning).

## Narration conventions

- Narrator carries ALL prose: description, transitions, business between lines.
  One wry narrator line per chapter of description is the classic v1 failure.
- **Attribution tags** ("said X") after a character's FIRST line in a scene only;
  once the listener knows a voice, tags drop away. Tags are narrator-voiced and
  stay DRY even when they sit inside interior sequences.
- Music under dialogue: the MUSIC row at −6, let ducking do the rest.

## Voice casting: refs decide everything

Two voice classes:

- **Actor clones** (long real-recording refs) — rich, stable.
- **Designed voices** (short synthetic refs, ~3 s) — quality inherits from the
  ref clip. A "tinny"/"thin" designed voice is almost always a thin REF, not a
  processing defect. Diagnose with octave-band RMS (80–300 / 300–3k / 3k–10k Hz)
  vs a known-good voice AND its ref before touching any effect. EQ can restore
  weight; re-designing the ref is the real fix.

Design audition method:

- Generate candidates along ONE axis at a time (age, warmth, support), each with
  a distinct "voice-description".
- Same probe text within a round (clean A/B) — **but rotate the probe text
  between rounds**; a stale probe becomes an earworm and dulls the comparison.
- For age-targeted designs, audition on LONG text (a full paragraph, 8–10 s):
  short probes hide the voice's real register — designed voices drift
  (often brighter) as delivery settles, and the long take is the honest one.
- Loudness-match everything before sending; deliver each variant as its own
  file plus one concatenated sequence with ~0.8 s gaps.
- Measure lo/mid bands alongside listening — the meters occasionally explain
  the ears, never outrank them.

**Whenever a ref is swapped, `ref_transcript` must be re-set to THAT clip's
actual words** (clone quality conditions on the transcript; a stale transcript
silently degrades every subsequent take). Verify via the take's `.meta.json`:
`parent:` must name the new ref.

Book/film-era voice variants: keep one character per era with an era suffix in
the name, distinct refs per variant. Name-matching in Fountain compiles matches
the bare name too (parenthetical suffixes are optional in cues), so rows resolve
without cue churn.

## Silent-failure class of bugs (read before bulk operations)

Pharaoh's CLI returns success for several operations that do nothing. The
survivors so far:

| Operation that lies | Truth | Guard |
|---|---|---|
| `script update-row --character X` | flag is ignored (not in the field allow-list) | edit the CSV column directly, verify, then regenerate |
| `generate row scene` on a bound row | produces a NEW take, does NOT bind it | unbind first (`--file ""`), then generate; check `bound_to_script: true` |
| `character voice-set` without `--ref_transcript` | keeps the OLD clip's transcript | always pass the transcript; verify `.meta.json` `parent:` |
| `ref_audio_path` dangling | no error until generation | generate ONE test row before any bulk regen |
| Recompiling Fountain | wipes ALL audio bindings + spatial flags | back up `script.csv` first; rebind by (character, prompt) match from backup |
| Recompiling Fountain (again) | resets spatial flags | re-apply spatialize after every compile |
| `production_pipeline` field | legacy, ignored; hand-editing it once silently broke a character | never hand-edit it; routing is `ref_audio_path`-gated |
| `DIRECTION`/action rows | never generate audio, no warning | prose must ride on narrator DIALOGUE rows |

Universal guard: **verify state by READING it back** (script.csv, project.json,
asset `.meta.json`) after any state-changing CLI call that matters. Never trust
a return code alone.

## A/B audition methodology (subjective decisions)

1. One raw take + N processed variants of the SAME line.
2. `loudnorm=I=-16:TP=-1.5` everything; verify with `print_format=json`.
3. Deliver each variant as its own file + one concatenated sequence (0.8 s gaps).
4. Label A/B/C…, one line each on what was done, measured notes (not verdicts).
5. After the pick: ship ONE in-context render, expect one calibration pass.
6. Keep every rejected recipe — the trail is how you calibrate the next effect.

## Rendering pipeline order (canonical)

```bash
$PH script layout <proj> <slug> --replace true    # after ANY take change
$PH compose render scene <proj> <slug>            # the mixer; never ffmpeg-concat
$PH compose final <proj> --target-lufs -16        # master; verify integrated LUFS
```

`--replace true` is required when durations changed; without it stale positions
linger. Row `start_ms` values come from layout — never hand-set them.

## Verification before delivery

1. Script read-back: every dialogue row bound, correct character ids, no bare names.
2. One asset per row (count them).
3. `ffprobe` the render: duration, sample rate.
4. Loudness: `loudnorm=print_format=summary` → Integrated ≈ target.
5. Suspected clipping → count ±full-scale samples at SAMPLE level; window-level
   peak/loudness measures lie (dense mixes have hot windows everywhere).
6. "Is take X actually in the mix?" → cross-correlate the isolated take against
   the mix window (±100 ms search; corr ≥ 0.5 = present).
7. Actually listen. Green CLI output is not a sound.
