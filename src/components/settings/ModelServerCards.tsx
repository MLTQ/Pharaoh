import React from "react";
import type { ServerHealth, ServerStatus } from "../../store/modelStore";
import {
  CopyableCommand,
  Label,
  KIND_COLOR,
  STATUS_COLOR,
  MODELS,
  TTS_VARIANTS,
  type HardwareProfile,
  type ModelKind,
  type SfxServerHealth,
} from "./settingsShared";
import { SfxDownloads, WooshInstall } from "./SfxPanels";
import { WooshSetupPanel, ServerSetupPanel } from "./SetupPanels";

export interface ModelServerCardsProps {
  hw: HardwareProfile | null;
  splitServers: boolean;
  urls: Record<string, string>;
  setUrls: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onUrlBlur: (kind: ModelKind) => void;
  effectiveUrl: (key: string) => string;
  statusMap: Record<ModelKind, ServerStatus>;
  healthMap: Record<ModelKind, ServerHealth | null>;
  sfxHealth: SfxServerHealth | null;
  wooshDir: string;
  setWooshDir: (dir: string) => void;
  onWooshDirBlur: () => void;
  onBrowseWoosh: () => void;
}

export function ModelServerCards({
  hw,
  splitServers,
  urls,
  setUrls,
  onUrlBlur,
  effectiveUrl,
  statusMap,
  healthMap,
  sfxHealth,
  wooshDir,
  setWooshDir,
  onWooshDirBlur,
  onBrowseWoosh,
}: ModelServerCardsProps) {
  return (
    <>
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
              {m.port && (
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9.5,
                  color: "var(--fg-3)",
                  marginLeft: 2,
                }}>:{m.port}</span>
              )}
              <span style={{ flex: 1 }} />
              {!splitServers && (
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9.5,
                  color: "var(--fg-4)", marginRight: 8,
                }}>
                  {effectiveUrl(m.kind)}
                </span>
              )}
              <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{m.description}</span>
            </div>

            {/* Body */}
            <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* URL + health — only shown in split mode */}
              {splitServers && (
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <Label>Server URL</Label>
                  <input
                    type="text"
                    value={urls[m.kind]}
                    onChange={(e) => setUrls((prev) => ({ ...prev, [m.kind]: e.target.value }))}
                    onBlur={() => onUrlBlur(m.kind)}
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
              )}
              {/* Health badge in unified mode (no URL input) */}
              {!splitServers && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                    background: STATUS_COLOR[status] ?? "var(--fg-4)",
                  }} />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: STATUS_COLOR[status] ?? "var(--fg-4)" }}>
                    {status}{h?.vram_mb ? ` · ${h.vram_mb} MB` : ""}
                  </span>
                </div>
              )}

              {/* Woosh directory (SFX only) */}
              {m.kind === "sfx" && (
                <div>
                  <Label>Woosh directory</Label>
                  <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                    <input
                      type="text"
                      value={wooshDir}
                      onChange={(e) => setWooshDir(e.target.value)}
                      onBlur={onWooshDirBlur}
                      placeholder="~/Code/Woosh"
                      style={{
                        flex: 1, fontFamily: "var(--font-mono)", fontSize: 11,
                        background: "var(--bg-0)", border: "1px solid var(--line-1)",
                        borderRadius: 2, padding: "5px 8px", color: "var(--fg-1)",
                      }}
                    />
                    <button
                      onClick={onBrowseWoosh}
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
                  {sfxHealth && !sfxHealth.audioldm_ready && sfxHealth.audioldm_error && (
                    <div style={{
                      marginTop: 5, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-4)", lineHeight: 1.5,
                    }}>
                      AudioLDM optional deps: {sfxHealth.audioldm_error}
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
                  <SfxDownloads />
                ) : m.kind === "post" ? (
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.6 }}>
                    AudioSR runs through the Post server so upscaling can live on the remote ML host.
                    It downloads its own checkpoints on first upscale.
                  </div>
                ) : (
                  <CopyableCommand command={`hf download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music`} />
                )}
              </div>

              {/* Install */}
              <div>
                <Label>Install</Label>
                {m.kind === "sfx" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <WooshInstall hw={hw} />
                    <div>
                      <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginBottom: 4 }}>
                        Optional AudioLDM dependencies for long soundscapes
                      </div>
                      <ServerSetupPanel
                        profile="audioldm"
                        wooshDir={wooshDir}
                        buttonLabel="Install AudioLDM deps"
                        detail="Runs setup.sh with PHARAOH_INSTALL_AUDIOLDM=1"
                        accent="var(--sfx)"
                      />
                      <div style={{ height: 6 }} />
                      <CopyableCommand command="PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh" />
                    </div>
                  </div>
                ) : m.kind === "tts" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <ServerSetupPanel
                      profile="core"
                      wooshDir={wooshDir}
                      buttonLabel="Install speech server deps"
                      detail="Runs setup.sh for TTS and Music virtualenvs"
                      accent={accent}
                    />
                    <CopyableCommand command={m.install!} />
                  </div>
                ) : m.kind === "music" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <ServerSetupPanel
                      profile="core"
                      wooshDir={wooshDir}
                      buttonLabel="Install music server deps"
                      detail="Runs setup.sh for TTS and Music virtualenvs"
                      accent={accent}
                    />
                    <CopyableCommand command={m.install!} />
                  </div>
                ) : m.kind === "post" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <ServerSetupPanel
                      profile="audiosr"
                      wooshDir={wooshDir}
                      buttonLabel="Install AudioSR deps"
                      detail="Runs setup.sh with PHARAOH_INSTALL_AUDIOSR=1"
                      accent={accent}
                    />
                    <CopyableCommand command={m.install!} />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
