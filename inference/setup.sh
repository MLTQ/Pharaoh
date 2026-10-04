#!/usr/bin/env bash
# One-shot setup for Pharaoh's inference servers.
#
# Creates isolated uv venvs alongside this script:
#   inference/.venv-breeze     → Breeze TTS 2: dialogue, voice design, cloning
#                                with direction (Python 3.11; Linux + NVIDIA)
#   inference/.venv-tts        → qwen-tts (transformers 4.57.3) — fallback TTS
#   inference/.venv-music      → ace-step (transformers 4.50.0): music on Macs,
#                                repaint/cover everywhere
#   inference/.venv-yue2       → YuE2 music (Python 3.12, Linux + NVIDIA; replaces
#                                ACE-Step for new music where it can run)
#   inference/.venv-audioldm   → optional upstream AudioLDM runner
#   inference/.venv-audiosr    → optional AudioSR upscaler
#   inference/.venv-rvc        → rvc-python for voice conversion (Python 3.9)
#   inference/.venv-applio     → Applio for RVC model training (Python 3.11)
#   inference/.venv-dissect    → voices from existing recordings: NeMo (source),
#                                BandIt Plus separator, Nemotron / TitaNet /
#                                Parakeet weights (Python 3.12, Linux + NVIDIA)
#
# Usage:
#   ./inference/setup.sh                 core envs + any optional ones enabled below
#   ./inference/setup.sh dissect         ONLY the named sections (forces them on);
#   ./inference/setup.sh core dissect    sections: core breeze yue2 chatterbox rvc
#                                        audioldm audiosr dissect applio
#
# Breeze defaults to "auto" like dissect (PHARAOH_INSTALL_BREEZE=0/1); its
# weights (~7 GB) go to PHARAOH_BREEZE_HOME (~/pharaoh-models/breeze).
#
# YuE2 defaults to "auto" too (PHARAOH_INSTALL_YUE2=0/1); its weights (~7.3 GB)
# go to the Hugging Face cache.
#
# Optional sections are switched on with PHARAOH_INSTALL_<NAME>=1. Dissect
# defaults to "auto": installed when an NVIDIA GPU is found on Linux, skipped
# elsewhere (PHARAOH_INSTALL_DISSECT=0 to skip, =1 to force).
# PHARAOH_DISSECT_PREFETCH=0 skips downloading its ~2.5 GB of model weights.
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
DISSECT_VENV="${SCRIPT_DIR}/.venv-dissect"
YUE2_VENV="${SCRIPT_DIR}/.venv-yue2"
INSTALL_YUE2="${PHARAOH_INSTALL_YUE2:-auto}"
BREEZE_VENV="${SCRIPT_DIR}/.venv-breeze"
INSTALL_BREEZE="${PHARAOH_INSTALL_BREEZE:-auto}"
BREEZE_HOME="${PHARAOH_BREEZE_HOME:-$HOME/pharaoh-models/breeze}"
BREEZE_REPO="${PHARAOH_BREEZE_REPO:-${BREEZE_HOME}/breeze-tts}"
BREEZE_MODEL_DIR="${PHARAOH_BREEZE_MODEL_DIR:-${BREEZE_HOME}/breeze-tts-2}"
BREEZE_COMMIT="58ec70c"
INSTALL_DISSECT="${PHARAOH_INSTALL_DISSECT:-auto}"
DISSECT_PREFETCH="${PHARAOH_DISSECT_PREFETCH:-1}"
DISSECT_MODEL_DIR="${PHARAOH_DISSECT_MODEL_DIR:-$HOME/pharaoh-models/dissect}"
MSST_COMMIT="84b1eac0887756b4f1a9d7a1ff49105939749ed2"
MSST_RELEASE="https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v.1.0.3"
AUDIOLDM_CACHE_DIR="${PHARAOH_AUDIOLDM_CACHE_DIR:-${AUDIOLDM_CACHE_DIR:-$HOME/pharaoh-models/sfx/audioldm}}"
APPLIO_VENV="${SCRIPT_DIR}/.venv-applio"
APPLIO_DIR="${PHARAOH_APPLIO_DIR:-${SCRIPT_DIR}/.applio}"
INSTALL_APPLIO="${PHARAOH_INSTALL_APPLIO:-0}"

