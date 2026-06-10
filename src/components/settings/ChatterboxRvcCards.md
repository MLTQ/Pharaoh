# ChatterboxRvcCards.tsx

## Purpose
Cards for the two servers that are not part of the core `MODELS` lifecycle: Chatterbox Turbo (manual ping health + start instructions) and RVC (URL only, shown in split mode). Pure presentation; state and persistence come from `SettingsView.tsx` via props.

## Components

### `ChatterboxRvcCards` / `ChatterboxRvcCardsProps`
- **Does**: Chatterbox card with click-to-ping health (split mode: URL input + health button; unified: derived URL + ping link) and startup commands; RVC card with a URL input, rendered only when `splitServers` is true.
- **Interacts with**: `Label` from `settingsShared.tsx`; URL persistence via `onChatterboxUrlBlur`/`onRvcUrlBlur` callbacks; health ping via `onCheckChatterboxHealth`.
- **Rationale**: Chatterbox/RVC are not in `modelStore`'s polled health loop, so their health is manual (`ChatterboxHealth` state owned by `SettingsView.tsx`).

### `ChatterboxHealth`
- **Does**: `"unknown" | "online" | "offline"` status type for the manual ping.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `SettingsView.tsx` | Props per `ChatterboxRvcCardsProps`; `ChatterboxHealth` type for its state | Prop/type changes |
| Users | Chatterbox start commands match `inference/setup.sh` + `chatterbox_server.py` | Changing server entry points without updating copy |

## Notes
- Health colours use literal hex (`#22c55e`/`#ef4444`) carried over from the pre-split file, unlike the CSS-variable colours elsewhere.
