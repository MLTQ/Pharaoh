# settingsShared.tsx

## Purpose
Shared types, constants, and tiny presentational components for the Settings panels. Extracted from the monolithic `SettingsView.tsx` so every panel file pulls model definitions, port mappings, and styling primitives from one place.

## Components

### `useHardwareProfile` / `HardwareProfile`
- **Does**: Detects OS/arch/GPU backend once on mount via Tauri `detect_hardware`.
- **Interacts with**: `SetupPanels.tsx` (uv sync command), `SfxPanels.tsx` (Woosh install variant).

### `MODELS` / `TTS_VARIANTS` / `ModelKind`
- **Does**: Static definitions of the four model servers (tts/sfx/music/post) and the Qwen3-TTS download variants. `subdir` must match the TTS server's `_ENDPOINT_TYPE` keys.
- **Interacts with**: `ModelServerCards.tsx` renders one card per `MODELS` entry.

### `SfxServerHealth`
- **Does**: `ServerHealth` extended with Woosh/AudioLDM readiness flags reported by the SFX server.
- **Interacts with**: Cast in `SettingsView.tsx`, consumed by `ModelServerCards.tsx`.

### `CopyableCommand` / `Code` / `Label`
- **Does**: Monospace command block with copy button, plain code block, and uppercase field label.

### `SetupProgress` / `formatBytes`
- **Does**: Payload shape for `woosh_setup` and `inference_setup` Tauri events, plus byte formatting for progress bars.
- **Interacts with**: `setup.rs` emits these events; `SetupPanels.tsx` listens.

### `SERVER_PORTS` / `urlsFromHost` / `hostFromUrl`
- **Does**: Single source of truth for default server ports and host↔URL derivation in unified-host mode.
- **Interacts with**: `SettingsView.tsx` config persistence.

### `KIND_COLOR` / `STATUS_COLOR`
- **Does**: Accent colour per model kind and per server status.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `SettingsView.tsx` | `SERVER_PORTS`, `urlsFromHost`, `hostFromUrl`, `useHardwareProfile`, `Label` | Renames, port changes |
| `ModelServerCards.tsx` | `MODELS`, `TTS_VARIANTS`, colour maps, `SfxServerHealth` | Changing `MODELS` shape |
| `SetupPanels.tsx` | `SetupProgress` matches `setup.rs` event payloads | Field renames |
| `SfxPanels.tsx` | `CopyableCommand`, `Code`, `HardwareProfile` | Prop changes |

## Notes
- `.tsx` (not `.ts`) because it hosts the small shared JSX components.
