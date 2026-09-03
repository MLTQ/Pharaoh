import React from "react";

/**
 * Catches render-time exceptions so one broken panel does not blank the app.
 *
 * Without a boundary anywhere, a single bad read — an asset whose sidecar went
 * missing, a script row with an unexpected shape — unmounts the whole tree and
 * leaves the user with a white window and no way back except a restart, with
 * unsaved work still sitting in debounced writers.
 *
 * Wrapped around the main canvas and the right rail separately, so a failure in
 * one keeps the other usable.
 */
interface Props {
  /** Shown in the fallback so the user knows which region failed. */
  label: string;
  /** Remounts the subtree when this changes — e.g. the active view id. */
  resetKey?: string | number | null;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Navigating away from the broken view should clear the fallback; otherwise
    // the region stays dead for the rest of the session.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the component stack — it is the only breadcrumb for a render crash.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 10,
          padding: 20,
          margin: 16,
          border: "1px solid color-mix(in oklch, var(--st-error, oklch(0.72 0.18 25)) 40%, var(--line-1))",
          background: "color-mix(in oklch, var(--st-error, oklch(0.72 0.18 25)) 6%, var(--bg-1))",
          borderRadius: "var(--r)",
          maxWidth: 620,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--st-error, oklch(0.72 0.18 25))",
          }}
        >
          {this.props.label} failed to render
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>
          The rest of the app is still running, and nothing on disk was changed by
          this error. Switching views will retry.
        </div>
        <pre
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--fg-3)",
            background: "var(--bg-0)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--r)",
            padding: "8px 10px",
            margin: 0,
            maxWidth: "100%",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {error.message || String(error)}
        </pre>
        <button className="btn btn-sm" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
