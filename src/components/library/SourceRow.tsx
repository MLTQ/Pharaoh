/**
 * SourceRow.tsx
 *
 * One uploaded / generated take in a voice-reference sources list. Renders
 * the gold-pick radio dot, play button, filename, and remove control.
 * Shared by both the Voice tab character ref and the per-emotion palette UI.
 */

import React from "react";
import { PlayButton } from "../shared/PlayButton";

export const SourceRow: React.FC<{
  path: string;
  isGold: boolean;
  /** True when this row represents a concat-derived file not in the sources list. */
  derivedConcat: boolean;
  onPickGold: () => void;
  onRemove: () => void;
  disabled: boolean;
}> = ({ path, isGold, derivedConcat, onPickGold, onRemove, disabled }) => {
  const fileName = path.split("/").pop() ?? path;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto auto 1fr auto",
      alignItems: "center",
      gap: 8,
      padding: "6px 10px",
      border: `1px solid ${isGold ? "var(--tts)" : "var(--line-1)"}`,
      background: isGold
        ? "color-mix(in oklch, var(--tts) 10%, var(--bg-1))"
        : "var(--bg-1)",
      borderRadius: "var(--r)",
    }}>
      <button
        onClick={derivedConcat ? undefined : onPickGold}
        disabled={disabled || derivedConcat}
        title={derivedConcat
          ? "Currently using a concat-derived file as gold. Pick a source below to revert."
          : isGold ? "This is the gold reference" : "Use this take as the gold reference for cloning"}
        style={{
          width: 14, height: 14, borderRadius: "50%",
          border: `2px solid ${isGold ? "var(--tts)" : "var(--line-2)"}`,
          background: isGold ? "var(--tts)" : "transparent",
          cursor: derivedConcat || disabled ? "default" : "pointer",
          padding: 0,
        }}
      />
      <PlayButton path={path} size={11} />
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 10,
        color: "var(--fg-3)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        display: "flex", alignItems: "center", gap: 6, minWidth: 0,
      }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{fileName}</span>
        {derivedConcat && (
          <span style={{
            fontSize: 9, color: "var(--tts)", letterSpacing: "0.04em",
            border: "1px solid color-mix(in oklch, var(--tts) 40%, var(--line-1))",
            background: "color-mix(in oklch, var(--tts) 8%, transparent)",
            padding: "0 5px", borderRadius: 3, flexShrink: 0,
          }}>concat</span>
        )}
      </span>
      <button
        className="btn btn-sm"
        onClick={onRemove}
        disabled={disabled}
        title={derivedConcat ? "Drop the concat and pick a source as gold" : "Remove this source"}
        style={{ color: "var(--sfx)", padding: "1px 6px", fontSize: 11 }}
      >×</button>
    </div>
  );
};
