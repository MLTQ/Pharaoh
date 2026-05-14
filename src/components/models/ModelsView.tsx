import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModelStore } from "../../store/modelStore";
import type { AppConfig } from "../../lib/types";

const TTS_VARIANTS = [
  { id: "CustomVoice-1.7B", desc: "9 preset voices + instruction control" },
  { id: "VoiceDesign-1.7B", desc: "Free-form voice description" },
  { id: "Base-1.7B",        desc: "3-second voice cloning" },
  { id: "CustomVoice-0.6B", desc: "Preset voices, lightweight" },
  { id: "Base-0.6B",        desc: "Voice cloning, lightweight" },
];

const SFX_VARIANTS = [
  { id: "Woosh-DFlow", desc: "short foley, highest quality" },
  { id: "AudioLDM-M-Full", desc: "long effects and soundscapes, upstream default" },
  { id: "AudioLDM-S-Full-V2", desc: "smaller AudioLDM checkpoint" },
];

const SERVERS = [
  { kind: "tts"   as const, label: "Qwen3-TTS",          color: "var(--tts)",   port: 18001 },
  { kind: "sfx"   as const, label: "Woosh + AudioLDM",    color: "var(--sfx)",   port: 18002 },
  { kind: "music" as const, label: "ACE-Step v1 (3.5B)",  color: "var(--music)", port: 18003 },
];

const STATUS_COLOR: Record<string, string> = {
  online:  "var(--st-rendered)",
  offline: "var(--sfx)",
  loading: "var(--st-gen)",
  unknown: "var(--fg-4)",
};

