import { useToastStore, type Toast } from "../../store/toastStore";

const KIND_ACCENT: Record<Toast["kind"], string> = {
  info:  "var(--st-gen)",
  warn:  "var(--tts)",
  error: "var(--sfx)",
};

export function ToastHost() {
  const { toasts, dismiss } = useToastStore();
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 18,
        right: 18,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        maxWidth: 380,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => {
        const accent = KIND_ACCENT[t.kind];
        return (
          <div
            key={t.id}
            style={{
              pointerEvents: "auto",
              background: "color-mix(in oklch, var(--bg-1) 92%, black)",
              border: `1px solid ${accent}`,
              borderLeft: `3px solid ${accent}`,
              borderRadius: "var(--r)",
              padding: "10px 12px",
              boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--fg-1)" }}>
                  {t.title}
                </div>
                {t.body && (
                  <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.5 }}>
                    {t.body}
                  </div>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--fg-4)",
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 0,
                }}
                aria-label="dismiss"
              >×</button>
            </div>
            {t.actionLabel && t.onAction && (
              <button
                onClick={() => { t.onAction?.(); dismiss(t.id); }}
                className="btn btn-sm"
                style={{ alignSelf: "flex-start", color: accent }}
              >
                {t.actionLabel}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
