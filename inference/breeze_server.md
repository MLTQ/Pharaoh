# breeze_server.py

## Purpose
Pharaoh's TTS engine on port 18001 when installed: Breeze TTS 2 behind the same API as `tts_server.py` (Qwen3-TTS), so every caller keeps working. Chosen after a seven-model shootout in which Breeze rated best for delivery (laughs, sighs, whispers) — see the epic in beads.

## Components

### Endpoints
- `/generate/voice_design` — description → new voice (Breeze Voice Design, CFG 4).
- `/generate/voice_clone` — reference + transcript → that voice (Voice Clone); with `instruct` it becomes Voice Direction (the voice, performed as described).
- `/generate/direction` — voice_clone with `instruct` required.
- `/generate/custom_voice` — Qwen's named presets: each designed once from its description into `PHARAOH_BREEZE_PRESETS/<name>.wav`, then cloned (+ directed), so a name keeps one voice.
- `/health` reports `engine: "breeze"` (the app and CLI route cloned voices here when they see it), real `vram_mb` (~11–12 GB with the checker), and capabilities. Job responses carry a `result`: direction performed, take check (`wer`, `heard`), seed, corrected reference transcript.

### Guards
- **Reference transcript**: transcribed with Whisper; a missing or mismatched one (>30% WER) is replaced. Breeze conditions on the reference's exact words and garbles when they're wrong (seen in the shootout).
- **Take check**: each take is transcribed; one more than 25% off the script is regenerated on a new seed, up to `PHARAOH_BREEZE_TRIES` (3). Whispered/breathy direction gets a 50% bar — recognition mishears whispers.

### Vocal events
`to_vocal_events` turns Pharaoh tags (`[laugh]`, `[sighs]`…) into Breeze's `(laugh)`. Documented upstream: laugh, sigh, cough, clears throat. Probed on Breeze (none read aloud, each performed something): gasp, sob, crying, scream, whisper, breath, chuckle, groan, sniff, yawn, hum. Unknown cues still pass as events.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `commands/inference.rs`, CLI | Qwen-compatible endpoints and job/files API | Renaming endpoints or fields |
| `useGenerateJob.ts`, `cli/generate_scene.rs` | `/health.engine == "breeze"` to route cloned voices here | Dropping `engine` |

## Notes
- Needs ~12 GB of GPU; doesn't fit an 8 GB card (tested on an RTX 2070 SUPER: out of memory in fp16).
- Weights are BreezeBlue Research and Non-Commercial; `setup.sh breeze` downloads them per install.
- Env: `PHARAOH_BREEZE_HOME`, `PHARAOH_BREEZE_REPO`, `PHARAOH_BREEZE_MODEL_DIR`, `PHARAOH_BREEZE_PRESETS`, `PHARAOH_BREEZE_ASR` (Whisper id or `off`), `PHARAOH_BREEZE_TRIES`, `PHARAOH_BREEZE_MAX_WER`.
