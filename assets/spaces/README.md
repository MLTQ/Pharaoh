# Spatial spaces — room impulse responses

Pharaoh's spatial-audio renderer applies a room IR (impulse response) via
ffmpeg's `afir` filter, after the binaural HRTF step (`sofalizer`). Each
*space* in `spaces.json` points to one IR WAV file that lives here.

## Default: install the catalog

```bash
./inference/download_spatial_assets.sh
```

Every preset gets installed via a two-tier strategy:

1. **Download** a real measured IR if `spaces.json` carries a `url` for the
   entry and the URL responds. (Curated FOSS sources — OpenAir Library at
   University of York, Aachen Impulse Response database.)
2. **Synthesize** a plausible IR locally if the download fails or no URL is
   listed. `inference/synth_spatial_irs.py` reads each entry's `synthesis`
   block (RT60, brightness, density, early-reflection on/off, predelay) and
   builds a stereo WAV with exponentially-decaying noise + a handful of
   discrete early reflections + spectral tilt — the same DSP recipe plate
   reverbs have shipped for 40 years.

The install always succeeds. A typical first run produces ~10 MB of WAVs
(mausoleum is the biggest at 3 MB because of its 15-second decay).

## Real measurements vs. synthesis

For narrative audio the difference is small. A synthesized cathedral IR
correctly reproduces the long stone decay, the modal coloration, and the
predelay — the things a listener actually identifies as "cathedral." A
real measured IR of York Minster captures the *specific* modal fingerprint
of that *specific* building, which matters for forensic acoustic analysis
but not for "this character is in a cathedral."

To upgrade any preset to a real measurement: drop the WAV into this
directory with the same filename `spaces.json` specifies (`cathedral.wav`
for the cathedral entry, etc.). The synthesized version gets overwritten
and the renderer picks the real one up on the next render. No manifest
edits required.

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
