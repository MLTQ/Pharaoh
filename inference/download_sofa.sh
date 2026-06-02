#!/usr/bin/env bash
# Compatibility shim — the canonical entry point is now download_spatial_assets.sh,
# which fetches both the HRTF SOFA and the room-IR starter pack in one pass.
exec "$(dirname "$0")/download_spatial_assets.sh" "$@"
