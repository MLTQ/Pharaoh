import React, { useState, useEffect, useCallback } from "react";
import { getAppConfig, saveAppConfig, getServerHealthAll } from "../../lib/tauriCommands";
import type { AppConfig, AllServerHealth } from "../../lib/types";

// ── Model info ────────────────────────────────────────────────────────────────

const MODELS = [
  {
    kind: "tts" as const,
    label: "Qwen3-TTS",
    hf_id: "Qwen/Qwen3-TTS-1.7B",
    subdir: "tts",
    description: "Voice synthesis — 1.7B, 24 kHz",
    port: 18001,
  },
  {
    kind: "sfx" as const,
    label: "Woosh SFX",
    hf_id: "woosh-audio/woosh-sfx-v3",
    subdir: "sfx",
    description: "Sound design — text-to-audio, 48 kHz",
    port: 18002,
  },
  {
    kind: "music" as const,
    label: "ACE-Step",
    hf_id: "ACE-step/ACE-Step-v1",
    subdir: "music",
    description: "Music generation — lyrics + caption, 44.1 kHz",
    port: 18003,
  },
];

// ── Health dot ────────────────────────────────────────────────────────────────

const HealthDot: React.FC<{ health: AllServerHealth[keyof AllServerHealth]; loading: boolean }> = ({ health, loading }) => {
  if (loading) return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)" }}>…</span>
  );
  if (!health) return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: "var(--sfx)", flexShrink: 0,
    }} title="Server unreachable" />
  );
  const color = health.model_loaded ? "var(--st-rendered)" : "var(--st-gen)";
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: color, flexShrink: 0,
    }} title={`${health.status} · ${health.model_variant} · ${health.vram_mb} MB VRAM`} />
  );
};

// ── CopyField ─────────────────────────────────────────────────────────────────

const CopyField: React.FC<{ value: string; label?: string }> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <div style={{ marginBottom: 6 }}>
      {label && <div style={labelStyle}>{label}</div>}
      <div style={{
        display: "flex", alignItems: "stretch", gap: 0,
        border: "1px solid var(--line-1)", borderRadius: 2, overflow: "hidden",
      }}>
        <code style={{
          flex: 1, padding: "6px 10px", fontSize: 10.5,
          fontFamily: "var(--font-mono)", color: "var(--fg-2)",
          background: "var(--bg-2)", overflowX: "auto", whiteSpace: "nowrap",
          lineHeight: 1.5,
        }}>
          {value}
        </code>
        <button
          onClick={copy}
          style={{
            padding: "0 12px", background: copied ? "var(--st-rendered)" : "var(--bg-3)",
            border: "none", borderLeft: "1px solid var(--line-1)", cursor: "pointer",
            fontFamily: "var(--font-mono)", fontSize: 9, color: copied ? "var(--bg-0)" : "var(--fg-3)",
            letterSpacing: "0.06em", flexShrink: 0, transition: "background 0.15s, color 0.15s",
          }}
        >
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>
    </div>
  );
};

// ── Section wrapper ───────────────────────────────────────────────────────────

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginBottom: 32 }}>
    <h2 style={{
      fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em",
      textTransform: "uppercase", color: "var(--fg-3)", marginBottom: 14,
      borderBottom: "1px solid var(--line-1)", paddingBottom: 8,
    }}>
      {title}
    </h2>
    {children}
  </div>
);

// ── Main view ─────────────────────────────────────────────────────────────────

