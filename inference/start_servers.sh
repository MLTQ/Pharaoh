#!/usr/bin/env bash
# Start Pharaoh inference servers.
# Usage: ./inference/start_servers.sh
#
# First time? Run:  ./inference/setup.sh
#
# Python interpreters (override via env vars):
#   TTS        : Breeze TTS 2 when installed — inference/.venv-breeze (PHARAOH_BREEZE_PYTHON),
#                else Qwen3-TTS — inference/.venv-tts (PHARAOH_TTS_PYTHON).
#                PHARAOH_TTS_ENGINE=qwen|breeze forces one. Both serve port 18001.
#   Music      : YuE2 when installed — inference/.venv-yue2 (PHARAOH_YUE2_PYTHON),
#                else ACE-Step — inference/.venv-music (PHARAOH_MUSIC_PYTHON).
#                PHARAOH_MUSIC_ENGINE=yue2|ace-step forces one. Both serve port 18003;
#                the YuE2 server still runs ACE-Step from .venv-music for repaint/cover.
#   SFX        : ~/Code/Woosh/.venv/bin/python3            (PHARAOH_WOOSH_DIR)
#                optional AudioLDM runner: inference/.venv-audioldm/bin/python3
#   Post       : inference/.venv-audiosr/bin/python3       (optional AudioSR)
#   Chatterbox : inference/.venv-chatterbox/bin/python3    (PHARAOH_CHATTERBOX_PYTHON)
#   RVC        : inference/.venv-rvc/bin/python3           (PHARAOH_RVC_PYTHON)
#   Dissect    : inference/.venv-dissect/bin/python3       (PHARAOH_DISSECT_PYTHON)
#
# These envs MUST be separate — qwen-tts, ace-step, Woosh, AudioLDM,
# chatterbox-tts, and rvc-python all pin or expect incompatible stacks.
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
RVC_PYTHON="${PHARAOH_RVC_PYTHON:-${SCRIPT_DIR}/.venv-rvc/bin/python3}"
DISSECT_PYTHON="${PHARAOH_DISSECT_PYTHON:-${SCRIPT_DIR}/.venv-dissect/bin/python3}"
BREEZE_PYTHON="${PHARAOH_BREEZE_PYTHON:-${SCRIPT_DIR}/.venv-breeze/bin/python3}"
export PHARAOH_BREEZE_HOME="${PHARAOH_BREEZE_HOME:-$HOME/pharaoh-models/breeze}"
BREEZE_WEIGHTS="${PHARAOH_BREEZE_MODEL_DIR:-${PHARAOH_BREEZE_HOME}/breeze-tts-2}/config.json"
# Breeze replaces Qwen as the TTS engine when it's installed.
TTS_ENGINE="${PHARAOH_TTS_ENGINE:-}"
if [ -z "${TTS_ENGINE}" ]; then
    if [ -x "${BREEZE_PYTHON}" ] && [ -f "${BREEZE_WEIGHTS}" ]; then TTS_ENGINE=breeze; else TTS_ENGINE=qwen; fi
fi
YUE2_PYTHON="${PHARAOH_YUE2_PYTHON:-${SCRIPT_DIR}/.venv-yue2/bin/python3}"
# YuE2 replaces ACE-Step as the music engine when it's installed.
MUSIC_ENGINE="${PHARAOH_MUSIC_ENGINE:-}"
if [ -z "${MUSIC_ENGINE}" ]; then
    if [ -x "${YUE2_PYTHON}" ]; then MUSIC_ENGINE=yue2; else MUSIC_ENGINE=ace-step; fi
fi
export PHARAOH_MUSIC_PYTHON="${MUSIC_PYTHON}"
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
if [ "${TTS_ENGINE}" = "breeze" ]; then
    check_python "TTS (Breeze)" "${BREEZE_PYTHON}" "Run: ./inference/setup.sh breeze"
else
    check_python "TTS"   "${TTS_PYTHON}"   "Run: ./inference/setup.sh"
fi
if [ "${MUSIC_ENGINE}" = "yue2" ]; then
    check_python "Music (YuE2)" "${YUE2_PYTHON}" "Run: ./inference/setup.sh yue2"
else
    check_python "Music" "${MUSIC_PYTHON}" "Run: ./inference/setup.sh"
fi
check_python "SFX"   "${WOOSH_PYTHON}" "Run: cd ${PHARAOH_WOOSH_DIR} && uv sync (or set PHARAOH_WOOSH_DIR)"
[ "$missing" -eq 0 ] || exit 1

echo "Starting Pharaoh inference servers..."
if [ "${TTS_ENGINE}" = "breeze" ]; then
    echo "  TTS   : ${BREEZE_PYTHON} (Breeze TTS 2)"
else
    echo "  TTS   : ${TTS_PYTHON} (Qwen3-TTS)"
fi
echo "  SFX   : ${WOOSH_PYTHON} (Woosh)"
echo "  SFX+  : ${PHARAOH_AUDIOLDM_PYTHON} (optional AudioLDM runner)"
echo "  SFX+ models: ${AUDIOLDM_CACHE_DIR}"
if [ "${MUSIC_ENGINE}" = "yue2" ]; then
    echo "  Music : ${YUE2_PYTHON} (YuE2; repaint/cover via ${MUSIC_PYTHON})"
else
    echo "  Music : ${MUSIC_PYTHON} (ACE-Step)"
fi
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
if [ -x "${RVC_PYTHON}" ]; then
    echo "  RVC        : ${RVC_PYTHON}"
else
    echo "  RVC        : not installed (PHARAOH_INSTALL_RVC=1 ./inference/setup.sh)"
fi
if [ -x "${DISSECT_PYTHON}" ]; then
    echo "  Dissect    : ${DISSECT_PYTHON}"
else
    echo "  Dissect    : not installed (./inference/setup.sh dissect — Linux + NVIDIA)"
fi
echo ""

cd "$SCRIPT_DIR"

if [ "${TTS_ENGINE}" = "breeze" ]; then
    "${BREEZE_PYTHON}" breeze_server.py &
else
    "${TTS_PYTHON}"   tts_server.py   &
fi
"${WOOSH_PYTHON}" sfx_server.py   &
if [ "${MUSIC_ENGINE}" = "yue2" ]; then
    "${YUE2_PYTHON}" yue2_music_server.py &
else
    "${MUSIC_PYTHON}" music_server.py &
fi
if [ -x "${POST_PYTHON}" ]; then
    "${POST_PYTHON}" post_server.py &
fi
if [ -x "${CHATTERBOX_PYTHON}" ]; then
    "${CHATTERBOX_PYTHON}" chatterbox_server.py &
fi
if [ -x "${RVC_PYTHON}" ]; then
    "${RVC_PYTHON}" rvc_server.py &
fi
if [ -x "${DISSECT_PYTHON}" ]; then
    "${DISSECT_PYTHON}" dissect_server.py &
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
if [ -x "${RVC_PYTHON}" ]; then
    echo "  RVC        → http://localhost:18006/health"
fi
if [ -x "${DISSECT_PYTHON}" ]; then
    echo "  Dissect    → http://localhost:18007/health"
fi
echo ""
echo "Press Ctrl-C to stop all servers."
wait
