#!/usr/bin/env bash
# Download the MIT KEMAR HRTF SOFA file for Pharaoh's spatial audio renderer.
#
# This is a one-time setup step. The file is ~3 MB and gets dropped into
# assets/sofa/mit-kemar-normal.sofa, where the audio engine looks for it at
# render time. If you skip this step the renderer falls back to a pure-ffmpeg
# binaural approximation that works fine but lacks true HRTF cues.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOFA_DIR="$REPO_ROOT/assets/sofa"
SOFA_FILE="$SOFA_DIR/mit-kemar-normal.sofa"

mkdir -p "$SOFA_DIR"

if [[ -f "$SOFA_FILE" ]]; then
  echo "SOFA file already present at $SOFA_FILE"
  echo "Delete it and re-run if you want to refetch."
  exit 0
fi

# Candidate mirrors — try each in order. The SOFA Conventions site is the
# canonical host; the OpenAir mirror is the standard backup.
URLS=(
  "https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa"
  "https://sofacoustics.org/data/database_sofa_0.6/mit/mit_kemar_normal_pinna.sofa"
)

for url in "${URLS[@]}"; do
  echo "Trying $url ..."
  if command -v curl > /dev/null 2>&1; then
    if curl -fSL --connect-timeout 10 -o "$SOFA_FILE.tmp" "$url"; then
      mv "$SOFA_FILE.tmp" "$SOFA_FILE"
      break
    fi
  elif command -v wget > /dev/null 2>&1; then
    if wget -q --timeout=10 -O "$SOFA_FILE.tmp" "$url"; then
      mv "$SOFA_FILE.tmp" "$SOFA_FILE"
      break
    fi
  else
    echo "Need curl or wget on PATH to download." >&2
    exit 1
  fi
  rm -f "$SOFA_FILE.tmp"
done

if [[ -f "$SOFA_FILE" ]]; then
  size_kb=$(( $(wc -c < "$SOFA_FILE") / 1024 ))
  echo "Installed: $SOFA_FILE (${size_kb} KB)"
  echo "Pharaoh will use HRTF-based binaural rendering on next render."
else
  echo "All mirrors failed. Pharaoh will fall back to the ITD+ILD" >&2
  echo "approximation, which works but lacks HRTF cues. You can drop" >&2
  echo "any SOFA file into $SOFA_DIR/ manually." >&2
  exit 1
fi
