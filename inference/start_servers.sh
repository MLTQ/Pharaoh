#!/usr/bin/env bash
# Start Pharaoh inference servers.
# Usage: ./inference/start_servers.sh
#
# First time? Run:  ./inference/setup.sh
#
# Python interpreters (override via env vars):
#   TTS        : inference/.venv-tts/bin/python3           (PHARAOH_TTS_PYTHON)
#   Music      : inference/.venv-music/bin/python3         (PHARAOH_MUSIC_PYTHON)
#   SFX        : ~/Code/Woosh/.venv/bin/python3            (PHARAOH_WOOSH_DIR)
#                optional AudioLDM runner: inference/.venv-audioldm/bin/python3
#   Post       : inference/.venv-audiosr/bin/python3       (optional AudioSR)
#   Chatterbox : inference/.venv-chatterbox/bin/python3    (PHARAOH_CHATTERBOX_PYTHON)
#
# These envs MUST be separate — qwen-tts, ace-step, Woosh, AudioLDM, and
# chatterbox-tts all pin or expect incompatible transformers/runtime stacks.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Model directories
export PHARAOH_TTS_MODEL_DIR="${PHARAOH_TTS_MODEL_DIR:-$HOME/pharaoh-models/tts}"
export PHARAOH_MUSIC_MODEL_DIR="${PHARAOH_MUSIC_MODEL_DIR:-$HOME/pharaoh-models/music}"
export PHARAOH_WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"
export PHARAOH_AUDIOLDM_CACHE_DIR="${PHARAOH_AUDIOLDM_CACHE_DIR:-${AUDIOLDM_CACHE_DIR:-$HOME/pharaoh-models/sfx/audioldm}}"
export AUDIOLDM_CACHE_DIR="${PHARAOH_AUDIOLDM_CACHE_DIR}"
export PHARAOH_AUDIOLDM_PYTHON="${PHARAOH_AUDIOLDM_PYTHON:-${SCRIPT_DIR}/.venv-audioldm/bin/python3}"

# Resolve Python interpreters — uv venvs by default, overridable.
TTS_PYTHON="${PHARAOH_TTS_PYTHON:-${SCRIPT_DIR}/.venv-tts/bin/python3}"
MUSIC_PYTHON="${PHARAOH_MUSIC_PYTHON:-${SCRIPT_DIR}/.venv-music/bin/python3}"
POST_PYTHON="${PHARAOH_POST_PYTHON:-${SCRIPT_DIR}/.venv-audiosr/bin/python3}"
CHATTERBOX_PYTHON="${PHARAOH_CHATTERBOX_PYTHON:-${SCRIPT_DIR}/.venv-chatterbox/bin/python3}"
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
echo "  SFX   : ${WOOSH_PYTHON} (Woosh)"
echo "  SFX+  : ${PHARAOH_AUDIOLDM_PYTHON} (optional AudioLDM runner)"
echo "  SFX+ models: ${AUDIOLDM_CACHE_DIR}"
echo "  Music : ${MUSIC_PYTHON}"
if [ -x "${POST_PYTHON}" ]; then
    echo "  Post       : ${POST_PYTHON} (AudioSR)"
else
    echo "  Post       : not installed (PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh)"
fi
if [ -x "${CHATTERBOX_PYTHON}" ]; then
    echo "  Chatterbox : ${CHATTERBOX_PYTHON}"
else
    echo "  Chatterbox : not installed (PHARAOH_INSTALL_CHATTERBOX=1 ./inference/setup.sh)"
fi
echo ""

cd "$SCRIPT_DIR"

"${TTS_PYTHON}"   tts_server.py   &
"${WOOSH_PYTHON}" sfx_server.py   &
"${MUSIC_PYTHON}" music_server.py &
if [ -x "${POST_PYTHON}" ]; then
    "${POST_PYTHON}" post_server.py &
fi
if [ -x "${CHATTERBOX_PYTHON}" ]; then
    "${CHATTERBOX_PYTHON}" chatterbox_server.py &
fi

echo "  TTS        → http://localhost:18001/health"
echo "  SFX        → http://localhost:18002/health"
echo "  Music      → http://localhost:18003/health"
if [ -x "${POST_PYTHON}" ]; then
    echo "  Post       → http://localhost:18004/health"
fi
if [ -x "${CHATTERBOX_PYTHON}" ]; then
    echo "  Chatterbox → http://localhost:18005/health"
fi
echo ""
echo "Press Ctrl-C to stop all servers."
wait
