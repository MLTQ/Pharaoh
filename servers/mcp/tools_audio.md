# servers/mcp/tools_audio.py

MCP tools: local audio post-processing (ffmpeg) and AudioSR upscaling.

## Purpose

Non-destructive clip work: every tool writes a **new** file next to the input
and (except resample) a child sidecar whose `parent` links back to the source,
so take lineage survives editing.

## Tools

| Tool | Output | Notes |
|------|--------|-------|
| `import_audio` | scenes/__imports/assets/{stem}.import.{ts}.wav | any format → 48 kHz mono WAV + sidecar |
| `process_clip` | {stem}.clip.{ts}.wav | trim/fade/gain/EQ/loudnorm in one ffmpeg pass |
| `normalize_audio` | {stem}.norm.wav | loudnorm to target LUFS, TP -1.5 dB |
| `resample_audio` | {stem}.48k.wav | 48 kHz stereo (engine requirement); no sidecar |
| `upscale_audio` | {stem}.upscaled.{model}.{ts}.wav | the one non-local tool — proxies to the post server (AudioSR); returns a job_id |

## Contracts

- `_run_ffmpeg` shells out to a local `ffmpeg` binary (300 s timeout) and
  returns `(ok, stderr_tail)`; tools wrap failures with the input path.
- `_wav_duration_ms` reads the WAV header directly; returns None on failure.
- Local tools are synchronous; only `upscale_audio` follows the job_id/poll
  pattern.
