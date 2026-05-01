import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModelStore } from "../../store/modelStore";

// ── Hardware detection ────────────────────────────────────────────────────────

interface HardwareProfile {
  os: string;
  arch: string;
  gpu: "cuda" | "mps" | "cpu";
  gpu_name: string;
}

function useHardwareProfile(): HardwareProfile | null {
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  useEffect(() => {
    invoke<HardwareProfile>("detect_hardware").then(setHw).catch(() => null);
  }, []);
  return hw;
}

// Woosh install commands per GPU backend
const WOOSH_CLONE = "git clone https://github.com/SonyResearch/Woosh && cd Woosh";
const WOOSH_VARIANTS: Record<string, { label: string; cmd: string }> = {
  cuda: { label: "NVIDIA CUDA",      cmd: `${WOOSH_CLONE} && uv sync --extra cuda` },
  mps:  { label: "Apple Silicon MPS", cmd: `${WOOSH_CLONE} && uv sync` },
  cpu:  { label: "CPU only",          cmd: `${WOOSH_CLONE} && uv sync --extra cpu` },
};

// ── Model definitions ─────────────────────────────────────────────────────────

const TTS_VARIANTS = [
  { id: "CustomVoice-1.7B", hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", desc: "9 preset voices + instruction control" },
  { id: "VoiceDesign-1.7B", hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", desc: "Free-form voice description via natural language" },
  { id: "Base-1.7B",        hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",        desc: "3-second voice cloning" },
  { id: "CustomVoice-0.6B", hf_id: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", desc: "Preset voices, lightweight (0.6B)" },
  { id: "Base-0.6B",        hf_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",        desc: "Voice cloning, lightweight (0.6B)" },
];

const MODELS = [
  {
    kind: "tts" as const,
    label: "Qwen3-TTS",
    description: "Voice synthesis — 24 kHz · 5 variants",
    port: 18001,
    variants: TTS_VARIANTS,
    install: "pip install qwen-tts soundfile",
  },
  {
    kind: "sfx" as const,
    label: "Woosh (Sony Research)",
    description: "Sound design — fixed ~5s clips · 48 kHz",
    port: 18002,
    variants: null as null,
    install: null as null, // determined at runtime by hardware detection
  },
  {
    kind: "music" as const,
    label: "ACE-Step v1 (3.5B)",
    description: "Music generation — lyrics + caption · 48 kHz",
    port: 18003,
    variants: null as null,
    install: "git clone https://github.com/ACE-Step/ACE-Step && cd ACE-Step && pip install -e .",
  },
];

// ── Colours ───────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<string, string> = {
  tts:   "var(--tts)",
  sfx:   "var(--sfx)",
  music: "var(--music)",
};

const STATUS_COLOR: Record<string, string> = {
  online:  "var(--st-rendered)",
  offline: "var(--sfx)",
  loading: "var(--st-gen)",
  unknown: "var(--fg-4)",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
      <code style={{
        flex: 1,
        display: "block",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: 2,
        padding: "6px 10px",
        color: "var(--fg-1)",
        userSelect: "text",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        lineHeight: 1.6,
      }}>
        {command}
      </code>
      <button
        onClick={handleCopy}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          padding: "4px 10px",
          background: copied ? "var(--st-rendered)" : "var(--bg-0)",
          border: `1px solid ${copied ? "var(--st-rendered)" : "var(--line-1)"}`,
          borderRadius: 2,
          color: copied ? "var(--bg-0)" : "var(--fg-3)",
          cursor: "pointer",
          flexShrink: 0,
          alignSelf: "stretch",
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code style={{
      display: "block",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      background: "var(--bg-1)",
      border: "1px solid var(--line-1)",
      borderRadius: 2,
      padding: "6px 10px",
      color: "var(--fg-1)",
      userSelect: "text",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      lineHeight: 1.6,
    }}>
      {children}
    </code>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "var(--font-mono)",
      fontSize: 9.5,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "var(--fg-3)",
      marginBottom: 4,
    }}>
      {children}
    </div>
  );
}

// ── Woosh checkpoint breakdown ────────────────────────────────────────────────

const WOOSH_CHECKPOINTS = [
  {
    name: "Woosh-AE",
    role: "required",
    desc: "Audio encoder/decoder — compresses waveforms to latents and reconstructs audio from them. Every generative model depends on this.",
  },
  {
    name: "Woosh-CLAP",
    role: "required",
    desc: "Text-audio alignment model — turns your text prompt into token latents that condition the diffusion model. Required for text-to-audio.",
  },
  {
    name: "Woosh-DFlow",
    role: "recommended",
    desc: "Distilled flow-matching generator — produces SFX from text in ~4 steps. This is the model Pharaoh calls for foley generation.",
  },
  {
    name: "Woosh-Flow",
    role: "optional",
    desc: "Non-distilled generator — same quality ceiling as DFlow but requires more diffusion steps. Use if DFlow artefacts are audible.",
  },
  {
    name: "Woosh-VFlow",
    role: "skip",
    desc: "Video-conditioned generator — synthesises audio from a video clip. Not used by Pharaoh.",
  },
  {
    name: "Woosh-DVFlow",
    role: "skip",
    desc: "Distilled VFlow. Also video-to-audio; not used by Pharaoh.",
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
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-1)" }}>
              {c.name}
            </span>
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
        <Code>{`cd ~/path/to/Woosh\nunzip ~/Downloads/Woosh-AE.zip\nunzip ~/Downloads/Woosh-CLAP.zip\nunzip ~/Downloads/Woosh-DFlow.zip`}</Code>
      </div>
    </div>
  );
}

