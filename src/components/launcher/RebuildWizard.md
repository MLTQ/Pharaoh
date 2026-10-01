# RebuildWizard.tsx

## Purpose
"Rebuild from a recording" on the project launcher: turn a finished audio drama back into the Pharaoh project that could have made it — scenes, script, characters with voice references, sound effects, music, and remainder beds — so it can be edited and rendered out again.

## Components

### Source
- **Does**: Lists finished Dissect imports, or dissects a new recording in place (`dissectSubmit` + `dissectStore.track`) and continues automatically when it completes.

### Project (live plan)
- **Does**: Title (prefilled from tags), chapter checklist, "itemise sounds" and "keep everything else as beds" toggles. Every change re-asks `dissect_rebuild_plan` (debounced), so the preview — scenes, credit-named characters, row count, disk estimate against free space — is exactly what the backend will build. Blocks the build when the estimate doesn't fit.

### Rights + build
- **Does**: The rights confirmation is required (the project reproduces the recording's performances and clones its voices; Rust refuses without it too). Build starts `dissect_rebuild_start` and hands the job to `dissectStore.trackRebuild` (queue row, toast with "Open →"), so the wizard can be closed mid-build.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `ProjectLauncherView.tsx` | `onClose` | — |
| `commands/rebuild.rs` | `dissect_rebuild_plan(importId, options)` → `RebuildPlan`; `dissect_rebuild_start` → job id | Shape changes |
| `lib/openProject.ts` | `openProjectById(id)` loads project + scenes and shows the Pyramid | — |
