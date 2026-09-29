# dissect_pipeline.py

## Purpose
Take a finished audio drama apart into the pieces Pharaoh can reuse: dialogue / music / effects stems, speaker turns with transcripts, and per-speaker reference clips clean enough for Chatterbox cloning (3–15 s, solo, low bleed).

## Components

### `Models`
- **Does**: Lazily loads and keeps resident BandIt Plus (DnR separator, from a pinned MSST checkout), Nemotron-3-Diarization, TitaNet-large, and Parakeet TDT 0.6B v3. `ml_available()` / `separator_available()` decide stub vs real mode.
- **Rationale**: MSST's `models.bandit.core` package `__init__` imports its training stack; a bare package object is registered in `sys.modules` so only the model code loads.

### `separate`
- **Does**: 50 %-overlap, Hann-windowed overlap-add of BandIt Plus over 6 s chunks at 44.1 kHz stereo. Accumulates on the CPU.
- **Rationale**: An hour of 3-stem stereo is ~4 GB; keeping it off the GPU leaves VRAM for the models.

### `diarize`, `speaker_centroids`, `link_speakers`
- **Does**: Diarizes the dialogue stem in `chunk_minutes` chunks (the model tracks ≤ 8 speakers per pass), embeds each chunk-local speaker's longest solo spans with TitaNet, and average-linkage merges them across chunks above `link_threshold`. Speakers from the same chunk never merge.
- **Rationale**: The diarizer resolves within-chunk identity better than the embedder; the embedder only has to stitch chunks.

### `transcribe_turns`
- **Does**: Parakeet over every turn (≤ 30 s pieces), keeping absolute word timestamps.

### `pick_candidates`, `_windows`, `export_clip`
- **Does**: Cuts each speaker's solo spans into 3–15 s windows at word gaps, trims to the words, scores on length (≈ 8 s ideal), dialogue-over-bed level (`bleed_db`), speech rate, and TitaNet similarity to the speaker centroid; keeps the top non-overlapping `max_candidates`. Exports 48 kHz / 24-bit mono at ≈ −20 dBFS RMS with 12 ms fades.

### `run`
- **Does**: Orchestrates the stages, writes `stems/*.flac` (24-bit lossless — WAV stems were 2 GB per 44 min and dominated remote downloads), `candidates/*.wav`, and `manifest.json` (all paths relative to the output dir). Speaker ids are `S1…` ordered by total speech, so the narrator is usually `S1`.

### `probe_container`, `extract_cover`, `chapter_of`, `chunk_bounds`
- **Does**: ffprobe the source for chapters, descriptive tags (title / album / artist / …) and an attached cover picture; copy the cover out as `cover.jpg|png`; tag every turn and candidate with its chapter; and build diarization chunks from whole chapters (splitting only chapters longer than `chunk_minutes`).
- **Rationale**: `.m4b` / `.m4a` audiobooks carry this for free. Chapter starts are scene breaks, so cutting diarization chunks there avoids splitting a speaker's turn across two chunks. `decode` maps only `0:a:0` — the cover is a video stream and chapter titles are a data track.

### `find_credits`
- **Does**: Finds "X, read by Y" / "played by" / "voiced by" credits in each speaker's own turns (joining turns split by a pause) → `speakers[].credits`. Suggestions only; the UI offers them as name chips and records the performer with the rights confirmation.
- **Rationale**: LibriVox dramatic readings open with a dramatis personae in which every performer reads their own credit — the recording labels its own voices.

### `prefetch`, `check` (`python dissect_pipeline.py --prefetch | --check [--quick]`)
- **Does**: Setup helpers for `setup.sh`: download only the three `.nemo` checkpoints into the Hugging Face cache NeMo reads; verify NeMo/torch, separator files, ffmpeg/ffprobe and CUDA, and (unless `--quick`) load the diarizer on CPU. `--check` exits 1 on any ✗.
- **Rationale**: The diarizer is the version-sensitive piece (its RoPE encoder is missing from the nemo-toolkit 3.0.0 wheel), so loading it is the check that matters.

### `DissectCancelled`
- **Does**: Raised from a progress callback to abandon a run; `dissect_server` owns the flag.

### `stub_turns`
- **Does**: Energy-gated segmentation with alternating fake speakers, used when NeMo is missing or `PHARAOH_DISSECT_STUB=1`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `commands/dissect.rs` | `manifest.json` with `speakers[].id`, `speakers[].candidates[].{id,path,transcript}`; relative paths | Renaming fields, absolute paths |
| `DissectImportModal.tsx` / `types.ts::DissectManifest` | `duration_s`, `stub`, `warnings`, `speakers[]` stats, candidate `bleed_db` / `similarity` (nullable) | Shape changes |
| `tests/test_dissect_pipeline.py` | Stub run works with only numpy + soundfile + ffmpeg | Hard torch imports at module load |

## Notes
- Real `.m4b` test: the first 44 min (4 chapters) of LibriVox's *Anne of Green Gables* (DR) processed in 122 s cold on an RTX 4090; chunks cut at chapter starts; the narrator was linked across all chunks; 16 cast credits recovered from the dramatis personae.
- Measured on a 5-min LibriVox dramatic reading mixed with a Brahms underscore and synthetic rain/knocks: dialogue SDR 16.8 dB (4.9 dB unseparated); 31 s end to end on an RTX 4090 including model load; 5.5 GB VRAM for the NeMo models.
- Voices that both the diarizer and TitaNet hear as one (e.g. a narrator who also reads a character) stay merged; the UI lets the user pick clips by hand. A split tool is a follow-up.
- License check pending for the BandIt Plus weights (trained on DnR) before any commercial release — see ARCHITECTURE.md.
