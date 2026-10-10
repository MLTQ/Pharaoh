// Small layout pieces shared by the Series home tabs.
import React from "react";

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ minWidth: 0 }}>
    <label style={labelStyle}>
      {label}
      {hint && <span style={{ textTransform: "none", letterSpacing: 0, marginLeft: 8, color: "var(--fg-4)", opacity: 0.8 }}>{hint}</span>}
    </label>
    {children}
  </div>
);

export const TwoCol: React.FC<{ children: React.ReactNode; min?: number }> = ({ children, min = 240 }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 14 }}>{children}</div>
);

export const Card: React.FC<{ children: React.ReactNode; accent?: boolean; style?: React.CSSProperties }> = ({ children, accent, style }) => (
  <div style={{
    padding: 18, borderRadius: 4, marginBottom: 14,
    border: `1px solid ${accent ? "var(--music)" : "var(--line-1)"}`,
    background: accent ? "color-mix(in oklch, var(--music) 5%, var(--bg-2))" : "var(--bg-2)",
    ...style,
  }}>{children}</div>
);

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    padding: "32px 24px", textAlign: "center", border: "1px dashed var(--line-2)",
    borderRadius: 3, fontSize: 12, color: "var(--fg-4)", lineHeight: 1.7,
  }}>{children}</div>
);

export const SectionTitle: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({ children, right }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 0 10px", gap: 8 }}>
    <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--fg-0)" }}>{children}</span>
    {right}
  </div>
);

/** One item per line, kept raw while typing; blanks are dropped on save. */
export const LinesInput: React.FC<{ value: string[]; onChange: (v: string[]) => void; minHeight?: number; placeholder?: string }> = ({ value, onChange, minHeight = 70, placeholder }) => (
  <textarea className="textarea" style={{ minHeight }} value={value.join("\n")} placeholder={placeholder}
    onChange={(e) => onChange(e.target.value.split("\n"))} />
);

/** "Food Court!" → "food-court" */
export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function uniqueSlug(base: string, taken: string[]): string {
  const b = slugify(base) || "item";
  if (!taken.includes(b)) return b;
  for (let i = 2; ; i++) if (!taken.includes(`${b}-${i}`)) return `${b}-${i}`;
}

export const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
export const monoMeta: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.04em", color: "var(--fg-4)",
};
export const linkStyle: React.CSSProperties = { color: "var(--music)", textDecoration: "underline", cursor: "pointer" };
export const primaryBtn: React.CSSProperties = { background: "var(--music)", borderColor: "var(--music)", color: "var(--bg-0)" };
