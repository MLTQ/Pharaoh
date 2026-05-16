/**
 * RecordTakePanel — inline recording UI for palette takes.
 *
 * Shows a device picker, mono/stereo + sample-rate selectors, a live level
 * meter (fed by `recording:peak` Tauri events), and Record/Stop controls.
 * On stop the WAV is written directly to `outputPath`; the caller is notified
 * via `onDone` so it can trigger a disk-take rescan.
 */

import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AudioDevice } from "../../lib/tauriCommands";
import {
  listAudioInputs,
  startRecording,
  stopRecording,
} from "../../lib/tauriCommands";

interface RecordTakePanelProps {
  outputPath: string;
  onDone: (path: string, durationMs: number) => void;
  onCancel: () => void;
}

type Phase = "idle" | "loading" | "armed" | "recording" | "stopping";

export const RecordTakePanel: React.FC<RecordTakePanelProps> = ({
  outputPath,
  onDone,
  onCancel,
}) => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [mono, setMono] = useState(true);
  const [sampleRate, setSampleRate] = useState(48000);
  const [error, setError] = useState<string | null>(null);

  // Level meter state (updated from recording:peak events)
  const [peakDb, setPeakDb] = useState(-96);
  const [rmsDb, setRmsDb] = useState(-96);
  // Hold-peak decays slowly for visual punch
  const [holdPeakDb, setHoldPeakDb] = useState(-96);
  const holdDecayRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Elapsed timer
  const [elapsed, setElapsed] = useState(0); // seconds
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  // Unlisten handle
  const unlistenRef = useRef<(() => void) | null>(null);

  // ── Load devices on mount ───────────────────────────────────────────────
  useEffect(() => {
    listAudioInputs()
      .then((devs) => {
        setDevices(devs);
        if (devs.length > 0) {
          setSelectedDevice(devs[0].name);
          // Default sample rate: 48 kHz if supported, else first available
          const def = devs[0];
          setSampleRate(def.sample_rates.includes(48000) ? 48000 : def.sample_rates[0]);
        }
        setPhase(devs.length > 0 ? "armed" : "idle");
      })
      .catch((e) => {
        setError(String(e));
        setPhase("idle");
      });

    return () => {
      clearPeakSubscription();
      clearTimer();
    };
  }, []);

  // Update sample rate default when device changes
  useEffect(() => {
    const dev = devices.find((d) => d.name === selectedDevice);
    if (!dev) return;
    if (!dev.sample_rates.includes(sampleRate)) {
      setSampleRate(dev.sample_rates.includes(48000) ? 48000 : dev.sample_rates[0]);
    }
  }, [selectedDevice]);

  // ── Peak event subscription ─────────────────────────────────────────────
  const subscribePeaks = async () => {
    const unlisten = await listen<{ peak_db: number; rms_db: number }>(
      "recording:peak",
      (ev) => {
        const { peak_db, rms_db } = ev.payload;
        setPeakDb(peak_db);
        setRmsDb(rms_db);
        setHoldPeakDb((h) => Math.max(h, peak_db));
      },
    );
    unlistenRef.current = unlisten;
  };

  const clearPeakSubscription = () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (holdDecayRef.current) {
      clearInterval(holdDecayRef.current);
      holdDecayRef.current = null;
    }
  };

  // Hold-peak decay: drop 0.5 dB every 100 ms when not refreshed
  const startHoldDecay = () => {
    holdDecayRef.current = setInterval(() => {
      setHoldPeakDb((h) => Math.max(h - 0.5, -96));
    }, 100);
  };

  // ── Timer helpers ───────────────────────────────────────────────────────
  const startTimer = () => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 500);
  };

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsed(0);
  };

  const fmtElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${m}:${ss}`;
  };

  // ── Record / Stop ───────────────────────────────────────────────────────
  const handleRecord = async () => {
    setError(null);
    setPhase("recording");
    setPeakDb(-96);
    setRmsDb(-96);
    setHoldPeakDb(-96);

    try {
      await subscribePeaks();
      startHoldDecay();
      startTimer();

      await startRecording({
        deviceName: selectedDevice,
        outputPath,
        mono,
        sampleRate,
      });
    } catch (e) {
      clearPeakSubscription();
      clearTimer();
      setError(String(e));
      setPhase("armed");
    }
  };

  const handleStop = async () => {
    setPhase("stopping");
    clearPeakSubscription();
    clearTimer();

    try {
      const result = await stopRecording();
      onDone(result.path, result.duration_ms);
    } catch (e) {
      setError(String(e));
      setPhase("armed");
    }
  };

  // ── Level meter helpers ─────────────────────────────────────────────────
  // Map dB (−60 … 0) to 0–100% with log-ish scale.
  const dbToPercent = (db: number) =>
    Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

  const meterColor = (db: number) => {
    if (db > -3) return "oklch(0.65 0.18 25)";   // red — clipping
    if (db > -12) return "oklch(0.75 0.16 75)";  // amber — loud
    return "oklch(0.65 0.16 145)";                // green — nominal
  };

  const selectedDevObj = devices.find((d) => d.name === selectedDevice);
  const isRecording = phase === "recording";
  const isStopping = phase === "stopping";

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--fg-4)",
    marginBottom: 4,
  };

  return (
    <div style={{
      padding: "12px 14px",
      border: "1px solid color-mix(in oklch, var(--sfx) 50%, var(--line-1))",
      borderRadius: "var(--r)",
      background: "color-mix(in oklch, var(--sfx) 4%, var(--bg-1))",
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
          background: isRecording
            ? "oklch(0.65 0.18 25)"
            : "color-mix(in oklch, var(--sfx) 60%, var(--bg-2))",
          boxShadow: isRecording ? "0 0 6px oklch(0.65 0.18 25 / 0.7)" : "none",
        }} />
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em",
          textTransform: "uppercase", color: "var(--fg-3)",
        }}>
          {isRecording ? `Recording · ${fmtElapsed(elapsed)}` : isStopping ? "Finalising…" : "Record Take"}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-sm"
          style={{ color: "var(--fg-4)", borderColor: "transparent", padding: "1px 6px" }}
          onClick={onCancel}
          disabled={isRecording || isStopping}
        >
          ×
        </button>
      </div>

      {/* Device + options row (hidden while recording) */}
      {!isRecording && !isStopping && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "2 1 160px" }}>
            <label style={labelStyle}>Input device</label>
            <select
              className="input"
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              style={{ width: "100%", fontSize: 11 }}
              disabled={phase === "loading"}
            >
              {devices.length === 0 && (
                <option value="">No input devices found</option>
              )}
              {devices.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.is_default ? "● " : ""}
                  {d.name}
                  {d.channels > 1 ? ` (${d.channels}ch)` : ""}
                </option>
              ))}
            </select>
          </div>

          <div style={{ flex: "0 0 auto" }}>
            <label style={labelStyle}>Channels</label>
            <select
              className="input"
              value={mono ? "mono" : "stereo"}
              onChange={(e) => setMono(e.target.value === "mono")}
              style={{ fontSize: 11 }}
            >
              <option value="mono">Mono</option>
              {(selectedDevObj?.channels ?? 0) >= 2 && (
                <option value="stereo">Stereo</option>
              )}
            </select>
          </div>

          <div style={{ flex: "0 0 auto" }}>
            <label style={labelStyle}>Sample rate</label>
            <select
              className="input"
              value={sampleRate}
              onChange={(e) => setSampleRate(Number(e.target.value))}
              style={{ fontSize: 11 }}
            >
              {(selectedDevObj?.sample_rates ?? [sampleRate]).map((r) => (
                <option key={r} value={r}>
                  {r === 44100 ? "44.1 kHz" : r === 48000 ? "48 kHz" : r === 88200 ? "88.2 kHz" : `${r / 1000} kHz`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Level meter — visible while recording */}
      {isRecording && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {/* Peak bar */}
          <div style={{ position: "relative", height: 10, background: "var(--bg-2)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${dbToPercent(peakDb)}%`,
              background: meterColor(peakDb),
              transition: "width 40ms linear, background 80ms",
            }} />
            {/* Hold indicator */}
            <div style={{
              position: "absolute", top: 0, bottom: 0, width: 2,
              left: `${dbToPercent(holdPeakDb)}%`,
              background: meterColor(holdPeakDb),
              opacity: 0.9,
            }} />
          </div>
          {/* RMS bar */}
          <div style={{ height: 5, background: "var(--bg-2)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${dbToPercent(rmsDb)}%`,
              background: "oklch(0.55 0.10 145 / 0.7)",
              transition: "width 80ms linear",
            }} />
          </div>
          {/* dB readout */}
          <div style={{
            display: "flex", justifyContent: "space-between",
            fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)",
          }}>
            <span>−60</span>
            <span style={{ color: meterColor(peakDb) }}>
              {peakDb > -96 ? `${peakDb.toFixed(1)} dBFS` : "—"}
            </span>
            <span>0</span>
          </div>
          {/* Warning if signal not detected */}
          {peakDb < -50 && (
            <div style={{ fontSize: 10, color: "var(--fg-4)", fontStyle: "italic" }}>
              No signal detected — check UA Console input levels and phantom power
            </div>
          )}
          {/* Clipping warning */}
          {peakDb > -1 && (
            <div style={{ fontSize: 10, color: "oklch(0.65 0.18 25)" }}>
              ⚠ Clipping — reduce preamp gain in UA Console
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          fontSize: 11, color: "oklch(0.65 0.18 25)",
          padding: "6px 8px", background: "oklch(0.65 0.18 25 / 0.08)",
          borderRadius: "var(--r)", border: "1px solid oklch(0.65 0.18 25 / 0.3)",
        }}>
          {error}
        </div>
      )}

      {/* Sample rate mismatch hint */}
      {sampleRate !== 48000 && !isRecording && (
        <div style={{ fontSize: 10, color: "var(--fg-4)", fontStyle: "italic" }}>
          {sampleRate} Hz will be resampled to 48 kHz for the pipeline
        </div>
      )}

      {/* Action button */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {!isRecording && !isStopping && (
          <button
            className="btn btn-primary"
            onClick={handleRecord}
            disabled={phase === "loading" || !selectedDevice}
            style={{
              background: "color-mix(in oklch, var(--sfx) 80%, var(--bg-1))",
              borderColor: "var(--sfx)",
              color: "var(--bg-1)",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "var(--bg-1)", display: "inline-block",
            }} />
            Record
          </button>
        )}
        {isRecording && (
          <button
            className="btn btn-primary"
            onClick={handleStop}
            style={{
              background: "oklch(0.65 0.18 25)",
              borderColor: "oklch(0.65 0.18 25)",
              color: "white",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: 1,
              background: "white", display: "inline-block",
            }} />
            Stop
          </button>
        )}
        {isStopping && (
          <button className="btn" disabled>Finalising…</button>
        )}
      </div>
    </div>
  );
};
