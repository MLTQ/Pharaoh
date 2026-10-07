# Sofalizer capability and compatibility checks

Despite the retained filename, this is a portable capability guide, not a machine-specific build recipe. No installed dependencies, operating-system package choices, library paths, or successful host build are assumed.

## Configure and probe the executable actually used

Set `FFMPEG` to the selected executable, `SOFA` to a readable HRTF dataset, `PH` to Pharaoh's CLI, `PHARAOH_ROOT` to the tool checkout, and `PROJECT_DIR` to project data. A successful probe of one executable does not prove Pharaoh invokes that executable; verify the renderer's configured resolution separately.

```bash
"$FFMPEG" -version
"$FFMPEG" -hide_banner -filters
"$FFMPEG" -hide_banner -h filter=sofalizer
```

Confirm the filter exists and inspect the actual options before constructing a chain. If the optional skill probe is used, check its help and whether it can target the same executable; do not assume its default matches the renderer.

If capability is missing, report the blocker. Options include an appropriate compatible FFmpeg distribution, an authorized build following FFmpeg's current documentation and libmysofa prerequisites, or an explicitly approved non-HRTF treatment. Do not silently remove spatial intent from the scene. Installing/building software and patching Pharaoh are separate authorized tasks.

## Version-specific option compatibility

A tested FFmpeg 9.0.1 installation exposed `rotation` for sofalizer horizontal orientation and rejected `azimuth`. This observation does **not** establish when an option changed or what every release accepts. Inspect `-h filter=sofalizer` on the selected executable and compare with the renderer's generated filter graph.

If the graph uses unsupported options, report a compatibility mismatch. Prefer a documented compatible version or an upstream-supported solution; do not instruct users to patch a fixed source line blindly.

## Runtime linkage can differ from build configuration

A filter enabled at configure time can still appear absent if the executable loads different shared libraries at runtime. Diagnose the selected artifact and its runtime dependencies using appropriate platform tools. Do not globally override library search paths or replace system executables on the strength of a historical workaround. Choose an isolated, documented installation strategy if a build is authorized.

## Optional HRTF audition

The example assumes `rotation` is supported. Paths containing FFmpeg filtergraph-special characters require filtergraph escaping in addition to shell quoting.

```bash
"$FFMPEG" -i "$PROJECT_DIR/clip.wav" \
  -filter_complex "[0:a]aresample=48000,sofalizer=sofa='$SOFA':type=freq:radius=1:rotation=45:elevation=25[out]" \
  -map '[out]' "$PROJECT_DIR/sofa-probe.wav"
```

Use project-managed input/output names appropriate to the real workflow. Avoid overwriting an existing master. Check command exit status and output validity before listening.

Compare left/right energy and correlation at a non-symmetric angle and audition the result. Exact differences depend on the dataset, signal, geometry, and normalization; no fixed delta proves correctness. Symmetric placement can produce very similar channels and is not, by itself, evidence that HRTF processing failed.

## Render safety and diagnostics

Some tested Pharaoh versions truncated FFmpeg stderr so the version banner obscured the actual failure. Capture full diagnostics or reproduce the reported graph directly with the selected executable before assigning a cause.

When a take already includes HRTF processing, verify whether row flags would trigger another pass. If offline processing replaces renderer spatialization, clear those flags and read them back. See `production-notes.md` for the processed-file pitfall and `interior-voice-treatments.md` for optional auditions.

Do not claim spatial success from filter availability alone: verify a representative Pharaoh render using the intended executable, dataset, row state, and listening review.
