# Production notes: performance, overlap, ducking, and spatial safety

Read the installed version's CLI and voice-pipeline documentation. The practices below are reusable; numerical recipes are optional starting points, not required house settings. CLI and renderer quirks describe behavior observed in tested installations, not guarantees for every version.

## Configuration

Configure `PHARAOH_ROOT` (tool checkout), `PROJECT_DIR` (actual project data), `PH` (CLI executable), `FFMPEG` (selected FFmpeg executable), and `SOFA` (chosen HRTF dataset). Tool checkout and project data are distinct. CLI commands address a registered project identifier, shown below as `<project>`, rather than necessarily accepting `PROJECT_DIR`.

Use quoted variables for paths. Check the actual commands and flags in `$PHARAOH_ROOT/docs/cli.md`; examples assume the illustrated interface is available.

## Foreground hierarchy and optional levels

For a speech-led production, narration and intelligible character speech lead. Laughter, crowd reactions, ambience, and supporting effects sit lower and behind/under concurrent speech. Do not give every effect a sequential slot simply because the script places it between dialogue blocks. Isolate an effect only when a dramatic beat needs it.

An optional audition baseline is dialogue at 0 dB row gain, effects/beds around −5 dB, and music around −6 dB, with a −16 LUFS / −1.5 dBTP delivery target. None of those values guarantees intelligibility or suits every platform. Calibrate by listening in context; small gain changes are easier to compare than large jumps. Quiet laughter may need considerably less gain than other effects.

Separate laughter from spoken takes when independent mixing is necessary, preserving the intended words. Inspect actual timeline overlaps after layout. Curated effect starts can be anchored to narrator or character rows; a replacing layout pass may overwrite them, so preserve/reapply anchors afterward.

## Ducking

Tested Pharaoh renderers automatically duck beds/music under dialogue. Confirm the active renderer's behavior rather than assuming every row type is ducked identically.

- Avoid duplicating automatic ducking with a competing manual gain system.
- An effect placed in a speech gap may be unducked and stand out against nearby ducked beds. Adjust that cue, not necessarily the entire effects bus.
- Music entering during silence may reach full level before speech begins. Use an entrance fade when the entrance is the problem; use gain when overall balance is the problem.
- Automatic ducking does not replace sensible overlap, timing, or listening QA.

## Spatial prerequisites

Before promising an HRTF treatment:

```bash
"$FFMPEG" -hide_banner -filters
"$FFMPEG" -hide_banner -h filter=sofalizer
```

Confirm `sofalizer` availability, supported option names, and a readable `SOFA` file. Some tested versions truncated spatial errors so the FFmpeg banner hid the useful message; obtain full diagnostics before diagnosing. Missing capability is a blocker, not permission to flatten silently. Offer an appropriate compatible installation or an explicitly approved dry/non-HRTF treatment.

## Processed-file spatial flag pitfall

In tested Pharaoh versions, a non-empty `spatial_azimuth` triggered spatial prerender even when the row's bound file already had HRTF processing baked in. Other spatial fields should also be inspected. Binding a processed take while retaining renderer spatial placement can apply a second spatial pass, causing excessive coloration and narrowed imaging.

When offline processing is intended to REPLACE renderer spatialization, bind the processed file and clear the row's spatial flags together:

```bash
"$PH" script update-row <project> <scene> <row> --file "$PROJECT_DIR/<processed-take>.wav"
"$PH" script spatialize <project> <scene> <row> --clear
"$PH" script read <project> <scene>
```

Use real project-relative asset locations in place of placeholders. Verify the bound file and all spatial fields by read-back, then inspect the rendered result. If an additional pass is deliberately intended, document it and audition the stacked chain.

Define effect membership by intended speaker AND narrative role, not stale spatial flags alone. Mira's spoken dialogue is not necessarily interior speech; “thought Mira” is narrator audio and remains dry by default. Narrator tags can inherit stale flags, so verify the selected set before processing.

See `interior-voice-treatments.md` for optional recipes and `sofalizer-build.md` for capability checks.

## Directing and narration

