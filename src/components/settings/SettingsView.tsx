import React, { useState, useEffect } from "react";
import { invoke } from "../../lib/transport";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useModelStore } from "../../store/modelStore";
import type { AppConfig } from "../../lib/types";
import { reportError } from "../../lib/errors";
import {
  Label,
  SERVER_PORTS,
  urlsFromHost,
  hostFromUrl,
  defaultServerUrls,
  LOOPBACK_HOST,
  useHardwareProfile,
  type ModelKind,
  type SfxServerHealth,
} from "./settingsShared";
import { ModelServerCards } from "./ModelServerCards";
import { ChatterboxRvcCards, type ChatterboxHealth } from "./ChatterboxRvcCards";

export const SettingsView: React.FC = () => {
  const hw = useHardwareProfile();
  const { tts, sfx, music, post, health, updateServerConfig } = useModelStore();

  const statusMap = { tts, sfx, music, post };
  const healthMap = { tts: health.tts, sfx: health.sfx, music: health.music, post: health.post };

  const [urls, setUrls] = useState<Record<string, string>>(defaultServerUrls());
  const [inferenceHost, setInferenceHost] = useState(LOOPBACK_HOST);
  const [splitServers, setSplitServers] = useState(false);
  const [chatterboxHealth, setChatterboxHealth] = useState<ChatterboxHealth>("unknown");

  const [wooshDir, setWooshDir] = useState("");
  const [singleModelMode, setSingleModelMode] = useState(false);

  // Load persisted config on mount
  useEffect(() => {
    invoke<AppConfig>("get_app_config").then((cfg) => {
      setUrls({
        tts:        cfg.tts_url,
        sfx:        cfg.sfx_url,
        music:      cfg.music_url,
        post:       cfg.post_url,
        chatterbox: cfg.chatterbox_url ?? defaultServerUrls().chatterbox,
        rvc:        cfg.rvc_url        ?? defaultServerUrls().rvc,
      });
      setInferenceHost(cfg.inference_host ?? hostFromUrl(cfg.tts_url));
      setSplitServers(cfg.split_inference_servers ?? false);
      setWooshDir(cfg.woosh_dir ?? "");
      setSingleModelMode(cfg.single_model_mode ?? false);
    }).catch((e) => reportError("Load settings", e));
  }, []);

  // The URL actually used for a given server key
  const effectiveUrl = (key: string) =>
    splitServers ? urls[key] : `${inferenceHost}:${SERVER_PORTS[key]}`;

  const handleHostBlur = async () => {
    try {
      const derived = urlsFromHost(inferenceHost);
      const cfg = await invoke<AppConfig>("get_app_config");
      await invoke("save_app_config", {
        config: {
          ...cfg,
          inference_host:        inferenceHost,
          split_inference_servers: false,
          tts_url:        derived.tts,
          sfx_url:        derived.sfx,
          music_url:      derived.music,
          post_url:       derived.post,
          chatterbox_url: derived.chatterbox,
          rvc_url:        derived.rvc,
        },
      });
      await updateServerConfig({
        tts_url: derived.tts, sfx_url: derived.sfx,
        music_url: derived.music, post_url: derived.post,
      });
    } catch (e) {
      reportError("Save inference host", e);
    }
  };

  const handleUrlBlur = async (kind: ModelKind) => {
    try {
      await updateServerConfig({ [`${kind}_url`]: urls[kind] });
      const cfg = await invoke<AppConfig>("get_app_config");
      await invoke("save_app_config", { config: { ...cfg, [`${kind}_url`]: urls[kind] } });
    } catch (e) {
      reportError("Save server URL", e);
    }
  };

  const handleChatterboxUrlBlur = async () => {
    try {
      const cfg = await invoke<AppConfig>("get_app_config");
      await invoke("save_app_config", { config: { ...cfg, chatterbox_url: urls.chatterbox } });
    } catch (e) {
      reportError("Save Chatterbox URL", e);
    }
  };

  const handleRvcUrlBlur = async () => {
    try {
      const cfg = await invoke<AppConfig>("get_app_config");
      await invoke("save_app_config", { config: { ...cfg, rvc_url: urls.rvc } });
    } catch (e) {
      reportError("Save RVC URL", e);
    }
  };

  const handleSplitToggle = async (enabled: boolean) => {
    setSplitServers(enabled);
    try {
      const cfg = await invoke<AppConfig>("get_app_config");
      if (!enabled) {
        // Switching to unified — also update saved URLs to match derived values
        const derived = urlsFromHost(inferenceHost);
        await invoke("save_app_config", {
          config: {
            ...cfg,
            split_inference_servers: false,
            inference_host: inferenceHost,
            tts_url: derived.tts, sfx_url: derived.sfx, music_url: derived.music,
            post_url: derived.post, chatterbox_url: derived.chatterbox, rvc_url: derived.rvc,
          },
        });
      } else {
        await invoke("save_app_config", { config: { ...cfg, split_inference_servers: true } });
      }
    } catch (e) {
      reportError("Save server settings", e);
    }
  };

  const checkChatterboxHealth = async () => {
    try {
      const res = await fetch(`${effectiveUrl("chatterbox")}/health`);
      setChatterboxHealth(res.ok ? "online" : "offline");
    } catch {
      setChatterboxHealth("offline");
    }
  };

  const handleSingleModelModeToggle = async (enabled: boolean) => {
    setSingleModelMode(enabled);
    try {
      const cfg = await invoke<AppConfig>("get_app_config");
      await invoke("save_app_config", { config: { ...cfg, single_model_mode: enabled } });
    } catch (e) {
      reportError("Save single model mode", e);
    }
  };

  const handleBrowseWoosh = async () => {
    try {
      const selected = await openDialog({ directory: true, title: "Select Woosh directory" });
      if (selected && typeof selected === "string") {
        setWooshDir(selected);
        const cfg = await invoke<AppConfig>("get_app_config");
        await invoke("save_app_config", { config: { ...cfg, woosh_dir: selected } });
      }
    } catch (e) {
      reportError("Set Woosh directory", e);
    }
  };

  const handleWooshDirBlur = async () => {
    try {
      const cfg = await invoke<AppConfig>("get_app_config");
      await invoke("save_app_config", { config: { ...cfg, woosh_dir: wooshDir } });
    } catch (e) {
      reportError("Save Woosh directory", e);
    }
  };

  const sfxHealth = healthMap.sfx as SfxServerHealth | null;

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

        {/* ── Memory settings ───────────────────────────────────────────── */}
        <div style={{ marginBottom: 24 }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Memory</div>
          <div style={{
            border: "1px solid var(--line-1)",
            background: "var(--bg-1)",
            borderRadius: 3,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}>
            <input
              id="single-model-mode"
              type="checkbox"
              checked={singleModelMode}
              onChange={(e) => handleSingleModelModeToggle(e.target.checked)}
              style={{ cursor: "pointer", flexShrink: 0 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label
                htmlFor="single-model-mode"
                style={{ fontSize: 12, fontWeight: 600, cursor: "pointer" }}
              >
                Single model mode
              </label>
              <span style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
                Auto-unload other models before each generation to limit RAM usage.
              </span>
            </div>
          </div>
        </div>

        {/* ── Server cards ─────────────────────────────────────────────── */}
        <div style={{ marginBottom: 12, display: "flex", alignItems: "baseline", gap: 12 }}>
          <div className="eyebrow">Inference servers</div>
          <button
            onClick={() => handleSplitToggle(!splitServers)}
            style={{
              fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.05em",
              color: splitServers ? "var(--tts)" : "var(--fg-4)",
              background: "none", border: "none", cursor: "pointer", padding: 0,
              textDecoration: "none",
            }}
          >
            {splitServers ? "▾ individual urls" : "▸ split servers"}
          </button>
        </div>

        {/* Unified host field */}
        {!splitServers && (
          <div style={{
            border: "1px solid var(--line-1)", background: "var(--bg-1)",
            borderRadius: 3, marginBottom: 14, padding: "14px 16px",
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div>
              <Label>Inference host</Label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={inferenceHost}
                  onChange={(e) => setInferenceHost(e.target.value)}
                  onBlur={handleHostBlur}
                  placeholder={LOOPBACK_HOST}
                  style={{
                    flex: 1, fontFamily: "var(--font-mono)", fontSize: 12,
                    background: "var(--bg-0)", border: "1px solid var(--line-1)",
                    borderRadius: 2, padding: "6px 10px", color: "var(--fg-1)",
                  }}
                />
              </div>
              <div style={{ marginTop: 8, fontSize: 10.5, color: "var(--fg-4)", lineHeight: 1.6 }}>
                All servers run on this host using their default ports.
                Change to a remote IP or hostname to point Pharaoh at a cloud GPU box.
              </div>
            </div>
            {/* Port summary */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
              {Object.entries(SERVER_PORTS).map(([key, port]) => (
                <span key={key} style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)" }}>
                  <span style={{ color: "var(--fg-2)" }}>{key}</span>
                  :{port}
                </span>
              ))}
            </div>
          </div>
        )}

        <ModelServerCards
          hw={hw}
          splitServers={splitServers}
          urls={urls}
          setUrls={setUrls}
          onUrlBlur={handleUrlBlur}
          effectiveUrl={effectiveUrl}
          statusMap={statusMap}
          healthMap={healthMap}
          sfxHealth={sfxHealth}
          wooshDir={wooshDir}
          setWooshDir={setWooshDir}
          onWooshDirBlur={handleWooshDirBlur}
          onBrowseWoosh={handleBrowseWoosh}
        />

        <ChatterboxRvcCards
          splitServers={splitServers}
          urls={urls}
          setUrls={setUrls}
          effectiveUrl={effectiveUrl}
          chatterboxHealth={chatterboxHealth}
          onCheckChatterboxHealth={checkChatterboxHealth}
          onChatterboxUrlBlur={handleChatterboxUrlBlur}
          onRvcUrlBlur={handleRvcUrlBlur}
        />
      </div>
    </div>
  );
};
