# ProjectLauncherView.tsx

## Purpose
No-project start screen for Pharaoh. It lists existing projects, creates new projects, and hands successful opens into the real project workspace.

## Components

### `ProjectLauncherView`
- **Does**: Loads projects and project directory, renders project cards, new-project form, and the Settings link.
- **Interacts with**: `projectStore`, `tauriCommands.ts`, optional `onOpenSettings` callback from `App.tsx`.
- **Rationale**: Settings can be shown inside the launcher shell without mutating the persisted project workspace view.

### `NewProjectForm`
- **Does**: Captures title/logline/tone and creates a project through Tauri.
- **Interacts with**: `createProject` in `tauriCommands.ts`.

### `ProjectCard`
- **Does**: Compact selectable card for opening a recent project.
- **Interacts with**: `listScenes`, `loadRealProject`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | `onOpenSettings` opens launcher-local Settings when no project is loaded | Forcing global `setView("settings")` from the launcher |
| `projectStore` | `loadRealProject(project, dir, scenes)` enters the full workspace | Changing project-open flow |

## Notes
- The fallback Settings click still calls `setView("settings")` for compatibility if the component is ever rendered outside the launcher shell.
