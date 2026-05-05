# styles.css

## Purpose
Global application styling for Pharaoh's shell, timeline, panels, queues, and reusable primitive classes. It defines the core visual tokens and shared class selectors used by React components.

## Components

### Theme tokens
- **Does**: Defines background, foreground, accent, and model colors as CSS variables.
- **Interacts with**: All React components via `var(--...)`.

### Shared controls and layout classes
- **Does**: Styles buttons, inputs, rails, panels, timeline clips, asset rows, and job rows.
- **Interacts with**: `App.tsx`, generator panels, `AssetBrowser.tsx`, `JobQueue.tsx`.

### Job model badges
- **Does**: Colors `tts`, `sfx`, `music`, and `post` job labels in the right-rail queue.
- **Interacts with**: `JobQueue.tsx`, `types.ts`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| React components | Class names remain stable for shared primitives | Renaming/removing shared selectors |
| `JobQueue.tsx` | Job model classes have readable badge styling | Adding a model kind without a badge rule |

## Notes
- Page-specific layout should stay in components unless the selector is reused across multiple screens.
