import { useState } from "react";
import { CopyableCommand, Code, type HardwareProfile } from "./settingsShared";

// Woosh install commands per GPU backend
const WOOSH_CLONE = "git clone https://github.com/SonyResearch/Woosh && cd Woosh";
const AUDIOLDM_M_FULL_URL = "https://zenodo.org/record/7813012/files/audioldm-m-full.ckpt?download=1";
const AUDIOLDM_M_FULL_DOWNLOAD = `mkdir -p "$HOME/pharaoh-models/sfx/audioldm" && curl -L -C - -o "$HOME/pharaoh-models/sfx/audioldm/audioldm-m-full.ckpt" "${AUDIOLDM_M_FULL_URL}"`;
const WOOSH_VARIANTS: Record<string, { label: string; cmd: string }> = {
  cuda: { label: "NVIDIA CUDA",      cmd: `${WOOSH_CLONE} && uv sync --extra cuda` },
  mps:  { label: "Apple Silicon MPS", cmd: `${WOOSH_CLONE} && uv sync` },
  cpu:  { label: "CPU only",          cmd: `${WOOSH_CLONE} && uv sync --extra cpu` },
};

// ── Woosh checkpoint breakdown ────────────────────────────────────────────────

const WOOSH_CHECKPOINTS = [
  {
    name: "Woosh-AE",
    zip: "Woosh-AE.zip",
    size: "0.8 GB",
    role: "required",
    desc: "Audio encoder/decoder — compresses waveforms to latents and back. Every generative model depends on this.",
  },
  {
    name: "TextConditionerA",
    zip: "TextConditionerA.zip",
    size: "1.2 GB",
    role: "required",
    desc: "Text encoder for audio models — conditions DFlow and Flow on your text prompt. Required for text-to-audio.",
  },
  {
    name: "Woosh-DFlow",
    zip: "Woosh-DFlow.zip",
    size: "1.2 GB",
    role: "recommended",
    desc: "Distilled flow-matching generator, ~4 steps. This is the model Pharaoh calls for foley generation (~5 s clips).",
  },
  {
    name: "Woosh-Flow",
    zip: "Woosh-Flow.zip",
    size: "1.2 GB",
    role: "optional",
    desc: "Non-distilled generator — same quality ceiling as DFlow but more NFE steps. Use if DFlow artefacts are audible.",
  },
  {
    name: "Woosh-CLAP",
    zip: "Woosh-CLAP.zip",
    size: "1.5 GB",
    role: "optional",
    desc: "Audio-language model for CLAP scoring (ranking generated clips by prompt alignment). Not required for generation.",
  },
  {
    name: "TextConditionerV",
    zip: "TextConditionerV.zip",
    size: "1.2 GB",
    role: "skip",
    desc: "Text encoder for video-conditioned models (VFlow/DVFlow). Not needed if you skip video-to-audio.",
  },
  {
    name: "Woosh-VFlow-8s",
    zip: "Woosh-VFlow-8s.zip",
    size: "1.5 GB",
    role: "skip",
    desc: "Video-conditioned generator (8 s). Takes a video clip as input. Not used by Pharaoh.",
  },
  {
    name: "Woosh-DVFlow-8s",
    zip: "Woosh-DVFlow-8s.zip",
    size: "1.5 GB",
    role: "skip",
    desc: "Distilled video-conditioned generator (8 s). Also video-to-audio; not used by Pharaoh.",
  },
];

const ROLE_COLOR: Record<string, string> = {
  required:    "var(--st-rendered)",
  recommended: "var(--tts)",
  optional:    "var(--fg-3)",
  skip:        "var(--fg-4)",
};

