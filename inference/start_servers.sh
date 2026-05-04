#!/usr/bin/env bash
# Start all three Pharaoh inference servers.
# Usage: ./inference/start_servers.sh
#
# Python environments (must be separate — incompatible deps):
#   TTS   : conda env "pharoah"        (qwen-tts → transformers==4.57.3, accelerate==1.12.0)
#   SFX   : ~/Code/Woosh/.venv         (woosh + torchaudio)
#   Music : conda env "pharoah-music"  (ace-step → transformers==4.50.0)
#
# First-time setup:
#   TTS:
#     conda create -n pharoah python=3.11 -y
#     conda activate pharoah
#     pip install qwen-tts soundfile fastapi uvicorn aiofiles
#     # models:
#     # hf download Qwen/Qwen3-TTS-Tokenizer-12Hz --local-dir ~/pharaoh-models/tts/tokenizer
#     # hf download Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign --local-dir ~/pharaoh-models/tts/voice_design
#     # hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base        --local-dir ~/pharaoh-models/tts/base
#
#   SFX:
#     cd ~/Code/Woosh && uv sync
#
#   Music (separate env — ace-step pins transformers==4.50.0 which conflicts with qwen-tts):
#     conda create -n pharoah-music python=3.11 -y
#     conda activate pharoah-music
#     pip install fastapi uvicorn aiofiles soundfile pydantic
#     pip install git+https://github.com/ace-step/ACE-Step.git   # PyPI sdist is broken
#     pip install torchcodec                                      # torchaudio.save dispatches through it
#     # models:
#     # hf download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music
#
# Override env Python paths via PHARAOH_TTS_PYTHON / PHARAOH_MUSIC_PYTHON / PHARAOH_WOOSH_DIR.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Model directories
export PHARAOH_TTS_MODEL_DIR="${PHARAOH_TTS_MODEL_DIR:-$HOME/pharaoh-models/tts}"
export PHARAOH_MUSIC_MODEL_DIR="${PHARAOH_MUSIC_MODEL_DIR:-$HOME/pharaoh-models/music}"
export PHARAOH_WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"

# Resolve Python interpreters
CONDA_BASE="${CONDA_BASE:-/opt/homebrew/Caskroom/miniforge/base}"
PHAROAH_PYTHON="${PHARAOH_TTS_PYTHON:-${CONDA_BASE}/envs/pharoah/bin/python3}"
MUSIC_PYTHON="${PHARAOH_MUSIC_PYTHON:-${CONDA_BASE}/envs/pharoah-music/bin/python3}"
WOOSH_PYTHON="${PHARAOH_WOOSH_DIR}/.venv/bin/python3"

if [ ! -x "${PHAROAH_PYTHON}" ]; then
    echo "ERROR: pharoah conda env not found at ${PHAROAH_PYTHON}"
    echo "  Create it: conda create -n pharoah python=3.11 -y && conda activate pharoah && pip install qwen-tts soundfile fastapi uvicorn aiofiles"
    exit 1
fi

if [ ! -x "${WOOSH_PYTHON}" ]; then
    echo "ERROR: Woosh venv not found at ${WOOSH_PYTHON}"
    echo "  Create it: cd ~/Code/Woosh && uv sync"
    exit 1
fi

if [ ! -x "${MUSIC_PYTHON}" ]; then
    echo "ERROR: pharoah-music conda env not found at ${MUSIC_PYTHON}"
    echo "  Create it (must be separate from pharoah — ace-step's deps conflict with qwen-tts):"
    echo "    conda create -n pharoah-music python=3.11 -y \\"
    echo "      && conda activate pharoah-music \\"
    echo "      && pip install fastapi uvicorn aiofiles soundfile pydantic \\"
    echo "      && pip install git+https://github.com/ace-step/ACE-Step.git \\"
    echo "      && pip install torchcodec"
    exit 1
fi

echo "Starting Pharaoh inference servers..."
echo "  TTS   : ${PHAROAH_PYTHON}"
echo "  SFX   : ${WOOSH_PYTHON}"
echo "  Music : ${MUSIC_PYTHON}"
echo ""

cd "$SCRIPT_DIR"

"${PHAROAH_PYTHON}" tts_server.py   &
"${WOOSH_PYTHON}"   sfx_server.py   &
"${MUSIC_PYTHON}"   music_server.py &

echo "  TTS   → http://localhost:18001/health"
echo "  SFX   → http://localhost:18002/health"
echo "  Music → http://localhost:18003/health"
echo ""
echo "Press Ctrl-C to stop all servers."
wait
