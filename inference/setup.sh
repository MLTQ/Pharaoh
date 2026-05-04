#!/usr/bin/env bash
# One-shot setup for Pharaoh's inference servers.
#
# Creates two isolated uv venvs alongside this script:
#   inference/.venv-tts   → qwen-tts (transformers 4.57.3)
#   inference/.venv-music → ace-step (transformers 4.50.0)
#
# SFX continues to use the existing ~/Code/Woosh/.venv (which Woosh manages).
#
# Idempotent: re-running re-syncs deps but doesn't recreate working venvs.
# Override venv locations with PHARAOH_TTS_PYTHON / PHARAOH_MUSIC_PYTHON.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TTS_VENV="${SCRIPT_DIR}/.venv-tts"
MUSIC_VENV="${SCRIPT_DIR}/.venv-music"
WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"

# ── Colors ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
    YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
    BOLD=""; DIM=""; CYAN=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

step()  { printf "\n${BOLD}${CYAN}▸ %s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
fail()  { printf "  ${RED}✗${RESET} %s\n" "$1"; }
hint()  { printf "    ${DIM}%s${RESET}\n" "$1"; }

# ── Preflight ────────────────────────────────────────────────────────────────
step "Checking uv"
if ! command -v uv >/dev/null 2>&1; then
    fail "uv is not installed."
    hint "Install with:  curl -LsSf https://astral.sh/uv/install.sh | sh"
    hint "Or via brew:   brew install uv"
    exit 1
fi
ok "uv $(uv --version | awk '{print $2}')"

# ── TTS env ──────────────────────────────────────────────────────────────────
step "TTS env (.venv-tts)"
if [ ! -d "${TTS_VENV}" ]; then
    uv venv --python 3.11 "${TTS_VENV}"
    ok "Created ${TTS_VENV}"
else
    ok "Reusing ${TTS_VENV}"
fi
uv pip install --python "${TTS_VENV}/bin/python" -r "${SCRIPT_DIR}/requirements-tts.txt"
ok "TTS deps synced"

# ── Music env ────────────────────────────────────────────────────────────────
step "Music env (.venv-music)"
if [ ! -d "${MUSIC_VENV}" ]; then
    uv venv --python 3.11 "${MUSIC_VENV}"
    ok "Created ${MUSIC_VENV}"
else
    ok "Reusing ${MUSIC_VENV}"
fi
uv pip install --python "${MUSIC_VENV}/bin/python" -r "${SCRIPT_DIR}/requirements-music.txt"
ok "Music deps synced"

# ── SFX (Woosh) ──────────────────────────────────────────────────────────────
step "SFX env (Woosh)"
if [ -d "${WOOSH_DIR}" ]; then
    if [ -d "${WOOSH_DIR}/.venv" ]; then
        ok "Reusing ${WOOSH_DIR}/.venv"
    else
        warn "Woosh repo at ${WOOSH_DIR} has no .venv yet."
        hint "Run:  cd ${WOOSH_DIR} && uv sync"
    fi
else
    warn "Woosh repo not found at ${WOOSH_DIR}"
    hint "Clone:  git clone https://github.com/SonyResearch/Woosh ${WOOSH_DIR} && cd ${WOOSH_DIR} && uv sync"
    hint "Or set PHARAOH_WOOSH_DIR to an existing checkout."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
step "Done"
ok "Run all three servers with:  ./inference/start_servers.sh"
echo ""
echo "${DIM}Next: download model weights into the directories below if you haven't already:${RESET}"
echo "  TTS    → \$HOME/pharaoh-models/tts/{voice_design,base,custom_voice,tokenizer}/"
echo "  SFX    → ${WOOSH_DIR}/checkpoints/"
echo "  Music  → \$HOME/pharaoh-models/music/  (ACE-Step/ACE-Step-v1-3.5B)"
echo ""
echo "See the Models page in the app for the exact ${DIM}hf download${RESET} commands."