# ── Sections ─────────────────────────────────────────────────────────────────
# With no arguments every section runs (optional ones per their flags). Naming
# sections runs only those and switches the named optional ones on.
KNOWN_SECTIONS="core breeze yue2 chatterbox rvc audioldm audiosr dissect applio"
SECTIONS=" "
for arg in "$@"; do
    case "${arg}" in
        -h|--help)
            sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
            exit 0 ;;
        core) ;;
        breeze) INSTALL_BREEZE="${PHARAOH_INSTALL_BREEZE:-auto}" ;;
        yue2) INSTALL_YUE2="${PHARAOH_INSTALL_YUE2:-auto}" ;;
        chatterbox) INSTALL_CHATTERBOX=1 ;;
        rvc) INSTALL_RVC=1 ;;
        audioldm) INSTALL_AUDIOLDM=1 ;;
        audiosr) INSTALL_AUDIOSR=1 ;;
        # Naming dissect still honours GPU auto-detection; only an explicit
        # PHARAOH_INSTALL_DISSECT=1 forces it onto a machine without one.
        dissect) INSTALL_DISSECT="${PHARAOH_INSTALL_DISSECT:-auto}" ;;
        applio) INSTALL_APPLIO=1 ;;
        *) echo "unknown section '${arg}' (known: ${KNOWN_SECTIONS})" >&2; exit 2 ;;
    esac
    SECTIONS="${SECTIONS}${arg} "
done
# True when this run includes section $1.
only() { [ "${SECTIONS}" = " " ] || [[ "${SECTIONS}" == *" $1 "* ]]; }

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

if only core; then
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

        # Woosh's uv sync installs CPU-only PyTorch by default.
        # If an NVIDIA GPU is present, reinstall torch with CUDA so the model
        # actually runs on GPU instead of silently falling back to CPU.
        WOOSH_PYTHON="${WOOSH_DIR}/.venv/bin/python3"
        if command -v nvidia-smi >/dev/null 2>&1 && [ -x "${WOOSH_PYTHON}" ]; then
            if "${WOOSH_PYTHON}" -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)" >/dev/null 2>&1; then
                ok "Woosh venv already has CUDA PyTorch"
            else
                echo "  NVIDIA GPU detected — reinstalling CUDA PyTorch into Woosh venv..."
                uv pip install --python "${WOOSH_PYTHON}" \
                    --extra-index-url https://download.pytorch.org/whl/cu128 \
                    --index-strategy unsafe-best-match \
                    "torch>=2.3" torchaudio
                ok "Woosh venv: CUDA PyTorch installed"
            fi
        else
            ok "Woosh venv: no NVIDIA GPU detected, using CPU/MPS PyTorch as-is"
        fi
    else
        warn "Woosh repo at ${WOOSH_DIR} has no .venv yet."
        hint "Run:  cd ${WOOSH_DIR} && uv sync"
        hint "Then re-run this script to apply the CUDA PyTorch patch."
    fi
else
    warn "Woosh repo not found at ${WOOSH_DIR}"
    hint "Clone:  git clone https://github.com/SonyResearch/Woosh ${WOOSH_DIR} && cd ${WOOSH_DIR} && uv sync"
    hint "Or set PHARAOH_WOOSH_DIR to an existing checkout."
    hint "Then re-run this script to apply the CUDA PyTorch patch."
fi

fi  # core

# ── Breeze TTS 2 (dialogue engine) ───────────────────────────────────────────
if only breeze; then
step "Breeze TTS 2 (.venv-breeze)"
if [ "${INSTALL_BREEZE}" = "auto" ]; then
    if [ "$(uname -s)" = "Linux" ] && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
        INSTALL_BREEZE=1; ok "NVIDIA GPU found — installing Breeze (PHARAOH_INSTALL_BREEZE=0 to skip)"
    else
        INSTALL_BREEZE=0; hint "Breeze needs an NVIDIA GPU (~8 GB); Qwen3-TTS stays the TTS engine here."
    fi
