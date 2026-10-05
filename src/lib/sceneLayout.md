# sceneLayout.ts

## Purpose
Run the scene layout (`layout_scene_rows`) from the app, and arm it to run after "generate all".

## Components

### `layOutScene(projectId, sceneSlug, replace)`
- **Does**: Flushes debounced edits, lays the scene out, and fires `SCRIPT_ASSETS_CHANGED_EVENT` so open views re-read the script.

### `layoutWhenSceneIdle` / `checkArmedLayouts`
- **Does**: Arms a layout for a scene; the job store calls `checkArmedLayouts` after jobs end, and it runs once the scene has no running jobs (so voice lock and AudioSR finish first).

## Notes
- The Composition header's **Lay out** button keeps rows you placed; ⌥-click re-places everything.