// ── Woosh install helper ──────────────────────────────────────────────────────

function WooshInstall({ hw }: { hw: HardwareProfile | null }) {
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

// ── Main component ────────────────────────────────────────────────────────────

export const SettingsView: React.FC = () => {
  const hw = useHardwareProfile();
  const { tts, sfx, music, health, updateServerConfig } = useModelStore();

  const statusMap = { tts, sfx, music };
  const healthMap = { tts: health.tts, sfx: health.sfx, music: health.music };

  const [urls, setUrls] = useState({
    tts:   `http://127.0.0.1:18001`,
    sfx:   `http://127.0.0.1:18002`,
    music: `http://127.0.0.1:18003`,
  });

  const handleUrlBlur = async (kind: "tts" | "sfx" | "music") => {
    await updateServerConfig({ [`${kind}_url`]: urls[kind] });
  };

  return (
    <div className="panel-view" style={{ overflowY: "auto" }}>
      <div style={{ maxWidth: 780, padding: "28px 32px" }}>
        <div style={{ marginBottom: 28 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Pharaoh</div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, lineHeight: 1.2 }}>Settings</h1>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 6 }}>
            Inference server URLs and model downloads. Use the <strong>Models</strong> tab to load and unload models.
          </div>
        </div>

        {/* ── Server cards ─────────────────────────────────────────────── */}
        <div style={{ marginBottom: 8 }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Inference servers</div>
        </div>

        {MODELS.map((m) => {
          const status = statusMap[m.kind];
          const h = healthMap[m.kind];
          const accent = KIND_COLOR[m.kind];

          return (
            <div
              key={m.kind}
              style={{
                border: "1px solid var(--line-1)",
                background: "var(--bg-1)",
                borderRadius: 3,
                marginBottom: 14,
                overflow: "hidden",
              }}
            >
              {/* Header */}
              <div style={{
                borderBottom: "1px solid var(--line-1)",
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: STATUS_COLOR[status] ?? "var(--fg-4)",
                  boxShadow: status === "online" ? `0 0 5px ${STATUS_COLOR[status]}` : "none",
                  flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{m.label}</span>
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9.5,
                  color: "var(--fg-3)",
                  marginLeft: 2,
                }}>:{m.port}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{m.description}</span>
              </div>

              {/* Body */}
              <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
                {/* URL + health */}
                <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <Label>Server URL</Label>
                    <input
                      type="text"
                      value={urls[m.kind]}
                      onChange={(e) => setUrls((prev) => ({ ...prev, [m.kind]: e.target.value }))}
                      onBlur={() => handleUrlBlur(m.kind)}
                      style={{
                        width: "100%",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        background: "var(--bg-0)",
                        border: "1px solid var(--line-1)",
                        borderRadius: 2,
                        padding: "5px 8px",
                        color: "var(--fg-1)",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                    <Label>Health</Label>
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      padding: "4px 10px",
                      background: "var(--bg-0)",
                      border: "1px solid var(--line-1)",
                      borderRadius: 2,
                      color: STATUS_COLOR[status] ?? "var(--fg-4)",
                    }}>
                      {status}
                      {h?.vram_mb ? ` · ${h.vram_mb} MB` : ""}
                    </span>
                  </div>
                </div>

                {/* Active variant (TTS only) */}
                {m.kind === "tts" && h?.model_variant && (
                  <div>
                    <Label>Active variant</Label>
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      color: accent,
                    }}>{h.model_variant}</span>
                  </div>
                )}

                {/* Model downloads */}
                <div>
                  <Label>Model downloads</Label>
                  {m.kind === "tts" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {TTS_VARIANTS.map((v) => (
                        <div key={v.id}>
                          <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
                            <span style={{ color: accent, fontFamily: "var(--font-mono)" }}>{v.id}</span>
                            {" — "}{v.desc}
                          </div>
                          <CopyableCommand command={`hf download ${v.hf_id} --local-dir ~/pharaoh-models/tts`} />
                        </div>
                      ))}
                    </div>
                  ) : m.kind === "sfx" ? (
                    <WooshCheckpoints />
                  ) : (
                    <CopyableCommand command={`hf download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music`} />
                  )}
                </div>

                {/* Install */}
                <div>
                  <Label>Install</Label>
                  {m.kind === "sfx" ? (
                    <WooshInstall hw={hw} />
                  ) : (
                    <CopyableCommand command={m.install!} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
