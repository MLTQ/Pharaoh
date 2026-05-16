#!/usr/bin/env bash
# One-shot setup for Pharaoh's inference servers.
#
# Creates isolated uv venvs alongside this script:
#   inference/.venv-tts   → qwen-tts (transformers 4.57.3)
#   inference/.venv-music → ace-step (transformers 4.50.0)
#   inference/.venv-audioldm → optional upstream AudioLDM runner
#   inference/.venv-audiosr → optional AudioSR upscaler
#
# SFX continues to use the existing ~/Code/Woosh/.venv (which Woosh manages).
# AudioLDM long-soundscape support is optional and isolated from Woosh because
# Woosh requires a much newer transformers stack.
#
# Idempotent: re-running re-syncs deps but doesn't recreate working venvs.
# Override venv locations with PHARAOH_TTS_PYTHON / PHARAOH_MUSIC_PYTHON.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TTS_VENV="${SCRIPT_DIR}/.venv-tts"
MUSIC_VENV="${SCRIPT_DIR}/.venv-music"
CHATTERBOX_VENV="${SCRIPT_DIR}/.venv-chatterbox"
AUDIOLDM_VENV="${SCRIPT_DIR}/.venv-audioldm"
AUDIOSR_VENV="${SCRIPT_DIR}/.venv-audiosr"
WOOSH_DIR="${PHARAOH_WOOSH_DIR:-$HOME/Code/Woosh}"
INSTALL_AUDIOLDM="${PHARAOH_INSTALL_AUDIOLDM:-0}"
INSTALL_AUDIOSR="${PHARAOH_INSTALL_AUDIOSR:-0}"
RVC_VENV="${SCRIPT_DIR}/.venv-rvc"
INSTALL_RVC="${PHARAOH_INSTALL_RVC:-0}"
INSTALL_CHATTERBOX="${PHARAOH_INSTALL_CHATTERBOX:-0}"
AUDIOLDM_CACHE_DIR="${PHARAOH_AUDIOLDM_CACHE_DIR:-${AUDIOLDM_CACHE_DIR:-$HOME/pharaoh-models/sfx/audioldm}}"

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

step "Checking audio tools"
if command -v sox >/dev/null 2>&1; then
    ok "SoX found at $(command -v sox)"
else
    warn "SoX is not installed."
    hint "Install with:  brew install sox"
    hint "Qwen3-TTS voice cloning can warn or fail during reference-audio preprocessing without it."
fi

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

# ── Optional Chatterbox Turbo ────────────────────────────────────────────────
step "Chatterbox env (.venv-chatterbox)"
if [ "${INSTALL_CHATTERBOX}" = "1" ]; then
    if [ ! -d "${CHATTERBOX_VENV}" ]; then
        uv venv --python 3.11 "${CHATTERBOX_VENV}"
        ok "Created ${CHATTERBOX_VENV}"
    else
        ok "Reusing ${CHATTERBOX_VENV}"
    fi
    uv pip install --python "${CHATTERBOX_VENV}/bin/python" \
        chatterbox-tts soundfile fastapi uvicorn httpx pydantic
    # chatterbox depends on `perth` which uses pkg_resources (removed in setuptools>=71).
    # Pin to a version that still ships the pkg_resources shim.
    uv pip install --python "${CHATTERBOX_VENV}/bin/python" "setuptools<71"
    ok "Chatterbox deps synced"
else
    hint "Optional 0-shot voice cloning + paralinguistic tags: PHARAOH_INSTALL_CHATTERBOX=1 ./inference/setup.sh"
fi

# ── Optional RVC voice conversion ────────────────────────────────────────────
step "RVC env (.venv-rvc)"
if [ "${INSTALL_RVC}" = "1" ]; then
    if [ ! -d "${RVC_VENV}" ]; then
        uv venv --python 3.11 "${RVC_VENV}"
        ok "Created ${RVC_VENV}"
    else
        ok "Reusing ${RVC_VENV}"
    fi
    uv pip install --python "${RVC_VENV}/bin/python" -r "${SCRIPT_DIR}/requirements-rvc.txt"
    ok "RVC deps synced"
    # rvc-python bundles HuBERT weights; they download on first use.
    # Training beyond rvc-python's API surface requires the full Applio repo.
    hint "RVC inference (convert) is ready. For training, see:"
    hint "  https://github.com/IAHispano/Applio"
else
    hint "Optional RVC voice conversion: PHARAOH_INSTALL_RVC=1 ./inference/setup.sh"
fi

# ── Optional SFX+ (AudioLDM) ─────────────────────────────────────────────────
step "SFX+ env (AudioLDM)"
if [ "${INSTALL_AUDIOLDM}" = "1" ]; then
    if [ ! -d "${AUDIOLDM_VENV}" ]; then
        uv venv --python 3.11 "${AUDIOLDM_VENV}"
        ok "Created ${AUDIOLDM_VENV}"
    else
        ok "Reusing ${AUDIOLDM_VENV}"
    fi
    uv pip install --python "${AUDIOLDM_VENV}/bin/python" -r "${SCRIPT_DIR}/requirements-sfx-audioldm.txt"
    ok "AudioLDM deps synced"
    if "${AUDIOLDM_VENV}/bin/python" -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)" >/dev/null 2>&1; then
        ok "AudioLDM CUDA candidate ranking available"
    else
        warn "AudioLDM CUDA is not available; Pharaoh will force one candidate per prompt on this machine."
        hint "This is expected on Apple Silicon/CPU. Upstream AudioLDM candidate ranking calls CUDA directly."
    fi
else
    hint "Optional long soundscapes: PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh"
fi

# ── Optional post (AudioSR) ──────────────────────────────────────────────────
step "Post env (AudioSR)"
if [ "${INSTALL_AUDIOSR}" = "1" ]; then
    if [ ! -d "${AUDIOSR_VENV}" ]; then
        uv venv --python 3.9 "${AUDIOSR_VENV}"
        ok "Created ${AUDIOSR_VENV}"
    else
        ok "Reusing ${AUDIOSR_VENV}"
    fi
    uv pip install --python "${AUDIOSR_VENV}/bin/python" -r "${SCRIPT_DIR}/requirements-audiosr.txt"
    ok "AudioSR deps synced"
else
    hint "Optional neural upscaling: PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
step "Done"
ok "Run available servers with:  ./inference/start_servers.sh"
echo ""
echo "${DIM}Next: download model weights into the directories below if you haven't already:${RESET}"
echo "  TTS    → \$HOME/pharaoh-models/tts/{voice_design,base,custom_voice,tokenizer}/"
echo "  SFX    → ${WOOSH_DIR}/checkpoints/"
echo "  SFX+   → ${AUDIOLDM_CACHE_DIR}/audioldm-m-full.ckpt  (native AudioLDM)"
echo "  Music  → \$HOME/pharaoh-models/music/  (ACE-Step/ACE-Step-v1-3.5B)"
echo "  Post   → AudioSR server runs on :18004; checkpoints download on first upscale"
echo "  Chatterbox → model weights download from HuggingFace on first /load call
  RVC        → HuBERT weights download on first /convert call; .pth/.index from training"
echo ""
echo "See the Models page in the app for the exact model download commands."
