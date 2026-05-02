#!/usr/bin/env bash
# Start all three Pharaoh inference servers.
# Usage:
#   ./inference/start_servers.sh            # stub mode (no real models)
#   ./inference/start_servers.sh --real     # real model inference
#
# Real-mode prerequisites:
#   TTS:   pip install qwen-tts soundfile   (set PHARAOH_TTS_MODEL_DIR=~/pharaoh-models/tts)
#   SFX:   uv sync in $PHARAOH_WOOSH_DIR    (uses WOOSH_DIR/.venv/bin/python3 automatically)
#   Music: pip install ace-step soundfile   (set PHARAOH_MUSIC_MODEL_DIR=~/pharaoh-models/music)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL=${1:+1}
export PHARAOH_REAL_MODELS=${REAL:-0}

# Default model dirs (override with env vars)
export PHARAOH_TTS_MODEL_DIR="${PHARAOH_TTS_MODEL_DIR:-$HOME/pharaoh-models/tts}"
export PHARAOH_MUSIC_MODEL_DIR="${PHARAOH_MUSIC_MODEL_DIR:-$HOME/pharaoh-models/music}"
export PHARAOH_WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"

cd "$SCRIPT_DIR"

echo "Starting Pharaoh inference servers (REAL_MODELS=${PHARAOH_REAL_MODELS})..."

# TTS server — use system python3 (install qwen-tts there)
python3 tts_server.py &

# SFX server — use Woosh venv when available (created by: cd ~/Code/Woosh && uv sync)
SFX_PYTHON="python3"
if [ "${PHARAOH_REAL_MODELS}" = "1" ] && [ -x "${PHARAOH_WOOSH_DIR}/.venv/bin/python3" ]; then
    SFX_PYTHON="${PHARAOH_WOOSH_DIR}/.venv/bin/python3"
    echo "  SFX: using Woosh venv at ${PHARAOH_WOOSH_DIR}/.venv"
fi
"${SFX_PYTHON}" sfx_server.py &

# Music server — use system python3 (install ace-step there)
python3 music_server.py &

echo ""
echo "  TTS   → http://localhost:18001/health"
echo "  SFX   → http://localhost:18002/health"
echo "  Music → http://localhost:18003/health"
echo ""
echo "Press Ctrl-C to stop all servers."
wait
