#!/usr/bin/env bash
# Build pharaoh.mcpb — Claude Desktop MCP Bundle
# Usage: ./build_mcpb.sh [output_path]
#
# Produces a .mcpb file (zip archive) containing:
#   manifest.json   — extension metadata and server config
#   pyproject.toml  — Python dependencies (used by uv)
#   run.py          — MCP server entry point
#   *.py            — the sibling modules run.py imports (config, server,
#                     projectfs, remote, resources, tools_*). Shipping only
#                     run.py made the installed bundle ModuleNotFoundError on
#                     launch, since run.py is a thin entry point.
#   assets/spaces/spaces.json — the spatial space catalog, so spatialize_row
#                     can validate space slugs inside the flat bundle.
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

# Pack — all files go into the root of the zip (no subdirectories), which is
# also why run.py prepends its own directory to sys.path.
cd "$SRC"
MODULES=(manifest.json pyproject.toml)
for f in *.py; do MODULES+=("$f"); done
zip -j "$OUT" "${MODULES[@]}"

# spaces.json normally resolves two directories up from projectfs.py; inside
# the flat bundle that path does not exist, so ship a copy alongside.
SPACES="$SCRIPT_DIR/assets/spaces/spaces.json"
if [ -f "$SPACES" ]; then
  zip -j "$OUT" "$SPACES"
fi

# Fail loudly if the entry point's imports are not all present in the bundle.
# List once into a variable: piping `unzip -l` into `grep -q` makes grep exit on
# the first match, and the resulting SIGPIPE trips `set -o pipefail`.
LISTING="$(unzip -Z1 "$OUT")"
missing=0
for m in config server projectfs remote resources \
         tools_project tools_generate tools_voice tools_jobs \
         tools_qa tools_audio tools_servers tools_compose; do
  case "$LISTING" in
    *"$m.py"*) ;;
    *) echo "ERROR: $m.py missing from bundle" >&2; missing=1 ;;
  esac
done
[ "$missing" -eq 0 ] || exit 1

echo "Done: $OUT"
echo
echo "To install: open pharaoh.mcpb in Finder (Claude Desktop will handle the rest)"
echo "Or drag it into Claude Desktop's Extensions panel."
