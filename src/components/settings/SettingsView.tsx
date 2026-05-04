import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useModelStore } from "../../store/modelStore";
import type { AppConfig } from "../../lib/types";

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

// subdir must match the server's _ENDPOINT_TYPE keys: custom_voice | voice_design | base
const TTS_VARIANTS = [
  { id: "CustomVoice-1.7B", hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", subdir: "custom_voice", desc: "9 preset voices + instruction control" },
  { id: "VoiceDesign-1.7B", hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", subdir: "voice_design", desc: "Free-form voice description via natural language" },
  { id: "Base-1.7B",        hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",        subdir: "base",         desc: "3-second voice cloning" },
  { id: "CustomVoice-0.6B", hf_id: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", subdir: "custom_voice", desc: "Preset voices, lightweight — replaces CustomVoice-1.7B" },
  { id: "Base-0.6B",        hf_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",        subdir: "base",         desc: "Voice cloning, lightweight — replaces Base-1.7B" },
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
    install: "./inference/setup.sh",
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

// ── Woosh one-click setup ─────────────────────────────────────────────────────

interface SetupProgress {
  step: number;
  total_steps: number;
  label: string;
  bytes_done: number;
  bytes_total: number;
  done: boolean;
  error: string | null;
}

function formatBytes(n: number): string {
  if (n === 0) return "";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function WooshSetupPanel({ wooshDir, hw }: { wooshDir: string; hw: HardwareProfile | null }) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [steps, setSteps] = useState<SetupProgress[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  const uvSyncCmd = hw
    ? `cd ${wooshDir || "~/Code/Woosh"} && ${
        hw.gpu === "cuda" ? "uv sync --extra cuda" :
        hw.gpu === "mps"  ? "uv sync" :
                            "uv sync --extra cpu"
      }`
    : `cd ${wooshDir || "~/Code/Woosh"} && uv sync`;

  const start = async () => {
    if (!wooshDir) return;
    setPhase("running");
    setSteps([]);

    const unlisten = await listen<SetupProgress>("woosh_setup", (e) => {
      const p = e.payload;
      setSteps((prev) => {
        const next = [...prev];
        const idx = p.step - 1;
        next[idx] = p;
        return next;
      });
      if (p.done) { setPhase("done"); unlisten(); }
      if (p.error) { setPhase("error"); unlisten(); }
    });
    unlistenRef.current = unlisten;

    invoke("setup_woosh", { destDir: wooshDir }).catch((e: unknown) => {
      setPhase("error");
      setSteps((prev) => [...prev, {
        step: -1, total_steps: 7, label: String(e),
        bytes_done: 0, bytes_total: 0, done: false, error: String(e),
      }]);
    });
  };

  useEffect(() => () => { unlistenRef.current?.(); }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {phase === "idle" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            className="btn"
            disabled={!wooshDir}
            onClick={start}
            style={{ borderColor: "var(--sfx)", color: "var(--sfx)", background: "color-mix(in oklch, var(--sfx) 10%, transparent)" }}
          >
            Set up automatically
          </button>
          <span style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
            Clones repo + downloads AE, TextConditionerA, DFlow (~3.2 GB total)
          </span>
        </div>
      )}

      {(phase === "running" || phase === "done" || phase === "error") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {Array.from({ length: 7 }, (_, i) => {
            const s = steps[i];
            const isActive = s && !s.done && !s.error;
            const isDone = s?.done || (s && !s.error && steps[i + 1] !== undefined);
            const isErr = s?.error;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 11, width: 14, textAlign: "center",
                  color: isErr ? "var(--sfx)" : isDone ? "var(--st-rendered)" : isActive ? "var(--fg-1)" : "var(--fg-4)",
                }}>
                  {isErr ? "✕" : isDone ? "✓" : isActive ? "›" : "○"}
                </span>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 11, color: isErr ? "var(--sfx)" : isDone ? "var(--fg-2)" : isActive ? "var(--fg-1)" : "var(--fg-4)" }}>
                    {s?.label ?? `Step ${i + 1}`}
                  </span>
                  {isActive && s.bytes_total > 0 && (
                    <div style={{ marginTop: 3 }}>
                      <div style={{
                        height: 3, background: "var(--line-1)", borderRadius: 2, overflow: "hidden",
                      }}>
                        <div style={{
                          height: "100%",
                          width: `${Math.min(100, (s.bytes_done / s.bytes_total) * 100).toFixed(1)}%`,
                          background: "var(--sfx)", transition: "width 0.2s",
                        }} />
                      </div>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)" }}>
                        {formatBytes(s.bytes_done)} / {formatBytes(s.bytes_total)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {phase === "done" && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: "var(--st-rendered)", marginBottom: 6 }}>
            ✓ Woosh is ready. Run this once to install Python dependencies:
          </div>
          <CopyableCommand command={uvSyncCmd} />
        </div>
      )}
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

  const [wooshDir, setWooshDir] = useState("");

  // Load persisted config on mount
  useEffect(() => {
    invoke<AppConfig>("get_app_config").then((cfg) => {
      setUrls({ tts: cfg.tts_url, sfx: cfg.sfx_url, music: cfg.music_url });
      setWooshDir(cfg.woosh_dir ?? "");
    }).catch(() => {});
  }, []);

  const handleUrlBlur = async (kind: "tts" | "sfx" | "music") => {
    await updateServerConfig({ [`${kind}_url`]: urls[kind] });
  };

  const handleBrowseWoosh = async () => {
    const selected = await openDialog({ directory: true, title: "Select Woosh directory" });
    if (selected && typeof selected === "string") {
      setWooshDir(selected);
      const cfg = await invoke<AppConfig>("get_app_config");
      await invoke("save_app_config", { config: { ...cfg, woosh_dir: selected } });
    }
  };

  const sfxHealth = healthMap.sfx as (typeof healthMap.sfx & { woosh_ready?: boolean; woosh_error?: string; woosh_dir?: string }) | null;

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

                {/* Woosh directory (SFX only) */}
                {m.kind === "sfx" && (
                  <div>
                    <Label>Woosh directory</Label>
                    <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                      <input
                        type="text"
                        value={wooshDir}
                        onChange={(e) => setWooshDir(e.target.value)}
                        onBlur={async () => {
                          const cfg = await invoke<AppConfig>("get_app_config");
                          await invoke("save_app_config", { config: { ...cfg, woosh_dir: wooshDir } });
                        }}
                        placeholder="~/Code/Woosh"
                        style={{
                          flex: 1, fontFamily: "var(--font-mono)", fontSize: 11,
                          background: "var(--bg-0)", border: "1px solid var(--line-1)",
                          borderRadius: 2, padding: "5px 8px", color: "var(--fg-1)",
                        }}
                      />
                      <button
                        onClick={handleBrowseWoosh}
                        style={{
                          fontFamily: "var(--font-mono)", fontSize: 10,
                          padding: "4px 10px", background: "var(--bg-0)",
                          border: "1px solid var(--line-1)", borderRadius: 2,
                          color: "var(--fg-3)", cursor: "pointer", flexShrink: 0,
                        }}
                      >
                        browse
                      </button>
                    </div>
                    {sfxHealth && !sfxHealth.woosh_ready && sfxHealth.woosh_error && (
                      <div style={{
                        marginTop: 5, fontFamily: "var(--font-mono)", fontSize: 10,
                        color: "var(--sfx)", lineHeight: 1.5,
                      }}>
                        ⚠ {sfxHealth.woosh_error}
                      </div>
                    )}
                    {sfxHealth?.woosh_ready && (
                      <div style={{
                        marginTop: 5, fontFamily: "var(--font-mono)", fontSize: 10,
                        color: "var(--st-rendered)",
                      }}>
                        ✓ checkpoints found
                      </div>
                    )}
                  </div>
                )}

                {/* One-click setup (SFX only, shown when checkpoints missing) */}
                {m.kind === "sfx" && !sfxHealth?.woosh_ready && (
                  <div>
                    <Label>Automated setup</Label>
                    <WooshSetupPanel wooshDir={wooshDir} hw={hw} />
                  </div>
                )}

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
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{
                        fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.6,
                        padding: "8px 10px",
                        background: "color-mix(in oklch, var(--tts) 6%, var(--bg-2))",
                        borderRadius: "var(--r)", border: "1px solid var(--line-2)",
                      }}>
                        The speech tokenizer (audio codec) is shared — download it once.
                        The server automatically links it into each model variant's folder.
                        Model variants use identical filenames, so each needs its own subfolder.
                      </div>

                      <div>
                        <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
                          <span style={{ color: accent, fontFamily: "var(--font-mono)" }}>Speech tokenizer</span>
                          {" — "} download once, shared by all variants
                        </div>
                        <CopyableCommand command="hf download Qwen/Qwen3-TTS-Tokenizer-12Hz --local-dir ~/pharaoh-models/tts/tokenizer" />
                      </div>

                      {TTS_VARIANTS.map((v) => (
                        <div key={v.id}>
                          <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
                            <span style={{ color: accent, fontFamily: "var(--font-mono)" }}>{v.id}</span>
                            {" — "}{v.desc}
                          </div>
                          <CopyableCommand command={`hf download ${v.hf_id} --local-dir ~/pharaoh-models/tts/${v.subdir}`} />
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