fi
if [ "${INSTALL_BREEZE}" = "1" ]; then
    mkdir -p "${BREEZE_HOME}"
    if [ ! -d "${BREEZE_REPO}/breeze_infer" ]; then
        git clone -q https://github.com/breezeblue-ai/breeze-tts.git "${BREEZE_REPO}"
        git -C "${BREEZE_REPO}" checkout -q "${BREEZE_COMMIT}" || warn "couldn't pin breeze-tts to ${BREEZE_COMMIT}; using its default branch"
        ok "breeze-tts code in ${BREEZE_REPO}"
    else
        ok "Reusing breeze-tts code in ${BREEZE_REPO}"
    fi
    [ -d "${BREEZE_VENV}" ] || uv venv -q --python 3.11 "${BREEZE_VENV}"
    uv pip install --python "${BREEZE_VENV}/bin/python" -r "${BREEZE_REPO}/requirements.txt" \
        fastapi uvicorn pydantic soundfile
    ok "Breeze deps synced"
    if [ ! -f "${BREEZE_MODEL_DIR}/config.json" ]; then
        # The weights' licence (BreezeBlue Research and Non-Commercial) comes
        # with the download: https://huggingface.co/BreezeBlue/Breeze-TTS-2
        if [ -x "${BREEZE_VENV}/bin/hf" ]; then
            "${BREEZE_VENV}/bin/hf" download BreezeBlue/Breeze-TTS-2 --local-dir "${BREEZE_MODEL_DIR}"
        else
            "${BREEZE_VENV}/bin/huggingface-cli" download BreezeBlue/Breeze-TTS-2 --local-dir "${BREEZE_MODEL_DIR}"
        fi
        ok "Breeze TTS 2 weights in ${BREEZE_MODEL_DIR} (research / non-commercial licence)"
    else
        ok "Reusing Breeze weights in ${BREEZE_MODEL_DIR}"
    fi
    # Take checker (Whisper) — fetched now so the first generation doesn't stall.
    "${BREEZE_VENV}/bin/python" -c "from transformers import pipeline; pipeline('automatic-speech-recognition', model='${PHARAOH_BREEZE_ASR:-openai/whisper-small.en}')" >/dev/null 2>&1 \
        && ok "Take checker ready" || warn "Take checker download failed; Breeze runs without retake checks"
else
    [ "${INSTALL_BREEZE}" = "0" ] && hint "Breeze skipped (PHARAOH_INSTALL_BREEZE=1 ./inference/setup.sh breeze to force)"
fi
fi  # breeze

# ── Optional Chatterbox Turbo ────────────────────────────────────────────────
if only chatterbox; then
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
fi  # chatterbox

# ── Optional RVC voice conversion ────────────────────────────────────────────
if only rvc; then
step "RVC env (.venv-rvc)"
if [ "${INSTALL_RVC}" = "1" ]; then
    # IMPORTANT: rvc-python's transitive deps (fairseq, hydra) have a
    # dataclass mutable-default incompatibility with Python 3.10+. The venv
    # MUST be Python 3.9. uv can install 3.9 automatically via `uv python install 3.9`.
    RVC_PYTHON_BIN="$(uv python find 3.9 2>/dev/null || true)"
    if [ -z "${RVC_PYTHON_BIN}" ]; then
        echo "  Installing Python 3.9 via uv..."
        uv python install 3.9
        RVC_PYTHON_BIN="$(uv python find 3.9)"
    fi
    if [ ! -d "${RVC_VENV}" ]; then
        # Use vanilla venv (not uv venv) to ensure pkg_resources is available —
        # uv venv omits pkg_resources from setuptools, which pyworld requires.
        "${RVC_PYTHON_BIN}" -m venv "${RVC_VENV}"
        ok "Created ${RVC_VENV} (Python 3.9)"
    else
        ok "Reusing ${RVC_VENV}"
    fi
    # Use venv pip directly (not uv pip) to avoid pkg_resources issues.
    # Pin pip to <24.1: rvc-python depends on omegaconf==2.0.6 whose metadata
    # uses the invalid `.*` version suffix. pip>=24.1 rejects it outright;
    # pip<24.1 (21.x–23.x) installs it with a warning.
    "${RVC_VENV}/bin/python3" -m pip install -q "pip<24.1" setuptools
    "${RVC_VENV}/bin/python3" -m pip install -q -r "${SCRIPT_DIR}/requirements-rvc.txt"
    ok "RVC deps synced"
    # rvc-python bundles HuBERT weights; they download on first use.
    # Training beyond rvc-python's API surface requires the full Applio repo.
    hint "RVC inference (convert) is ready. For full model training, see:"
    hint "  https://github.com/IAHispano/Applio"
