#!/usr/bin/env bash
# Start all three Pharaoh inference servers.
# Usage: ./inference/start_servers.sh
#
# Python environments:
#   TTS / Music : conda env "pharoah"  (has qwen-tts, torch, soundfile)
#   SFX         : ~/Code/Woosh/.venv   (has woosh + torchaudio)
#
# First-time setup:
#   TTS:   models in ~/pharaoh-models/tts  (env: PHARAOH_TTS_MODEL_DIR)
#   SFX:   cd ~/Code/Woosh && uv sync      (env: PHARAOH_WOOSH_DIR)
#   Music: conda activate pharoah \
#            && pip install git+https://github.com/ace-step/ACE-Step.git \
#            && pip install torchcodec
#          (PyPI ace-step sdist is broken — install from git;
#           newer torchaudio.save() dispatches through torchcodec)
#          models in ~/pharaoh-models/music (env: PHARAOH_MUSIC_MODEL_DIR)
#          hf download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Model directories
export PHARAOH_TTS_MODEL_DIR="${PHARAOH_TTS_MODEL_DIR:-$HOME/pharaoh-models/tts}"
export PHARAOH_MUSIC_MODEL_DIR="${PHARAOH_MUSIC_MODEL_DIR:-$HOME/pharaoh-models/music}"
export PHARAOH_WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"

# Resolve Python interpreters
CONDA_BASE="/opt/homebrew/Caskroom/miniforge/base"
PHAROAH_PYTHON="${CONDA_BASE}/envs/pharoah/bin/python3"
WOOSH_PYTHON="${PHARAOH_WOOSH_DIR}/.venv/bin/python3"

if [ ! -x "${PHAROAH_PYTHON}" ]; then
    echo "ERROR: pharoah conda env not found at ${PHAROAH_PYTHON}"
    echo "  Create it: conda create -n pharoah python=3.11 && conda activate pharoah && pip install qwen-tts soundfile fastapi uvicorn aiofiles"
    exit 1
fi

if [ ! -x "${WOOSH_PYTHON}" ]; then
    echo "ERROR: Woosh venv not found at ${WOOSH_PYTHON}"
    echo "  Create it: cd ~/Code/Woosh && uv sync"
    exit 1
fi

echo "Starting Pharaoh inference servers..."
echo "  TTS / Music: ${PHAROAH_PYTHON}"
echo "  SFX:         ${WOOSH_PYTHON}"
echo ""

cd "$SCRIPT_DIR"

"${PHAROAH_PYTHON}" tts_server.py   &
"${WOOSH_PYTHON}"   sfx_server.py   &
"${PHAROAH_PYTHON}" music_server.py &

echo "  TTS   → http://localhost:18001/health"
echo "  SFX   → http://localhost:18002/health"
echo "  Music → http://localhost:18003/health"
echo ""
echo "Press Ctrl-C to stop all servers."
wait