export const ModelsView: React.FC = () => {
  const { tts, sfx, music, health, loadProgress, loadModel, unloadModel, pollHealth } = useModelStore();
  const statusMap = { tts, sfx, music };
  const healthMap = { tts: health.tts, sfx: health.sfx, music: health.music };
  const progressMap = { tts: loadProgress.tts, sfx: loadProgress.sfx, music: loadProgress.music };

  const [ttsVariant, setTtsVariant] = useState("CustomVoice-1.7B");
  const [sfxVariant, setSfxVariant] = useState("Woosh-DFlow");
  const [wooshDir, setWooshDir] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // ── Chatterbox state (managed via direct fetch — not wired into modelStore) ──
  const [chatterboxUrl, setChatterboxUrl] = useState("http://127.0.0.1:18005");
  const [chatterboxStatus, setChatterboxStatus] = useState<"unknown" | "online" | "offline">("unknown");
  const [chatterboxLoaded, setChatterboxLoaded] = useState(false);
  const [chatterboxVariant, setChatterboxVariant] = useState("");
  const [chatterboxBusy, setChatterboxBusy] = useState(false);

  useEffect(() => {
    invoke<AppConfig>("get_app_config").then((cfg) => {
      setWooshDir(cfg.woosh_dir ?? "");
      setChatterboxUrl(cfg.chatterbox_url ?? "http://127.0.0.1:18005");
    }).catch(() => {});
  }, []);

  const pollChatterbox = useCallback(async (url = chatterboxUrl) => {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const h = await res.json();
        setChatterboxStatus("online");
        setChatterboxLoaded(!!h.model_loaded);
        setChatterboxVariant(h.model_variant ?? "");
      } else {
        setChatterboxStatus("offline");
        setChatterboxLoaded(false);
      }
    } catch {
      setChatterboxStatus("offline");
      setChatterboxLoaded(false);
    }
  }, [chatterboxUrl]);

  useEffect(() => { pollChatterbox(); }, [pollChatterbox]);

  const doLoadChatterbox = async () => {
    setChatterboxBusy(true);
    try {
      await fetch(`${chatterboxUrl}/load`, { method: "POST", signal: AbortSignal.timeout(30000) });
    } catch { /* will show in health poll */ }
    await pollChatterbox();
    setChatterboxBusy(false);
  };

  const doUnloadChatterbox = async () => {
    setChatterboxBusy(true);
    try {
      await fetch(`${chatterboxUrl}/unload`, { method: "POST", signal: AbortSignal.timeout(10000) });
    } catch { /* ignore */ }
    await pollChatterbox();
    setChatterboxBusy(false);
  };

  const doLoad = async (kind: "tts" | "sfx" | "music", variant?: string) => {
    setBusy((b) => ({ ...b, [kind]: true }));
    try { await loadModel(kind, variant); } finally {
      setBusy((b) => ({ ...b, [kind]: false }));
    }
  };

  const doUnload = async (kind: "tts" | "sfx" | "music") => {
    setBusy((b) => ({ ...b, [kind]: true }));
    try { await unloadModel(kind); } finally {
      setBusy((b) => ({ ...b, [kind]: false }));
    }
  };

  return (
    <div className="panel-view" style={{ overflowY: "auto" }}>
      <div style={{ maxWidth: 700, padding: "28px 32px" }}>
        <div style={{ marginBottom: 28 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Pharaoh</div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, lineHeight: 1.2 }}>Models</h1>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 6 }}>
            Load and unload inference models on demand. Pharaoh keeps a model loaded until you load another.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
          <button className="btn btn-sm" onClick={() => { pollHealth(); pollChatterbox(); }} style={{ fontSize: 10.5 }}>
            Refresh status
          </button>
        </div>

        {SERVERS.map((s) => {
          const status = statusMap[s.kind];
          const h = healthMap[s.kind];
          const isBusy = !!busy[s.kind];
          const isLoaded = h?.model_loaded ?? false;
          const progress = progressMap[s.kind];

          return (
            <div
              key={s.kind}
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
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: STATUS_COLOR[status] ?? "var(--fg-4)",
                  boxShadow: status === "online" ? `0 0 5px ${STATUS_COLOR[status]}` : "none",
                  flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{s.label}</span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", marginLeft: 2,
                }}>:{s.port}</span>
                <span style={{ flex: 1 }} />
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9.5,
                  color: STATUS_COLOR[status] ?? "var(--fg-4)",
                  letterSpacing: "0.06em", textTransform: "uppercase",
                }}>{status}</span>
              </div>

              {/* Body */}
              <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                {/* Model state */}
                <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
                      color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 3,
                    }}>Status</div>
                    <div style={{ fontSize: 12, color: isLoaded ? "var(--st-rendered)" : "var(--fg-3)" }}>
                      {status === "loading"
                        ? "Loading weights…"
                        : isLoaded
                          ? `Loaded${h?.model_variant ? ` · ${h.model_variant}` : ""}${h?.vram_mb ? ` · ${h.vram_mb} MB VRAM` : ""}`
                          : "Not loaded"}
                    </div>
                  </div>
                </div>

                {/* Progress bar — visible while loading */}
                {status === "loading" && (
                  <div style={{ height: 3, background: "var(--bg-0)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.max(4, Math.round(progress * 100))}%`,
                      background: s.color,
                      borderRadius: 2,
                      transition: "width 0.35s ease",
                    }} />
                  </div>
                )}

                {/* SFX variant picker */}
                {s.kind === "sfx" && (
                  <div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
                      color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 4,
                    }}>Variant</div>
                    <select
                      className="select"
                      value={sfxVariant}
                      onChange={(e) => setSfxVariant(e.target.value)}
                      style={{ background: "var(--bg-0)", width: "100%", fontSize: 11 }}
                    >
                      {SFX_VARIANTS.map((v) => (
                        <option key={v.id} value={v.id}>{v.id} — {v.desc}</option>
                      ))}
                    </select>
                    {h?.audioldm_error && !h.audioldm_ready && (
                      <div style={{ color: "var(--fg-4)", fontSize: 10.5, marginTop: 5 }}>
                        AudioLDM optional deps not ready.
                      </div>
                    )}
                  </div>
                )}

                {/* TTS variant picker */}
                {s.kind === "tts" && (
                  <div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
                      color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 4,
                    }}>Variant</div>
                    <select
                      className="select"
                      value={ttsVariant}
                      onChange={(e) => setTtsVariant(e.target.value)}
                      style={{ background: "var(--bg-0)", width: "100%", fontSize: 11 }}
                    >
                      {TTS_VARIANTS.map((v) => (
                        <option key={v.id} value={v.id}>{v.id} — {v.desc}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn"
                    disabled={isBusy || status === "offline"}
                    onClick={() => doLoad(s.kind, s.kind === "tts" ? ttsVariant : s.kind === "sfx" ? sfxVariant : undefined)}
                    style={{
                      borderColor: s.color, color: s.color,
                      background: `color-mix(in oklch, ${s.color} 10%, transparent)`,
                    }}
                  >
                    {isBusy ? "Loading…" : isLoaded ? "Reload" : "Load"}
                  </button>
                  {isLoaded && (
                    <button
                      className="btn"
                      disabled={isBusy}
                      onClick={() => doUnload(s.kind)}
                    >
                      Unload
                    </button>
                  )}
                </div>

                {status === "offline" && (
                  <div style={{ fontSize: 11, color: "var(--fg-4)", fontStyle: "italic" }}>
                    Server offline — start it with:{" "}
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontStyle: "normal" }}>
                      {s.kind === "sfx" && wooshDir
                        ? `PHARAOH_WOOSH_DIR="${wooshDir}" python inference/sfx_server.py`
                        : `python inference/${s.kind}_server.py`}
                    </code>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* ── Chatterbox Turbo ──────────────────────────────────────────── */}
        <div style={{
          border: "1px solid var(--line-1)", background: "var(--bg-1)",
          borderRadius: 3, marginBottom: 14, overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            borderBottom: "1px solid var(--line-1)", padding: "12px 16px",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: STATUS_COLOR[chatterboxStatus] ?? "var(--fg-4)",
              boxShadow: chatterboxStatus === "online" ? `0 0 5px ${STATUS_COLOR.online}` : "none",
              flexShrink: 0,
            }} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>Chatterbox Turbo</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", marginLeft: 2 }}>:18005</span>
            <span style={{ flex: 1 }} />
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9.5,
              color: STATUS_COLOR[chatterboxStatus] ?? "var(--fg-4)",
              letterSpacing: "0.06em", textTransform: "uppercase",
            }}>{chatterboxStatus}</span>
          </div>

          {/* Body */}
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{
                fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
                color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 3,
              }}>Status</div>
              <div style={{ fontSize: 12, color: chatterboxLoaded ? "var(--st-rendered)" : "var(--fg-3)" }}>
                {chatterboxLoaded
                  ? `Loaded${chatterboxVariant ? ` · ${chatterboxVariant}` : ""}`
                  : "Not loaded"}
              </div>
            </div>

            <div style={{ fontSize: 11, color: "var(--fg-4)", lineHeight: 1.5 }}>
              0-shot voice cloning · inline paralinguistic tags ([sigh], [chuckle]…) · 0.5B params
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn"
                disabled={chatterboxBusy || chatterboxStatus === "offline"}
                onClick={doLoadChatterbox}
                style={{
                  borderColor: "var(--tts)", color: "var(--tts)",
                  background: "color-mix(in oklch, var(--tts) 10%, transparent)",
                }}
              >
                {chatterboxBusy ? "Loading…" : chatterboxLoaded ? "Reload" : "Load"}
              </button>
              {chatterboxLoaded && (
                <button className="btn" disabled={chatterboxBusy} onClick={doUnloadChatterbox}>
                  Unload
                </button>
              )}
            </div>

            {chatterboxStatus === "offline" && (
              <div style={{ fontSize: 11, color: "var(--fg-4)", fontStyle: "italic" }}>
                Server offline — start it with:{" "}
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontStyle: "normal" }}>
                  inference/.venv-chatterbox/bin/python inference/chatterbox_server.py
                </code>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