else
    hint "Optional RVC voice conversion: PHARAOH_INSTALL_RVC=1 ./inference/setup.sh"
fi
fi  # rvc

# ── Optional SFX+ (AudioLDM) ─────────────────────────────────────────────────
if only audioldm; then
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
fi  # audioldm

# ── Optional post (AudioSR) ──────────────────────────────────────────────────
if only audiosr; then
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
fi  # audiosr

# Linux + NVIDIA: the GPU-only envs (YuE2, dissect) auto-install here.
dissect_gpu() {
    [ "$(uname -s)" = "Linux" ] && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1
}
# Free GiB on the filesystem holding $1 (0 if unknown).
free_gib() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {printf "%d", $4 / 1048576}'; }

# ── YuE2 music ───────────────────────────────────────────────────────────────
if only yue2; then
step "YuE2 music env (.venv-yue2)"
if [ "${INSTALL_YUE2}" = "auto" ]; then
    if dissect_gpu; then
        INSTALL_YUE2=1
        ok "NVIDIA GPU found — installing YuE2 (PHARAOH_INSTALL_YUE2=0 to skip)"
    else
        INSTALL_YUE2=0
        hint "Skipped: YuE2 needs Linux + an NVIDIA GPU with BF16; music uses ACE-Step here."
    fi
fi
if [ "${INSTALL_YUE2}" = "1" ]; then
    if [ ! -d "${YUE2_VENV}" ]; then
        uv venv --python 3.12 "${YUE2_VENV}"
        ok "Created ${YUE2_VENV}"
    else
        ok "Reusing ${YUE2_VENV}"
    fi
    uv pip install --python "${YUE2_VENV}/bin/python" -r "${SCRIPT_DIR}/requirements-yue2.txt"
    ok "YuE2 deps synced"
    for repo in m-a-p/YuE2-3B m-a-p/YuE2-Vae; do
        if "${YUE2_VENV}/bin/hf" download "${repo}" >/dev/null; then
            ok "${repo} cached"
        else
            warn "Download of ${repo} failed — re-run ./inference/setup.sh yue2"
        fi
    done
fi
fi  # yue2

# ── Dissect (separation + diarization + ASR) ────────────────────────────────

if only dissect; then
step "Dissect env (.venv-dissect, voices from existing recordings)"
if [ "${INSTALL_DISSECT}" = "auto" ]; then
    if dissect_gpu; then
        INSTALL_DISSECT=1
        ok "NVIDIA GPU found — installing dissect (PHARAOH_INSTALL_DISSECT=0 to skip)"
    else
        INSTALL_DISSECT=0
        hint "Skipped: dissect needs Linux + an NVIDIA GPU. Run this on your GPU host,"
        hint "or force with: PHARAOH_INSTALL_DISSECT=1 ./inference/setup.sh dissect"
    fi
fi
if [ "${INSTALL_DISSECT}" = "1" ]; then
    DISSECT_OK=1
    dissect_gpu || warn "No NVIDIA GPU detected — dissect will install but run very slowly (or not at all)."
    if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
        fail "ffmpeg/ffprobe not found — the dissect server decodes every source with them."
        hint "Install with your package manager (e.g. sudo apt install ffmpeg / sudo pacman -S ffmpeg), then re-run."
        DISSECT_OK=0
    fi
    HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"
    mkdir -p "${DISSECT_MODEL_DIR}" "${HF_CACHE}"
    for d in "${SCRIPT_DIR}" "${DISSECT_MODEL_DIR}" "${HF_CACHE}"; do
        g="$(free_gib "$d")"
        if [ -n "$g" ] && [ "$g" -lt 20 ]; then
            warn "Only ${g} GiB free under ${d} — dissect needs ~12 GiB (venv) + ~3 GiB (weights)."
        fi
    done
