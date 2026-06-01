import React, { useEffect, useRef } from "react";

/**
 * Tiny floating menu that pops up at the right-click cursor position for a
 * timeline clip. Two options today — "Show takes" (existing behavior) and
 * "Spatialize…" (new) — but the component is open-ended so new clip actions
 * can be appended without restructuring CompositionView.
 *
 * Closes on outside click, escape, or scroll. Position is clamped into the
 * viewport so a click in the bottom-right corner still produces a visible
 * menu.
 */
export interface ClipContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onShowTakes: () => void;
  onSpatialize: () => void;
  /** Whether the row already has spatial data, so the label can read "Edit…" instead of "Spatialize…". */
  hasSpatial?: boolean;
}

const MENU_WIDTH = 180;
const MENU_HEIGHT = 80;

export const ClipContextMenu: React.FC<ClipContextMenuProps> = ({
  x, y, onClose, onShowTakes, onSpatialize, hasSpatial,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / escape / scroll. Mirror the pattern used by
  // TakesPopover so the menu feels native to the rest of the timeline.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleScroll = () => onClose();
    // mousedown rather than click so the menu can close before any underlying
    // click handler fires.
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  // Clamp to viewport.
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8);

  return (
    <div
      ref={rootRef}
      role="menu"
      style={{
        position: "fixed",
        left, top,
        width: MENU_WIDTH,
        background: "var(--bg-1)",
        border: "1px solid var(--fg-3)",
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        padding: 4,
        zIndex: 1000,
        fontSize: 13,
        userSelect: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItem onClick={() => { onShowTakes(); onClose(); }}>
        Show takes
      </MenuItem>
      <MenuItem onClick={() => { onSpatialize(); onClose(); }}>
        {hasSpatial ? "Edit spatial position…" : "Spatialize…"}
      </MenuItem>
    </div>
  );
};

const MenuItem: React.FC<React.PropsWithChildren<{ onClick: () => void }>> = ({
  onClick, children,
}) => (
  <button
    role="menuitem"
    onClick={onClick}
    style={{
      display: "block",
      width: "100%",
      textAlign: "left",
      padding: "6px 10px",
      background: "transparent",
      border: "none",
      color: "var(--fg-0)",
      cursor: "pointer",
      borderRadius: 3,
      fontSize: 13,
    }}
    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-2)"; }}
    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
  >
    {children}
  </button>
);
