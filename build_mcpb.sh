#!/usr/bin/env bash
# Build pharaoh.mcpb — Claude Desktop MCP Bundle
# Usage: ./build_mcpb.sh [output_path]
#
# Produces a .mcpb file (zip archive) containing:
#   manifest.json   — extension metadata and server config
#   run.py          — MCP server entry point
#   pyproject.toml  — Python dependencies (used by uv)
#
# Requirements: zip, uv (for local testing)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/servers/mcp"
OUT="${1:-$SCRIPT_DIR/pharaoh.mcpb}"

# Resolve to absolute path
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

echo "Building $OUT ..."

# Remove stale bundle
rm -f "$OUT"

# Pack — all files go into the root of the zip (no subdirectories)
cd "$SRC"
zip -j "$OUT" manifest.json run.py pyproject.toml

echo "Done: $OUT"
echo
echo "To install: open pharaoh.mcpb in Finder (Claude Desktop will handle the rest)"
echo "Or drag it into Claude Desktop's Extensions panel."
