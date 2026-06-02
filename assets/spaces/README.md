# Spatial spaces — room impulse responses

Pharaoh's spatial-audio renderer applies a room IR (impulse response) via
ffmpeg's `afir` filter, after the binaural HRTF step (`sofalizer`). Each
*space* in `spaces.json` points to one IR WAV file that lives here.

## Default: install the curated starter pack

```bash
./inference/download_spatial_assets.sh
```

This fetches ~12 CC-licensed room IRs covering the audio-drama essentials:
vocal booth, bedroom, office, stairwell, hallway, small hall, concert hall,
opera house, church, cathedral, mausoleum, cave, forest. Pulled from the
OpenAir Library (University of York) and the Aachen Impulse Response (AIR)
database, both CC-BY-SA.

The script is best-effort — if a URL is dead or a mirror is down, that
preset shows up greyed out in the UI; the others still work. Drop in your
own WAV and add it to `spaces.json` to extend.

## Adding a custom space

1. Drop the IR WAV (stereo is preferred; mono works) into this directory.
2. Add an entry to `spaces.json` with a unique slug, your file name,
   sensible defaults, and a description.
3. Restart Pharaoh — the new space appears in the SpatializeModal
   dropdown.

## How Pharaoh picks an IR at render time

- The script row's `spatial_space` column holds a slug from `spaces.json`.
- The renderer looks up the slug, resolves it to a file path inside this
  directory, and calls ffmpeg `afir` with the file as the second input.
- Wet amount = `reverb_send` from the row if set, else the space's
  `default_wet`.
- If the file is missing (e.g. you haven't run the downloader), the
  renderer skips the convolution and logs a warning — no render failure.

## Format notes

- `afir` accepts any audio file as the IR. 48 kHz stereo is the
  recommended target; Pharaoh resamples on the fly if needed.
- Long IRs (>10 s) eat CPU. The renderer caps `maxir` at 30 s; longer
  files get truncated.
- Binaural-recorded IRs (made with a dummy head at the listening
  position) work but the binaural cues compound with our HRTF stage.
  For best results, prefer "neutral" stereo IRs captured with a coincident
  pair, or use a dry HRTF stage when applying a binaural IR.

## License roll-up

Default starter pack assets are CC-BY-SA 3.0 (Aachen AIR) or CC-BY-SA 4.0
(OpenAir Library). If you ship Pharaoh projects with the rendered audio,
the source attribution travels with the work; check the per-entry
`source`/`license` fields in `spaces.json`.
