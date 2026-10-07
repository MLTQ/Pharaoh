# ModelServerCards.tsx

## Purpose
Renders one card per entry in `MODELS` (tts/sfx/music/post): status header, URL/health row, per-kind download instructions, and per-kind install/setup actions. Pure presentation — all state and persistence stays in `SettingsView.tsx` and arrives via props.

## Components

### `ModelServerCards` / `ModelServerCardsProps`
- **Does**: Maps `MODELS` to cards. Split mode shows editable per-server URL inputs; unified mode shows the derived URL and a health badge. Each card leads with the current engine and its `setup.sh` section — Breeze TTS 2 (`breeze`), MOSS-SoundEffect v2 (`moss`), YuE2 (`yue2`), AudioSR, dissect — through `SectionInstall`: a one-click `ServerSetupPanel` when the server is local, otherwise a "run this on that host" note, and the command either way. The fallbacks are folded into `<details>`: Qwen3-TTS downloads, ACE-Step (`SectionInstallCore`), and Woosh/AudioLDM (directory, readiness, one-click `WooshSetupPanel`, checkpoints) — open by default only when the SFX server reports `engine` other than `moss`. TTS card shows the active variant when loaded.
- **Interacts with**: `SfxDownloads`/`WooshInstall` from `SfxPanels.tsx`, `WooshSetupPanel`/`ServerSetupPanel` from `SetupPanels.tsx`, constants from `settingsShared.tsx`, `ServerStatus`/`ServerHealth` from `modelStore.ts`.
- **Rationale**: URL edits and Woosh-dir persistence are callbacks (`onUrlBlur`, `onWooshDirBlur`, `onBrowseWoosh`) so config I/O and error toasts live in one place (`SettingsView.tsx`).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `SettingsView.tsx` | `ModelServerCards` accepts `ModelServerCardsProps`; callbacks fired on blur/click only | Adding required props, changing callback signatures |
| `modelStore.ts` | `statusMap`/`healthMap` keyed by `ModelKind` | Adding a model kind requires a `MODELS` entry |

## Notes
- The card layout/classNames were moved verbatim from the pre-split `SettingsView.tsx`; keep visual changes in sync with the RVC card which mirror the same card chrome.