export const SettingsView: React.FC = () => {
  const [config, setConfig]   = useState<AppConfig | null>(null);
  const [health, setHealth]   = useState<AllServerHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    getAppConfig()
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, []);

  const refreshHealth = useCallback(() => {
    setHealthLoading(true);
    getServerHealthAll()
      .then(setHealth)
      .catch(() => setHealth({ tts: null, sfx: null, music: null }))
      .finally(() => setHealthLoading(false));
  }, []);

  useEffect(() => { refreshHealth(); }, [refreshHealth]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true); setError(null);
    try {
      await saveAppConfig(config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const patch = (p: Partial<AppConfig>) => setConfig((c) => c ? { ...c, ...p } : c);

  if (!config) {
    return (
      <div style={{ padding: 40, color: "var(--fg-3)", fontSize: 12 }}>
        {error ? `Error: ${error}` : "Loading config…"}
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--bg-1)" }}>
      <div className="grain" />
      <div className="doc" style={{ maxWidth: 680 }}>

        <div style={{ borderBottom: "1px solid var(--line-1)", paddingBottom: 20, marginBottom: 28 }}>
          <div className="kicker">Pharaoh · Settings</div>
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.015em", color: "var(--fg-0)", margin: "8px 0 0" }}>
            Configuration
          </h1>
        </div>

        {/* ── Inference servers ── */}
        <Section title="Inference servers">
          <p style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.6, marginBottom: 16 }}>
            Pharaoh connects to three external Python inference servers over HTTP.
            Start them manually or point Pharaoh at remote machines.
          </p>

          {MODELS.map((m) => {
            const urlKey = `${m.kind}_url` as keyof AppConfig;
            const pubKey = `${m.kind}_public` as keyof AppConfig;
            const h = health?.[m.kind];
            const host = config[pubKey] ? "0.0.0.0" : "127.0.0.1";
            return (
              <div key={m.kind} style={{
                marginBottom: 16, padding: "14px 16px",
                border: "1px solid var(--line-1)", borderRadius: 3,
                background: "var(--bg-2)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <HealthDot health={h ?? null} loading={healthLoading} />
                  <span style={{ fontWeight: 500, fontSize: 13, color: "var(--fg-0)" }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-4)" }}>{m.description}</span>
                  {h && (
                    <span style={{
                      marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9,
                      color: h.model_loaded ? "var(--st-rendered)" : "var(--st-gen)",
                      letterSpacing: "0.05em",
                    }}>
                      {h.model_loaded ? `${h.model_variant} · ${h.vram_mb} MB` : h.status}
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <label style={{ ...labelStyle, marginBottom: 0, flexShrink: 0 }}>URL</label>
                  <input
                    className="input"
                    value={config[urlKey] as string}
                    onChange={(e) => patch({ [urlKey]: e.target.value })}
                    style={{ flex: 1, fontSize: 11.5, fontFamily: "var(--font-mono)" }}
                    placeholder={`http://127.0.0.1:${m.port}`}
                  />
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label style={{
                    display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                    fontSize: 11, color: "var(--fg-3)",
                  }}>
                    <input
                      type="checkbox"
                      checked={config[pubKey] as boolean}
                      onChange={(e) => patch({ [pubKey]: e.target.checked })}
                      style={{ accentColor: "var(--tts)" }}
                    />
                    Expose to local network (bind {host}:{m.port})
                  </label>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)" }}>port {m.port}</span>
                </div>
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="btn" onClick={refreshHealth} disabled={healthLoading} style={{ fontSize: 11 }}>
              {healthLoading ? "Checking…" : "↻ Check health"}
            </button>
          </div>
        </Section>

        {/* ── Storage ── */}
        <Section title="Storage">
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Projects directory</label>
            <input
              className="input"
              value={config.projects_dir}
              onChange={(e) => patch({ projects_dir: e.target.value })}
              style={{ width: "100%", fontSize: 12, fontFamily: "var(--font-mono)" }}
              placeholder="~/pharaoh-projects"
            />
            <div style={{ fontSize: 10.5, color: "var(--fg-4)", marginTop: 4 }}>
              Each project is a subdirectory with project.json, storyboard.json, and per-scene CSV + audio assets.
            </div>
          </div>

          <div>
            <label style={labelStyle}>Models directory</label>
            <input
              className="input"
              value={config.models_dir}
              onChange={(e) => patch({ models_dir: e.target.value })}
              style={{ width: "100%", fontSize: 12, fontFamily: "var(--font-mono)" }}
              placeholder="~/pharaoh-models"
            />
            <div style={{ fontSize: 10.5, color: "var(--fg-4)", marginTop: 4 }}>
              Downloaded model weights. Each inference server expects its weights in a subdirectory.
            </div>
          </div>
        </Section>

        {/* ── Model downloads ── */}
        <Section title="Model downloads">
          <p style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.6, marginBottom: 16 }}>
            Run these commands to download model weights via{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>huggingface-cli</code>
            {" "}(<code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>pip install huggingface-hub</code>).
            Weights download to your configured models directory.
          </p>

          {MODELS.map((m) => (
            <div key={m.kind} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 500, fontSize: 12, color: "var(--fg-1)", marginBottom: 6 }}>
                {m.label}
              </div>
              <CopyField
                value={`huggingface-cli download ${m.hf_id} --local-dir "${config.models_dir}/${m.subdir}"`}
              />
            </div>
          ))}
        </Section>

        {/* ── Server startup commands ── */}
        <Section title="Server startup">
          <p style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.6, marginBottom: 16 }}>
            Start each inference server from the Pharaoh server scripts directory.
            The host changes based on the network exposure toggle above.
          </p>

          {MODELS.map((m) => {
            const pubKey = `${m.kind}_public` as keyof AppConfig;
            const host = config[pubKey] ? "0.0.0.0" : "127.0.0.1";
            return (
              <div key={m.kind} style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 500, fontSize: 12, color: "var(--fg-1)", marginBottom: 6 }}>
                  {m.label} · port {m.port}
                </div>
                <CopyField
                  value={`python3 servers/${m.kind}/run.py --host ${host} --port ${m.port} --model-dir "${config.models_dir}/${m.subdir}"`}
                />
              </div>
            );
          })}
        </Section>

        {/* ── Save bar ── */}
        <div style={{
          position: "sticky", bottom: 0, padding: "14px 0",
          background: "var(--bg-1)", borderTop: "1px solid var(--line-1)",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
            style={{ minWidth: 110 }}
          >
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save settings"}
          </button>
          {error && (
            <span style={{ fontSize: 11, color: "var(--sfx)" }}>{error}</span>
          )}
        </div>

      </div>
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
