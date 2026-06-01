# SOFA HRTF files

Pharaoh's spatial-audio renderer uses ffmpeg's `sofalizer` filter to do
HRTF-based binaural rendering. `sofalizer` needs a SOFA file (Spatially Oriented
Format for Acoustics) — head-related transfer functions measured on a real head
or dummy head, indexed by azimuth/elevation.

## Default: MIT KEMAR (public domain)

Run the install script to fetch the MIT KEMAR HRTF set (~3 MB):

```bash
./inference/download_sofa.sh
```

This drops `mit-kemar-normal.sofa` into this directory. Pharaoh picks it up
automatically the next time you render.

## How Pharaoh chooses a SOFA file

At render time the audio engine looks for the **first `.sofa` file** found in
this directory (`assets/sofa/`). You can swap in any SOFA-compliant HRTF set
— e.g. one measured on your own ears — by dropping it here. If multiple files
are present, Pharaoh prefers `mit-kemar-normal.sofa` if it exists, otherwise
takes the alphabetically first.

## Fallback when no SOFA is installed

If this directory is empty, the renderer falls back to a pure-ffmpeg binaural
approximation: interaural time delay (ITD) + interaural level difference (ILD)
+ high-frequency rolloff for rear-hemisphere sources. It's not true HRTF, but
it sounds notably better than equal-power amplitude panning and works with
zero external dependencies. Front/back disambiguation is weaker — install a
SOFA file for production work.

## License

MIT KEMAR data is public domain (Bill Gardner & Keith Martin, MIT Media Lab,
1994). If you ship your own SOFA file, check its license before redistributing.
