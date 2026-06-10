# projectStore.ts

## Purpose

Zustand store holding the open project: mock-shaped UI state (`project`,
`scenes`, `cast`) mirrored against the real Tauri-backed `Project` / `Scene`
records, plus the character list and active-scene selection.

## Persistence & error surfacing

- `persist()` (internal) fire-and-forgets `updateProject` to disk after every
  mutation (`updateProjectMeta`, `addCharacter`, `removeCharacter`,
  `updateCharacter`, `updateVoiceAssignment`).
- **Save failures are not silent.** A failed project save raises a
  "Project save failed" error toast via `lib/errors.reportError` with the
  stable toast id `project-save-failed`: repeated failures refresh one toast
  instead of stacking, and the next *successful* save dismisses it. Scene
  saves (`updateScene` → `updateScene` Tauri command) behave the same with id
  `scene-save-failed`.
- `reloadProjectFromDisk` failures toast "Project reload failed".

## Contracts

- `loadRealProject(project, projectsDir, scenes)` replaces all state with the
  opened project; first scene becomes active.
- `reloadProjectFromDisk()` re-reads project + scenes, preserving the active
  scene and selected character when they still exist.
- `realSceneToMock` / `deriveSlug` are exported helpers used by launcher and
  timeline views.

## Dependencies

- `lib/tauriCommands` (updateProject, updateScene, getProject, listScenes)
- `lib/errors` (reportError), `store/toastStore` (dismiss-on-success)