fi
if [ "${INSTALL_DISSECT}" = "1" ] && [ "${DISSECT_OK}" = "1" ]; then
    if [ ! -d "${DISSECT_VENV}" ]; then
        uv venv --python 3.12 "${DISSECT_VENV}"
        ok "Created ${DISSECT_VENV}"
    else
        ok "Reusing ${DISSECT_VENV}"
    fi
    # Nemotron-3-Diarization's RoPE encoder is only in NeMo from source, which
    # needs torch >= 2.7 — hence torch 2.8 / CUDA 12.8 here, unlike other envs.
    uv pip install --python "${DISSECT_VENV}/bin/python" \
        "torch==2.8.0" "torchaudio==2.8.0" --index-url https://download.pytorch.org/whl/cu128
    uv pip install --python "${DISSECT_VENV}/bin/python" Cython packaging
    uv pip install --python "${DISSECT_VENV}/bin/python" -r "${SCRIPT_DIR}/requirements-dissect.txt" \
        "torch==2.8.0" "torchaudio==2.8.0" \
        --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match
    ok "Dissect deps synced"

    # Separator code, pinned. An existing checkout is moved to the pin.
    MSST_DIR="${DISSECT_MODEL_DIR}/msst"
    if [ ! -d "${MSST_DIR}/.git" ]; then
        rm -rf "${MSST_DIR}"
        git clone -q https://github.com/ZFTurbo/Music-Source-Separation-Training "${MSST_DIR}"
    fi
    if [ "$(git -C "${MSST_DIR}" rev-parse HEAD)" != "${MSST_COMMIT}" ]; then
        git -C "${MSST_DIR}" fetch -q origin
        git -C "${MSST_DIR}" checkout -q "${MSST_COMMIT}"
    fi
    ok "Separator code at ${MSST_COMMIT:0:8} → ${MSST_DIR}"

    # Separator weights: download to .part, keep only if non-trivial.
    for f in config_dnr_bandit_bsrnn_multi_mus64.yaml model_bandit_plus_dnr_sdr_11.47.chpt; do
        dest="${DISSECT_MODEL_DIR}/${f}"
        if [ ! -s "${dest}" ]; then
            curl -fL --retry 3 -o "${dest}.part" "${MSST_RELEASE}/${f}"
            mv "${dest}.part" "${dest}"
        fi
    done
    SEP_MB=$(( $(wc -c < "${DISSECT_MODEL_DIR}/model_bandit_plus_dnr_sdr_11.47.chpt") / 1048576 ))
    if [ "${SEP_MB}" -lt 100 ]; then
        fail "Separator checkpoint is only ${SEP_MB} MB — the download looks truncated. Delete it and re-run."
    else
        ok "BandIt Plus separator weights (${SEP_MB} MB)"
    fi

    # NeMo checkpoints: fetch now so the first import doesn't stall on ~2.5 GB.
    if [ "${DISSECT_PREFETCH}" = "1" ]; then
        echo "  Downloading Nemotron-3-Diarization, TitaNet-large, Parakeet TDT 0.6B v3 …"
        if (cd "${SCRIPT_DIR}" && "${DISSECT_VENV}/bin/python" dissect_pipeline.py --prefetch); then
            ok "NeMo model weights cached in ${HF_CACHE}"
        else
            warn "Weight prefetch failed — they will download on the first import instead."
        fi
    else
        hint "Skipped weight prefetch (PHARAOH_DISSECT_PREFETCH=0); they download on the first import."
    fi

    echo "  Verifying …"
    if (cd "${SCRIPT_DIR}" && "${DISSECT_VENV}/bin/python" dissect_pipeline.py --check); then
        ok "Dissect ready — start it with ./inference/start_servers.sh (port 18007)"
        hint "Remote clients: open the port on this host's firewall (e.g. sudo ufw allow 18007/tcp)."
    else
        fail "Dissect verification failed (see ✗ lines above). The server would fall back to stub mode."
    fi