function WooshCheckpoints() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginBottom: 2 }}>
        Download from{" "}
        <a
          href="https://github.com/SonyResearch/Woosh/releases"
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--sfx)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 10.5 }}
        >
          github.com/SonyResearch/Woosh/releases
        </a>
        {" "}— each checkpoint ships as a .zip that extracts into the Woosh root directory.
      </div>
      {WOOSH_CHECKPOINTS.map((c) => (
        <div
          key={c.name}
          style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            opacity: c.role === "skip" ? 0.45 : 1,
          }}
        >
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.07em",
            textTransform: "uppercase", color: ROLE_COLOR[c.role],
            flexShrink: 0, paddingTop: 1, minWidth: 74,
          }}>
            {c.role}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-1)" }}>
                {c.name}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)" }}>
                {c.size}
              </span>
            </div>
            <span style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
              {c.desc}
            </span>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginBottom: 4 }}>
          After downloading, extract all zips inside your Woosh clone:
        </div>
        <Code>{`cd ~/path/to/Woosh\nunzip ~/Downloads/Woosh-AE.zip\nunzip ~/Downloads/TextConditionerA.zip\nunzip ~/Downloads/Woosh-DFlow.zip`}</Code>
      </div>
    </div>
  );
}

export function SfxDownloads() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{
          fontFamily: "var(--font-mono)", fontSize: 10.5,
          color: "var(--sfx)", marginBottom: 6,
        }}>
          Woosh · short foley checkpoints
        </div>
        <WooshCheckpoints />
      </div>

      <div>
        <div style={{
          fontFamily: "var(--font-mono)", fontSize: 10.5,
          color: "var(--sfx)", marginBottom: 6,
        }}>
          AudioLDM · long soundscapes
        </div>
        <div style={{
          fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.6,
          marginBottom: 6,
        }}>
          AudioLDM is optional. Pharaoh uses the upstream AudioLDM runner by default;
          install it below with <code>PHARAOH_INSTALL_AUDIOLDM=1</code>. Download the native
          <code>audioldm-m-full</code> checkpoint manually if the first-run downloader fails;
          the command is resumable and writes to Pharaoh's SFX model directory.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
              <span style={{ color: "var(--sfx)", fontFamily: "var(--font-mono)" }}>Native AudioLDM-M-Full</span>
              {" — "}recommended checkpoint, resumable download
            </div>
            <CopyableCommand command={AUDIOLDM_M_FULL_DOWNLOAD} />
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
              <span style={{ color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>Diffusers fallback only</span>
              {" — "}not used by the default native runner
            </div>
            <CopyableCommand command="hf download cvssp/audioldm-s-full-v2 --local-dir ~/pharaoh-models/sfx/audioldm-s-full-v2" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Woosh install helper ──────────────────────────────────────────────────────

export function WooshInstall({ hw }: { hw: HardwareProfile | null }) {
  const [showAll, setShowAll] = useState(false);

  const detected = hw ? WOOSH_VARIANTS[hw.gpu] : null;
  const others = Object.entries(WOOSH_VARIANTS).filter(([k]) => k !== hw?.gpu);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Detected / primary */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: hw ? "var(--st-rendered)" : "var(--fg-4)",
          whiteSpace: "nowrap",
        }}>
          {hw ? `Detected: ${detected?.label ?? hw.gpu}${hw.gpu_name ? ` · ${hw.gpu_name}` : ""}` : "Detecting…"}
        </span>
      </div>

      {detected ? (
        <CopyableCommand command={detected.cmd} />
      ) : (
        <div style={{
          fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-4)",
          padding: "6px 10px", border: "1px solid var(--line-1)", borderRadius: 2,
        }}>
          Detecting hardware…
        </div>
      )}

      {/* Other variants toggle */}
      <button
        onClick={() => setShowAll((s) => !s)}
        style={{
          alignSelf: "flex-start",
          fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.05em",
          color: "var(--fg-4)", background: "none", border: "none",
          cursor: "pointer", padding: 0, marginTop: 2,
        }}
      >
        {showAll ? "▾ hide other variants" : "▸ other hardware"}
      </button>

      {showAll && others.map(([, v]) => (
        <div key={v.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5,
            color: "var(--fg-4)", letterSpacing: "0.05em",
          }}>{v.label}</span>
          <CopyableCommand command={v.cmd} />
        </div>
      ))}
    </div>
  );
}
