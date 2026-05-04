#!/usr/bin/env bash
# Start all three Pharaoh inference servers.
# Usage: ./inference/start_servers.sh
#
# First time? Run:  ./inference/setup.sh
#
# Python interpreters (override via env vars):
#   TTS   : inference/.venv-tts/bin/python3       (PHARAOH_TTS_PYTHON)
#   Music : inference/.venv-music/bin/python3     (PHARAOH_MUSIC_PYTHON)
#   SFX   : ~/Code/Woosh/.venv/bin/python3        (PHARAOH_WOOSH_DIR)
#
# These three envs MUST be separate — qwen-tts and ace-step pin
# incompatible transformers versions.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Model directories
export PHARAOH_TTS_MODEL_DIR="${PHARAOH_TTS_MODEL_DIR:-$HOME/pharaoh-models/tts}"
export PHARAOH_MUSIC_MODEL_DIR="${PHARAOH_MUSIC_MODEL_DIR:-$HOME/pharaoh-models/music}"
export PHARAOH_WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"

# Resolve Python interpreters — uv venvs by default, overridable.
TTS_PYTHON="${PHARAOH_TTS_PYTHON:-${SCRIPT_DIR}/.venv-tts/bin/python3}"
MUSIC_PYTHON="${PHARAOH_MUSIC_PYTHON:-${SCRIPT_DIR}/.venv-music/bin/python3}"
WOOSH_PYTHON="${PHARAOH_WOOSH_DIR}/.venv/bin/python3"

missing=0
check_python() {
    local label="$1" py="$2" hint="$3"
    if [ ! -x "${py}" ]; then
        echo "ERROR: ${label} interpreter not found at ${py}"
        echo "  ${hint}"
        missing=1
    fi
}
check_python "TTS"   "${TTS_PYTHON}"   "Run: ./inference/setup.sh"
check_python "Music" "${MUSIC_PYTHON}" "Run: ./inference/setup.sh"
check_python "SFX"   "${WOOSH_PYTHON}" "Run: cd ${PHARAOH_WOOSH_DIR} && uv sync (or set PHARAOH_WOOSH_DIR)"
[ "$missing" -eq 0 ] || exit 1

echo "Starting Pharaoh inference servers..."
echo "  TTS   : ${TTS_PYTHON}"
echo "  SFX   : ${WOOSH_PYTHON}"
echo "  Music : ${MUSIC_PYTHON}"
echo ""

cd "$SCRIPT_DIR"

"${TTS_PYTHON}"   tts_server.py   &
"${WOOSH_PYTHON}" sfx_server.py   &
"${MUSIC_PYTHON}" music_server.py &

echo "  TTS   → http://localhost:18001/health"
echo "  SFX   → http://localhost:18002/health"
echo "  Music → http://localhost:18003/health"
echo ""
echo "Press Ctrl-C to stop all servers."
wait
