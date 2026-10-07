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

const note: React.CSSProperties = { fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.6 };
const summary: React.CSSProperties = { cursor: "pointer", fontSize: 10.5, color: "var(--fg-2)", marginBottom: 6 };

/** The core section (Qwen3-TTS + ACE-Step envs). */
function SectionInstallCore({ local, accent }: { local: boolean; accent: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {local && <ServerSetupPanel profile="core" buttonLabel="Install core envs" detail="Runs setup.sh core on this machine" accent={accent} />}
      <CopyableCommand command="./inference/setup.sh core" />
      <CopyableCommand command="hf download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music" />
    </div>
  );
}

/** One setup.sh section: a button that runs it here (local server), or a
 *  note that it belongs on the remote host — and the command either way. */
function SectionInstall({ profile, label, local, accent }: {
  profile: "breeze" | "moss" | "yue2" | "dissect" | "audiosr";
  label: string;
  local: boolean;
  accent: string;
}) {
  const command = profile === "audiosr" ? "PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh" : `./inference/setup.sh ${profile}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {local ? (
        <ServerSetupPanel profile={profile} buttonLabel={label} detail={`Runs ${command} on this machine`} accent={accent} />
      ) : (
        <div style={{ fontSize: 10.5, color: "var(--fg-4)" }}>This server is remote — run this on that host, then restart start_servers.sh:</div>
      )}
      <CopyableCommand command={command} />
    </div>
  );
}

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
        const local = /127\.0\.0\.1|localhost|\[::1\]/.test(effectiveUrl(m.kind));
        // Woosh/AudioLDM setup only matters when MOSS isn't serving SFX.
        const mossServes = sfxHealth?.engine === "moss";

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

              {/* MOSS status (SFX only) */}
              {m.kind === "sfx" && sfxHealth && (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.5, color: mossServes ? "var(--st-rendered)" : "var(--fg-4)" }}>
                  {mossServes ? "✓ MOSS-SoundEffect v2 serves effects and beds" : `MOSS-SoundEffect not active${sfxHealth.moss_error ? ` — ${sfxHealth.moss_error}` : ""}; Woosh serves SFX`}
                </div>
              )}

              {/* Woosh directory (SFX only) — an alternative engine, folded away when MOSS serves */}
              {m.kind === "sfx" && (
                <details open={!mossServes}>
                  <summary style={summary}>Woosh and AudioLDM (alternatives; the Mac engines)</summary>
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
                  {/* One-click Woosh setup (shown when checkpoints missing) */}
                  {!sfxHealth?.woosh_ready && (
                    <div style={{ marginTop: 10 }}>
                      <Label>Woosh setup</Label>
                      <WooshSetupPanel wooshDir={wooshDir} hw={hw} />
                    </div>
                  )}
                </details>
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
                    <div style={note}>
                      <code>setup.sh breeze</code> fetches Breeze TTS 2's code and weights into
                      {" "}<code>~/pharaoh-models/breeze</code> (Linux + NVIDIA, ~12 GB VRAM; research / non-commercial licence).
                      Breeze clones voices, performs each line's direction and vocal events, and checks takes with Whisper.
                    </div>
                    <details>
                      <summary style={summary}>Qwen3-TTS (fallback on Macs; clones without direction)</summary>
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
                    <CopyableCommand command="./inference/setup.sh core" />
                  </div>
                    </details>
                  </div>
                ) : m.kind === "sfx" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={note}>
                      <code>setup.sh moss</code> installs MOSS-SoundEffect v2 (Apache 2.0) into its own env with the
                      code in <code>~/pharaoh-models/moss</code>; the weights download from Hugging Face during setup.
                      ~9 GB VRAM at peak, so it runs beside Breeze on a 24 GB card.
                    </div>
                    <details>
                      <summary style={summary}>Woosh and AudioLDM checkpoints</summary>
                      <SfxDownloads />
                    </details>
                  </div>
                ) : m.kind === "post" ? (
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.6 }}>
                    AudioSR runs through the Post server so upscaling can live on the remote ML host.
                    It downloads its own checkpoints on first upscale.
                  </div>
                ) : m.kind === "dissect" ? (
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.6 }}>
                    setup.sh fetches the BandIt Plus separator into <code>~/pharaoh-models/dissect</code>.
                    Nemotron-3-Diarization, TitaNet and Parakeet download from Hugging Face on the first import (~2.5 GB).
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.6 }}>
                      On an NVIDIA host, <code>./inference/setup.sh yue2</code> installs YuE2 and fetches its weights (~7.3 GB).
                      ACE-Step v1 runs music on Macs and repaint/cover everywhere:
                    </div>
                    <CopyableCommand command={`hf download ACE-Step/ACE-Step-v1-3.5B --local-dir ~/pharaoh-models/music`} />
                  </div>
                )}
              </div>

              {/* Install */}
              <div>
                <Label>Install</Label>
                {m.kind === "sfx" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <SectionInstall profile="moss" label="Install MOSS-SoundEffect" local={local} accent={accent} />
                    <details>
                      <summary style={summary}>Woosh and AudioLDM</summary>
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
                    </details>
                  </div>
                ) : m.kind === "tts" ? (
                  <SectionInstall profile="breeze" label="Install Breeze TTS 2" local={local} accent={accent} />
                ) : m.kind === "music" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <SectionInstall profile="yue2" label="Install YuE2" local={local} accent={accent} />
                    <details>
                      <summary style={summary}>ACE-Step (Macs, and repaint/cover everywhere)</summary>
                      <SectionInstallCore local={local} accent={accent} />
                    </details>
                  </div>
                ) : m.kind === "dissect" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={note}>
                      Linux + NVIDIA only (NeMo from source, Python 3.12, CUDA 12.8). Sets up the env, the
                      separator and ~2.5 GB of model weights, then verifies them. Open port 18007 if the host has a firewall.
                    </div>
                    <SectionInstall profile="dissect" label="Install dissect" local={local} accent={accent} />
                  </div>
                ) : m.kind === "post" ? (
                  <SectionInstall profile="audiosr" label="Install AudioSR" local={local} accent={accent} />
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