- Extract explicit whisper/shout/etc. requirements first; see `source-performance-contract.md`.
- Direction describes movement: tempo, pitch, breath, effort, and objective, not just an adjective.
- Supported vocal-event tags can supplement direction where justified; do not force tags onto every line or invent unsupported events.
- Keep spatial placement out of actor instructions. Placement belongs to the mix, not the performance.
- In a narrator-led adaptation, put prose intended to be heard on narrator dialogue rows. Tested versions skipped action/DIRECTION rows for audio; verify the active compiler rather than assuming action text will be spoken.
- First-appearance attribution is an optional clarity convention, not a requirement. Merge repetitive connective tags into nearby narration where appropriate; retain meaningful business and interior framing.
- Re-read the adaptation as a writer before generating. A complete file set can still contain a flat performance or missing prose.

## Voice references and auditions

A thin voice may inherit a thin reference, but also check routing, actual speaker, processing, and encoding before blaming reference timbre. Compare takes AND references against a suitable baseline. When swapping a clone reference, supply that clip's actual `ref_transcript`; verify generated provenance and listen to one pilot row before a batch.

Short takes can vary markedly. For a continuity problem, audition adjacent lines as a single performance using the same intended actor; split at a natural pause only if separate rows are needed. Keep the combined master and listen across the split.

Use one probe text within an audition round, change it between rounds, include connected longer material, and loudness-match comparisons. After selecting an effect or voice, audition it in the actual mix. Isolated approval is not final context approval.

## Tested-version hazards to re-check

| Observed behavior | Guard |
|---|---|
| Generating an already-bound row creates a take without rebinding | Check `bound_to_script` and row read-back; explicitly bind or unbind before regeneration |
| `update-row --character` succeeds without changing character | Verify the field; use a documented script-write/edit route supported by the installed version |
| Fountain compile replaces bindings/placement | Back up rows, validate character mapping, restore compatible takes and intended placement |
| Duplicate names with parenthetical variants resolve to the wrong cast member | Inspect exact assignments after every compile |
| A reference path loads but fails at generation | Check file existence and generate one pilot row |
| Legacy routing fields no longer govern the engine | Read current pipeline documentation/code; do not migrate data based on historical assumptions |
| Sidecars use the full audio filename plus `.meta.json` | Discover the installed naming convention before bulk provenance checks |

Success exit codes are not state verification. Read persisted rows, voice assignment, and take metadata. Reference provenance can legitimately point to a character's approved emotional-palette clip rather than the primary reference alone.

## Rendering and delivery

After take durations change, recompute layout or explicitly repair timings. A common interface is:

```bash
"$PH" script layout <project> <scene> --replace true
# Restore any curated overlap anchors here, then verify the timeline.
"$PH" compose render scene <project> <scene>
"$PH" compose final <project> --target-lufs -16
```

These commands are examples, not a requirement to discard custom placement. Use the renderer for layered scene mixing; FFmpeg concat is appropriate for sequential auditions, not a substitute for that mix.

Before delivery:

1. Read back intended character assignments, bindings, gain, and placement; verify every required asset exists. Do not assume one file per row—shared takes, non-audio rows, and alternatives can change counts.
2. Inspect render duration, sample rate, integrated loudness, and true peak using suitable tools. Measure rather than assume the requested target was reached.
3. Listen for delivery, voice continuity, overlaps, intelligibility, and effect strength. Mark unreviewed checks honestly.
4. Investigate suspected clipping at sample level AND with true-peak measurements. Count full-scale samples and sustained runs, but do not treat any fixed count as an audibility guarantee; integer decoding alone cannot prove absence of intersample clipping.
5. Keep a lossless master. Optionally create a platform-appropriate delivery encode, then verify the encoded file as well.

## Optional looping-video delivery

For a platform-compatible audio mix and a short video loop, an optional delivery command is:

```bash
"$FFMPEG" -stream_loop -1 -i "$PROJECT_DIR/loop.mp4" \
  -i "$PROJECT_DIR/final-mix.m4a" \
  -map 0:v:0 -map 1:a:0 -shortest \
  -c:v libx264 -pix_fmt yuv420p -c:a copy \
  "$PROJECT_DIR/delivery.mp4"
```

First inspect `"$FFMPEG" -hide_banner -encoders` and confirm `libx264` is available; not every build includes it. This maps video only from the repeating loop and audio only from the completed mix, ending at the audio duration. `-c:a copy` requires an audio codec compatible with MP4 and the target platform; the illustrated M4A should contain a supported codec such as AAC. A WAV master may require a separate approved audio encode rather than stream copy. Verify duration, stream mapping, playback, and platform compatibility of the output; retain the lossless audio master.

Read persisted values before constructing a causal story from file times. If documentation and the live version disagree, record the discrepancy rather than silently applying stale advice.
