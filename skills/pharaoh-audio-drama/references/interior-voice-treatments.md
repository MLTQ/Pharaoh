# Interior-voice treatments: optional auditions and safe binding

## Generic case-study lesson

A processed interior voice sounded degraded even though generation and rendering succeeded. Comparing raw and processed takes implicated HRTF coloration and imaging rather than proving clipping. A treatment preferred in isolation later sounded too conspicuous under narration.

No recipe below is a required house sound. Dataset, actor, source sample rate, playback device, and mix context all affect the result. Audition raw audio as a valid option, then calibrate the selected treatment in the actual scene.

## Configuration and prerequisites

Configure `FFMPEG` (selected executable), `SOFA` (readable HRTF dataset), `PH` (CLI), `PHARAOH_ROOT` (checkout), and `PROJECT_DIR` (project data). Inspect filter availability and options on that executable:

```bash
"$FFMPEG" -hide_banner -filters
"$FFMPEG" -hide_banner -h filter=sofalizer
"$FFMPEG" -hide_banner -h filter=aecho
```

The HRTF examples assume `rotation` is supported; that option was observed in a tested FFmpeg 9.0.1 installation, not guaranteed for every build. See `sofalizer-build.md`. Shell quoting is not sufficient for paths containing filtergraph-special characters: escape them for FFmpeg or use suitable safe asset names.

## Optional comparison recipes

Use one raw take for an entire audition round, for example Mira's thought: “This is fine. This is completely fine. Why is this so hard?” Keep outputs in a project-managed audition location. The examples do not overwrite existing files automatically.

```bash
RAW="$PROJECT_DIR/raw-thought.wav"

# A: raw, comparison normalization only.
"$FFMPEG" -i "$RAW" -af "aresample=48000,loudnorm=I=-16:TP=-1.5" "$PROJECT_DIR/audition-A.wav"

# B: HRTF, lowpass, and three light echoes.
"$FFMPEG" -i "$RAW" -filter_complex "[0:a]aresample=48000,sofalizer=sofa='$SOFA':type=freq:radius=0.75:rotation=10:elevation=0,lowpass=f=8500,aecho=0.8:0.85:70|130|220:0.22|0.15|0.09[out]" -map '[out]' "$PROJECT_DIR/audition-B.wav"

# C: no HRTF; lowpass and lighter echoes.
"$FFMPEG" -i "$RAW" -af "aresample=48000,lowpass=f=8500,aecho=0.6:0.7:70|130|220:0.12|0.08|0.05" "$PROJECT_DIR/audition-C.wav"

# D: nearly dry; one light echo.
"$FFMPEG" -i "$RAW" -af "aresample=48000,lowpass=f=9000,aecho=0.4:0.5:60:0.10" "$PROJECT_DIR/audition-D.wav"
```

Normalize B/C/D to the same measured comparison loudness as A in separate output files before comparing. The illustrated −16 LUFS / −1.5 dBTP target is optional; verify integrated loudness, peaks, channel layout, duration, and audible result rather than assuming normalization hit the target. Short clips can make integrated-loudness estimates less stable.

Further optional variants:

- A band-limited-only take, without HRTF or echo.
- A genuinely specified dry/wet blend, after matching channel layouts and aligning signals. `amix` weights `1|0.3` do **not** mean 70% dry / 30% wet; choose explicit weights such as `0.7|0.3` and check normalization behavior and phase interaction.
- A stronger/slower echo or different HRTF angle as a contrast probe—not as an automatic improvement.

If panning is needed, inspect supported filters and input layout first. Do not use a stereo expression referencing a nonexistent second channel of mono input.

## Parameter cautions

- HRTF radius and angle change geometry and coloration; their subjective meaning depends on the dataset. Small angles are not universally “internal.”
- Symmetric geometry can produce very similar channels; that alone does not prove spatial failure.
- Lowpass filtering can reduce brightness but also intelligibility. It is not a substitute for the actor's delivery.
- `aecho` takes `in_gain:out_gain:delays:decays`; the delay and decay lists need equal counts. A mismatch should be treated as a filter-init error. Check exit status and decoded output; a created file is not proof of successful processing.
- Echo can extend duration. Recompute or repair downstream timing after binding.

## Audition method

1. Use identical text and source take within a treatment round.
2. Loudness-match comparisons and include an untreated option.
3. Deliver individual variants and optionally a sequential audition with short gaps. A concatenated audition is not the scene mix; normalize channel layouts/sample rates before joining and give each silence segment its own source label or split it correctly.
4. Label variants with their processing and measurements, without declaring a winner from meters alone.
5. Change probe text between rounds to avoid fatigue; also test short and connected longer material.
6. After selection, audition one actual scene render. Isolated approval does not guarantee in-context subtlety. Record the approved recipe and preserve alternatives without carrying a session log into shared guidance.

If clipping is suspected, inspect sample runs and true peak as well as listening. Do not assert inaudibility from a historical sample count.

## Offline processing and binding

In tested Pharaoh versions without a suitable per-row post-chain, offline processing plus explicit binding was a practical data-level route. Confirm the active version's capabilities before choosing it.

1. Select interior takes by verified character identity AND narrative role. Elias can have both spoken dialogue and thoughts; narrator “thought Elias” tags stay dry by default.
2. Keep raw masters and write processed assets to durable locations under `PROJECT_DIR`.
3. Bind each intended output through the supported CLI.
4. If offline treatment replaces renderer spatialization, clear spatial flags in the same operation sequence.

```bash
"$PH" script update-row <project> <scene> <row> --file "$PROJECT_DIR/<processed-thought>.wav"
"$PH" script spatialize <project> <scene> <row> --clear
"$PH" script read <project> <scene>
```

5. Verify bound paths, all spatial fields, speaker assignments, and asset provenance. Repair layout, restore curated overlaps, render, and listen.

### Double-processing hazard

Tested renderers triggered a spatial pass from a non-empty `spatial_azimuth` even when an HRTF-processed file was already bound. The resulting second pass compounded coloration. Emptying flags for replacement processing is not merely cosmetic; read back the state and verify the render does not stack another pass.

Do not select effect membership from stale flag state. Narrator tags can carry old flags and be accidentally processed. Review speaker/role membership explicitly; see `production-notes.md` and `attribution-row-editing.md`.
