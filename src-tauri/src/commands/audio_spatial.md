# audio_spatial.rs

## Intent

Turn any script row with a `spatial_azimuth` / `spatial_path` value *or* a
`spatial_space` slug into a prerendered stereo WAV the main scene renderer
can drop into its filter graph as if it were any other source. HRTF
placement and room reverb compose orthogonally:

- HRTF stage (sofalizer or ITD/ILD approximation) → produces label `[bin]`
- Space stage (afir convolution against the room IR) → produces label `[out]`

A row can use either, both, or neither. When neither is set the row skips
the prerender entirely and the main render handles it via the legacy
pan/gain/fade chain.

The render pipeline calls `prerender_spatialized_clip()` once per row that
needs *either* stage. The output goes into `<scene_dir>/.spatial/<i>.wav`,
the main render replaces `row.file` with that path, and the existing
pan/gain/fade chain treats it like any other clip — except the `pan` filter
is skipped, since the audio is already positioned (and possibly reverbed)
in the stereo field.

## Engine selection

At call time the renderer probes `assets/sofa/` for a `.sofa` HRTF file
(see `assets/sofa/README.md` for the `download_sofa.sh` setup that installs
the MIT KEMAR set). If one is present we use ffmpeg's `sofalizer` filter
— true HRTF, full front/back/up/down disambiguation. If not, we fall back
to an ITD + ILD + HF-rolloff approximation that works with zero external
assets but has weaker rear-hemisphere cues.

The fallback exists specifically so the feature ships and works on a fresh
clone without any download step. The SOFA path is an upgrade, not a
requirement.

## Trajectory rendering

For moving sources the input is split into ≤32 fixed segments, each
rendered at the (az, el) sampled from the waypoint curve at its
midpoint, then concatted end-to-end. Segments are at least 100 ms long
(MIN_SEGMENT_MS) so very short clips don't get pathologically chunked.

`sample_trajectory()` uses shortest-arc azimuth interpolation so e.g.
350° → 10° passes through 0°, not 180°. Tested.

## Why prerender rather than inline

The static case fits in a single `sofalizer` filter and could in principle
inline cleanly into the main graph. The trajectory case can't —
`asplit → N × sofalizer → concat` would multiply the per-clip labelled
streams and tangle with the dialogue/bed/music bus structure. The
prerender approach makes the static and dynamic cases code-symmetric and
keeps the main render unchanged from today.

## Contract surface

- `parse_waypoints(json)` — tolerant of garbage; returns clamped, sorted
  waypoints (or empty on parse failure).
- `row_needs_spatial(azimuth, path)` — boolean, HRTF-only.
- `row_needs_prerender(azimuth, path, space)` — boolean, used by the main
  renderer to decide whether to call prerender for a row.
- `find_sofa_file()` — `Option<PathBuf>`, search order documented in
  rustdoc.
- `find_spaces_dir()` — `Option<PathBuf>`, mirrors find_sofa_file with
  `$PHARAOH_SPACES_DIR` override.
- `load_spaces_with_availability()` — reads `spaces.json` and stamps
  `available` on each entry. Errors and missing manifest both return an
  empty list so the renderer stays robust.
- `find_space_ir(slug)` — resolves a slug to `(ir_path, default_wet)`;
  None for dry/missing.
- `resolve_wet_amount(reverb_send, default_wet)` — parses the row column
  with manifest fallback.
- `list_spatial_spaces` (Tauri command) — frontend-facing wrapper.
- `prerender_spatialized_clip(input, output, az, el, path, space_ir, wet)` —
  writes 48 kHz / 24-bit / stereo; errors carry ffmpeg stderr.
- `sample_trajectory(waypoints, fallback_az, fallback_el, t_frac)` —
  public for unit tests and CLI dry-runs.

## Known limitations

- The approximation chain is informed by typical published values but
  isn't calibrated against measurements. It's a "better than panning"
  cue, not a substitute for HRTF.
- `sofalizer` quality depends entirely on the chosen SOFA file. MIT
  KEMAR is a single dummy-head measurement and won't match every
  listener's HRTF — for top-shelf work, a listener-specific SOFA file
  improves localization markedly.
- Segment count caps at 32, which means very long sources (>4–5 s) with
  fast trajectories may show audible stepping. Bump `MAX_SEGMENTS` if
  needed; the cost is filter-graph size at render time.
