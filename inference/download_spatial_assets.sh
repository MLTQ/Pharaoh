#!/usr/bin/env bash
# Download Pharaoh's spatial-audio assets:
#   1. MIT KEMAR HRTF SOFA file (binaural placement)
#   2. Curated FOSS room impulse responses (spatial spaces)
#
# Best-effort: each URL is tried in turn; failures are logged and skipped
# so a partial install still works. The renderer treats missing files
# gracefully — that preset just shows up greyed out in the UI.
#
# Source attribution for the room IRs lives in assets/spaces/spaces.json.

set -uo pipefail  # NOT -e: we want to keep going after individual download failures.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOFA_DIR="$REPO_ROOT/assets/sofa"
SPACES_DIR="$REPO_ROOT/assets/spaces"
SPACES_MANIFEST="$SPACES_DIR/spaces.json"

mkdir -p "$SOFA_DIR" "$SPACES_DIR"

OK_COUNT=0
SKIP_COUNT=0
FAIL_COUNT=0

# ── Helper: download a single file with curl/wget fallback ──────────────────
download_one() {
  local url="$1"
  local out="$2"
  if [[ -f "$out" ]]; then
    echo "  already installed: $(basename "$out")"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    return 0
  fi
  if command -v curl > /dev/null 2>&1; then
    if curl -fSL --connect-timeout 10 --max-time 120 -o "$out.tmp" "$url" 2>/dev/null; then
      mv "$out.tmp" "$out"
      echo "  ✓ $(basename "$out")"
      OK_COUNT=$((OK_COUNT + 1))
      return 0
    fi
  elif command -v wget > /dev/null 2>&1; then
    if wget -q --timeout=120 -O "$out.tmp" "$url" 2>/dev/null; then
      mv "$out.tmp" "$out"
      echo "  ✓ $(basename "$out")"
      OK_COUNT=$((OK_COUNT + 1))
      return 0
    fi
  else
    echo "  ✗ need curl or wget on PATH" >&2
    return 1
  fi
  rm -f "$out.tmp"
  echo "  ✗ $(basename "$out")  (download failed; drop the file in manually if you have it)"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  return 1
}

# ── 1. MIT KEMAR HRTF SOFA ──────────────────────────────────────────────────
echo "── HRTF (binaural placement) ─────────────────────────────────"
SOFA_FILE="$SOFA_DIR/mit-kemar-normal.sofa"
SOFA_URLS=(
  "https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa"
  "https://sofacoustics.org/data/database_sofa_0.6/mit/mit_kemar_normal_pinna.sofa"
)
sofa_done=0
for url in "${SOFA_URLS[@]}"; do
  if [[ -f "$SOFA_FILE" ]]; then
    echo "  already installed: $(basename "$SOFA_FILE")"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    sofa_done=1
    break
  fi
  if download_one "$url" "$SOFA_FILE"; then
    sofa_done=1
    break
  fi
done
if [[ $sofa_done -eq 0 ]]; then
  echo "  (HRTF unavailable — Pharaoh falls back to ITD/ILD approximation)"
fi

# ── 2. Spatial spaces — curated room IRs ─────────────────────────────────────
echo ""
echo "── Spatial spaces (room reverb IRs) ──────────────────────────"
if [[ ! -f "$SPACES_MANIFEST" ]]; then
  echo "  ✗ no spaces.json manifest at $SPACES_MANIFEST" >&2
  exit 1
fi
if ! command -v python3 > /dev/null 2>&1; then
  echo "  ✗ need python3 on PATH to read the manifest" >&2
  exit 1
fi

# Iterate manifest entries and fetch each one that has both a URL and a file slot.
# A null url means "manual install only" — surfaced in the UI but not pulled here.
python3 - "$SPACES_MANIFEST" <<'PY' | while IFS=$'\t' read -r slug file url; do
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for sp in data["spaces"]:
    if sp.get("file") and sp.get("url"):
        print(f"{sp['slug']}\t{sp['file']}\t{sp['url']}")
PY
  out="$SPACES_DIR/$file"
  echo "  → $slug"
  download_one "$url" "$out" || true
done

# ── Summary ──
echo ""
echo "Summary:  $OK_COUNT installed · $SKIP_COUNT already present · $FAIL_COUNT failed"
if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "Failed downloads can be installed manually. The render path skips"
  echo "missing IRs gracefully — those presets just show up greyed in the UI."
fi
echo ""
echo "Done. Pharaoh's SpatializeModal will pick up new assets on next launch."
