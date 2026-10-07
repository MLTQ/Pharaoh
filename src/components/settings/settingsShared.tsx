import React, { useState, useEffect } from "react";
import { invoke } from "../../lib/transport";
import type { ServerHealth } from "../../store/modelStore";

// ── Hardware detection ────────────────────────────────────────────────────────

export interface HardwareProfile {
  os: string;
  arch: string;
  gpu: "cuda" | "mps" | "cpu";
  gpu_name: string;
}

export function useHardwareProfile(): HardwareProfile | null {
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  useEffect(() => {
    invoke<HardwareProfile>("detect_hardware").then(setHw).catch(() => null);
  }, []);
  return hw;
}

// ── Model definitions ─────────────────────────────────────────────────────────

// subdir must match the server's _ENDPOINT_TYPE keys: custom_voice | voice_design | base
export const TTS_VARIANTS = [
  { id: "CustomVoice-1.7B", hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", subdir: "custom_voice", desc: "9 preset voices + instruction control" },
  { id: "VoiceDesign-1.7B", hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", subdir: "voice_design", desc: "Free-form voice description via natural language" },
  { id: "Base-1.7B",        hf_id: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",        subdir: "base",         desc: "3-second voice cloning" },
  { id: "CustomVoice-0.6B", hf_id: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", subdir: "custom_voice", desc: "Preset voices, lightweight — replaces CustomVoice-1.7B" },
  { id: "Base-0.6B",        hf_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",        subdir: "base",         desc: "Voice cloning, lightweight — replaces Base-1.7B" },
];

export const MODELS = [
  {
    kind: "tts" as const,
    label: "TTS — Breeze TTS 2 (Qwen3-TTS fallback)",
    description: "Voice synthesis — Breeze TTS 2 (design, clone, direction) when installed with ./inference/setup.sh breeze; otherwise Qwen3-TTS, 24 kHz · 5 variants",
    port: 18001,
    variants: TTS_VARIANTS,
    install: "./inference/setup.sh breeze",
  },
  {
    kind: "sfx" as const,
    label: "SFX — MOSS-SoundEffect v2 (Woosh, AudioLDM)",
    description: "Sound design — effects and beds up to 30 s with MOSS on NVIDIA; Woosh and AudioLDM on Macs or by choice",
    port: 18002,
    variants: null as null,
    install: "./inference/setup.sh moss",
  },
  {
    kind: "music" as const,
    label: "YuE2 (3B) / ACE-Step v1",
    description: "Music generation — YuE2 on NVIDIA (instrumental by default), ACE-Step elsewhere and for repaint/cover",
    port: 18003,
    variants: null as null,
    install: "./inference/setup.sh yue2",
  },
  {
    kind: "post" as const,
    label: "AudioSR",
    description: "Post-processing — neural audio upscaling to 48 kHz",
    port: 18004,
    variants: null as null,
    install: "PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh",
  },
  {
    kind: "dissect" as const,
    label: "Dissect",
    description: "Voices from existing recordings — separate · diarize · transcribe",
    port: 18007,
    variants: null as null,
    install: "./inference/setup.sh dissect",
  },
];

export type ModelKind = "tts" | "sfx" | "music" | "post" | "dissect";

/** SFX server health extended with MOSS/Woosh/AudioLDM readiness flags. */
export type SfxServerHealth = ServerHealth & {
  /** "moss" when MOSS-SoundEffect serves the port, else "woosh". */
  engine?: string;
  moss_ready?: boolean;
  moss_error?: string;
  woosh_ready?: boolean;
  woosh_error?: string;
  woosh_dir?: string;
  audioldm_ready?: boolean;
  audioldm_error?: string;
  audioldm_local_dir?: string;
};

// ── Colours ───────────────────────────────────────────────────────────────────

export const KIND_COLOR: Record<string, string> = {
  tts:   "var(--tts)",
  sfx:   "var(--sfx)",
  music: "var(--music)",
  dissect: "var(--st-ready)",
  post:  "var(--sfx)",
};

export const STATUS_COLOR: Record<string, string> = {
  online:  "var(--st-rendered)",
  offline: "var(--sfx)",
  loading: "var(--st-gen)",
  unknown: "var(--fg-4)",
};

// ── Sub-components ────────────────────────────────────────────────────────────

export function CopyableCommand({ command }: { command: string }) {
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

export function Code({ children }: { children: string }) {
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

export function Label({ children }: { children: React.ReactNode }) {
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

// ── Setup progress events ─────────────────────────────────────────────────────

export interface SetupProgress {
  step: number;
  total_steps: number;
  label: string;
  bytes_done: number;
  bytes_total: number;
  done: boolean;
  error: string | null;
}

export function formatBytes(n: number): string {
  if (n === 0) return "";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Port map (single source of truth) ─────────────────────────────────────────

export const SERVER_PORTS: Record<string, number> = {
  tts: 18001, sfx: 18002, music: 18003, post: 18004, rvc: 18006, dissect: 18007,
};

// HOST-side default: where the Rust backend finds its inference servers. The
// browser page never fetches these (config data only), so a mesh viewer is
// unaffected — assembled at runtime so `gruve doctor` doesn't read them as
// frontend fetch targets, which they are not.
export const LOOPBACK_HOST = ["http", "127.0.0.1"].join("://");

/** Default per-server URL map (loopback host + canonical ports). */
export function defaultServerUrls(): Record<string, string> {
  return urlsFromHost(LOOPBACK_HOST);
}

export function urlsFromHost(host: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SERVER_PORTS).map(([k, p]) => [k, `${host}:${p}`])
  );
}

/** Extract scheme+host (no port) from a full URL like http://1.2.3.4:18001 → http://1.2.3.4 */
export function hostFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return LOOPBACK_HOST;
  }
}