fi
fi  # dissect

# ── Optional Applio (RVC model training) ────────────────────────────────────
if only applio; then
step "Applio env (.venv-applio, for RVC model training)"
if [ "${INSTALL_APPLIO}" = "1" ]; then
    # Clone Applio (shallow) if not already present.
    if [ ! -d "${APPLIO_DIR}" ]; then
        if ! command -v git >/dev/null 2>&1; then
            fail "git is required to clone Applio."
            hint "Install with: xcode-select --install  (macOS) or brew install git"
            exit 1
        fi
        echo "  Cloning Applio (shallow) …"
        git clone --depth 1 https://github.com/IAHispano/Applio "${APPLIO_DIR}"
        ok "Cloned Applio → ${APPLIO_DIR}"
    else
        ok "Reusing Applio at ${APPLIO_DIR}"
        # Pull latest if we have a full checkout (shallow clones silently skip).
        git -C "${APPLIO_DIR}" pull --ff-only --quiet 2>/dev/null || true
    fi

    # Applio needs Python 3.11 — it has patched the fairseq compat issues that
    # affect rvc-python, so we don't need the Python 3.9 constraint here.
    if [ ! -d "${APPLIO_VENV}" ]; then
        uv venv --python 3.11 "${APPLIO_VENV}"
        ok "Created ${APPLIO_VENV}"
    else
        ok "Reusing ${APPLIO_VENV}"
    fi

    # Install Applio's requirements.
    # requirements.txt is the canonical dep file; requirements-no-gpu.txt is
    # provided by some Applio versions for CPU-only installs.
    APPLIO_REQS="${APPLIO_DIR}/requirements.txt"
    if [ ! -f "${APPLIO_REQS}" ]; then
        fail "Applio requirements.txt not found at ${APPLIO_REQS}"
        hint "The clone may be incomplete. Remove ${APPLIO_DIR} and re-run."
        exit 1
    fi
    uv pip install --python "${APPLIO_VENV}/bin/python" \
        --extra-index-url https://download.pytorch.org/whl/cu128 \
        --index-strategy unsafe-best-match \
        -r "${APPLIO_REQS}"
    ok "Applio deps synced"

    hint "Applio GUI:   ${APPLIO_VENV}/bin/python ${APPLIO_DIR}/app.py"
    hint "Applio CLI:   POST /train on the RVC server will use Applio automatically."
else
    hint "Optional RVC training: PHARAOH_INSTALL_APPLIO=1 ./inference/setup.sh"
fi
fi  # applio

# ── Done ─────────────────────────────────────────────────────────────────────
step "Done"
ok "Run available servers with:  ./inference/start_servers.sh"
echo ""
echo "${DIM}Next: download model weights into the directories below if you haven't already:${RESET}"
echo "  TTS    → \$HOME/pharaoh-models/tts/{voice_design,base,custom_voice,tokenizer}/"
echo "  SFX    → ${WOOSH_DIR}/checkpoints/"
echo "  SFX+   → ${AUDIOLDM_CACHE_DIR}/audioldm-m-full.ckpt  (native AudioLDM)"
echo "  Music  → YuE2 weights fetched above on NVIDIA hosts; ACE-Step (Macs, repaint/cover) → \$HOME/pharaoh-models/music/  (ACE-Step/ACE-Step-v1-3.5B)"
echo "  Post   → AudioSR server runs on :18004; checkpoints download on first upscale"
echo "  Chatterbox → model weights download from HuggingFace on first /load call"
echo "  RVC        → HuBERT weights download on first /convert call; .pth/.index from Applio training"
echo "  Applio     → pretrained G/D + HuBERT download on first training run (auto, ~1 GB)"
echo "  Dissect    → separator + NeMo weights fetched above (PHARAOH_DISSECT_PREFETCH=0 defers them to the first import)"
echo ""
echo "See the Models page in the app for the exact model download commands."
