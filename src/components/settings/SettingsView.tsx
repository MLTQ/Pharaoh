import React, { useState } from "react";
import { useModelStore } from "../../store/modelStore";

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
    extra_flag: "--model-variant CustomVoice-1.7B",
  },
  {
    kind: "sfx" as const,
    label: "Woosh (Sony Research)",
    hf_id: null as null,   // GitHub release only
    description: "Sound design — fixed ~5s clips · 48 kHz",
    port: 18002,
    variants: null as null,
    install: "git clone https://github.com/SonyResearch/Woosh && cd Woosh && uv sync --extra cuda",
    extra_flag: "--woosh-dir ~/path/to/Woosh",
  },
  {
    kind: "music" as const,
    label: "ACE-Step v1 (3.5B)",
    hf_id: "ACE-Step/ACE-Step-v1-3.5B",
    description: "Music generation — lyrics + caption · 48 kHz",
    port: 18003,
    variants: null as null,
    install: "git clone https://github.com/ACE-Step/ACE-Step && cd ACE-Step && pip install -e .",
    extra_flag: "--ace-step-dir ~/path/to/ACE-Step",
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

// ── Main component ────────────────────────────────────────────────────────────

export const SettingsView: React.FC = () => {
  const { tts, sfx, music, health, updateServerConfig } = useModelStore();

  const statusMap = { tts, sfx, music };
  const healthMap = { tts: health.tts, sfx: health.sfx, music: health.music };

  const [urls, setUrls] = useState({
    tts:   `http://127.0.0.1:18001`,
    sfx:   `http://127.0.0.1:18002`,
    music: `http://127.0.0.1:18003`,
  });

  const [publicFlags, setPublicFlags] = useState({
    tts:   false,
    sfx:   false,
    music: false,
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
            Inference servers, model variants, and server URLs.
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
                {/* URL + health + public toggle */}
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
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                    <Label>Public</Label>
                    <button
                      onClick={() => setPublicFlags((prev) => ({ ...prev, [m.kind]: !prev[m.kind] }))}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        padding: "4px 10px",
                        background: publicFlags[m.kind] ? accent : "var(--bg-0)",
                        border: `1px solid ${publicFlags[m.kind] ? accent : "var(--line-1)"}`,
                        borderRadius: 2,
                        color: publicFlags[m.kind] ? "var(--bg-0)" : "var(--fg-3)",
                        cursor: "pointer",
                      }}
                    >
                      {publicFlags[m.kind] ? "on" : "off"}
                    </button>
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
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {TTS_VARIANTS.map((v) => (
                        <div key={v.id}>
                          <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 3 }}>
                            <span style={{ color: accent, fontFamily: "var(--font-mono)" }}>{v.id}</span>
                            {" — "}{v.desc}
                          </div>
                          <Code>{`huggingface-cli download ${v.hf_id} --local-dir ~/pharaoh-models/tts`}</Code>
                        </div>
                      ))}
                    </div>
                  ) : m.kind === "sfx" ? (
                    <div>
                      <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
                        Woosh checkpoints are distributed via GitHub releases (not HuggingFace).
                      </div>
                      <Code>{`# Download Woosh-DFlow checkpoint from GitHub Releases:\n# https://github.com/SonyResearch/Woosh/releases\nmkdir -p ~/pharaoh-models/sfx/checkpoints\n# Place Woosh-DFlow/ or Woosh-Flow/ under ~/pharaoh-models/sfx/checkpoints/`}</Code>
                    </div>
                  ) : (
                    <Code>{`huggingface-cli download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music`}</Code>
                  )}
                </div>

                {/* Server startup */}
                <div>
                  <Label>Server startup</Label>
                  {m.kind === "tts" ? (
                    <div>
                      <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
                        {"--model-variant options: "}
                        {TTS_VARIANTS.map((v) => v.id).join(" | ")}
                      </div>
                      <Code>{`python servers/tts/run.py --host 127.0.0.1 --port ${m.port} \\\n  --model-dir ~/pharaoh-models/tts \\\n  ${m.extra_flag}`}</Code>
                    </div>
                  ) : (
                    <Code>{`python servers/${m.kind}/run.py --host 127.0.0.1 --port ${m.port} \\\n  --model-dir ~/pharaoh-models/${m.kind} \\\n  ${m.extra_flag}`}</Code>
                  )}
                </div>

                {/* Install */}
                <div>
                  <Label>Install</Label>
                  <Code>{m.install}</Code>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
