#!/usr/bin/env bash
# Start all three Pharaoh inference servers.
# Usage:
#   ./inference/start_servers.sh            # stub mode
#   ./inference/start_servers.sh --real     # real model inference
#
# Python environments:
#   TTS / Music : conda env "pharoah"  (has qwen-tts, torch, soundfile)
#   SFX         : ~/Code/Woosh/.venv   (has woosh + torchaudio)
#   Fallback    : system python3       (stub mode only)
#
# Install ace-step in pharoah to enable real music:
#   conda activate pharoah && pip install ace-step
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL=${1:+1}
export PHARAOH_REAL_MODELS=${REAL:-0}

# Model directories
export PHARAOH_TTS_MODEL_DIR="${PHARAOH_TTS_MODEL_DIR:-$HOME/pharaoh-models/tts}"
export PHARAOH_MUSIC_MODEL_DIR="${PHARAOH_MUSIC_MODEL_DIR:-$HOME/pharaoh-models/music}"
export PHARAOH_WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"

# Resolve Python interpreters
CONDA_BASE="/opt/homebrew/Caskroom/miniforge/base"
PHAROAH_PYTHON="${CONDA_BASE}/envs/pharoah/bin/python3"
WOOSH_PYTHON="${PHARAOH_WOOSH_DIR}/.venv/bin/python3"

TTS_PYTHON="python3"
SFX_PYTHON="python3"
MUSIC_PYTHON="python3"

if [ "${PHARAOH_REAL_MODELS}" = "1" ]; then
    if [ -x "${PHAROAH_PYTHON}" ]; then
        TTS_PYTHON="${PHAROAH_PYTHON}"
        MUSIC_PYTHON="${PHAROAH_PYTHON}"
        echo "  TTS / Music: using pharoah conda env"
    fi
    if [ -x "${WOOSH_PYTHON}" ]; then
        SFX_PYTHON="${WOOSH_PYTHON}"
        echo "  SFX: using Woosh venv at ${PHARAOH_WOOSH_DIR}/.venv"
    fi
fi

cd "$SCRIPT_DIR"

echo "Starting Pharaoh inference servers (REAL_MODELS=${PHARAOH_REAL_MODELS})..."

"${TTS_PYTHON}"   tts_server.py   &
"${SFX_PYTHON}"   sfx_server.py   &
"${MUSIC_PYTHON}" music_server.py &

echo ""
echo "  TTS   → http://localhost:18001/health"
echo "  SFX   → http://localhost:18002/health"
echo "  Music → http://localhost:18003/health"
echo ""
echo "Press Ctrl-C to stop all servers."
wait
