# script.rs

## Purpose
Tauri commands for reading and mutating scene `script.csv` files. This file is intentionally thin and delegates path and CSV behavior to shared helpers.

## Components

### `read_script`
- **Does**: Reads all rows for a scene script.
- **Interacts with**: `read_script_rows` in `app_support.rs`, `CompositionView.tsx`.

### `write_script`
- **Does**: Rewrites a full scene script atomically.
- **Interacts with**: `write_script_rows` in `app_support.rs`.

### `update_script_row`
- **Does**: Applies a sparse patch to one row and writes the script back atomically.
- **Interacts with**: `update_script_row_fields` in `app_support.rs`, timeline and asset selection UI.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `CompositionView.tsx` | Row updates preserve CSV field order and semantics | Field rename/removal |
| `AssetBrowser.tsx` | `file` updates target the configured project root | Path resolution changes |
| `cli.rs` | GUI and CLI mutate script rows identically | Divergent write logic |

## Notes
- The important behavior here is not the command wrappers themselves; it is that both GUI and CLI now resolve scripts through the same configured project root.
