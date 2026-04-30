#!/usr/bin/env bash
# Start all three Pharaoh inference servers in stub mode.
# Usage: ./inference/start_servers.sh [--real]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL=${1:+1}
export PHARAOH_REAL_MODELS=${REAL:-0}

cd "$SCRIPT_DIR"

echo "Starting Pharaoh inference servers (REAL_MODELS=${PHARAOH_REAL_MODELS})..."
python3 tts_server.py   &
python3 sfx_server.py   &
python3 music_server.py &

echo "TTS   → http://localhost:18001/health"
echo "SFX   → http://localhost:18002/health"
echo "Music → http://localhost:18003/health"
echo ""
echo "Press Ctrl-C to stop all servers."
wait
