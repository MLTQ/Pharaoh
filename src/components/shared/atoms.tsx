import React from "react";

// ── Icon ────────────────────────────────────────────────────────────────────

type IconName =
  | "pyramid" | "timeline" | "mic" | "waves" | "music" | "book"
  | "folder" | "queue" | "settings" | "play" | "pause" | "skip_back"
  | "skip_fwd" | "record" | "plus" | "minus" | "fit" | "search"
  | "chevron_right" | "chevron_down" | "sparkle" | "history"
  | "download" | "eye";

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  pyramid:       <><path d="M12 3 L21 20 H3 Z" /><path d="M12 3 L12 20" /><path d="M7.5 11.5 H16.5" /></>,
  timeline:      <><rect x="3" y="6" width="18" height="3" rx="0.5" /><rect x="3" y="11" width="14" height="3" rx="0.5" /><rect x="3" y="16" width="10" height="3" rx="0.5" /></>,
  mic:           <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11 V12 a7 7 0 0 0 14 0 V11" /><path d="M12 19 V22" /></>,
  waves:         <><path d="M3 12 q3 -6 6 0 t6 0 t6 0" /><path d="M3 16 q3 -4 6 0 t6 0 t6 0" /></>,
  music:         <><path d="M9 18 a2 2 0 1 1 0 -4 a2 2 0 0 1 0 4 Z" /><path d="M19 16 a2 2 0 1 1 0 -4 a2 2 0 0 1 0 4 Z" /><path d="M9 14 V4 L19 2 V12" /></>,
  book:          <><path d="M4 4 H11 a3 3 0 0 1 3 3 V20" /><path d="M20 4 H13 a3 3 0 0 0 -3 3 V20" /></>,
  folder:        <><path d="M3 6 a1 1 0 0 1 1 -1 H10 L12 7 H20 a1 1 0 0 1 1 1 V18 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 Z" /></>,
  queue:         <><rect x="3" y="5" width="18" height="3" /><rect x="3" y="11" width="13" height="3" /><rect x="3" y="17" width="8" height="3" /></>,
  settings:      <><circle cx="12" cy="12" r="3" /><path d="M19.4 15 a1 1 0 0 0 .2 1.1 l.1 .1 a2 2 0 1 1 -2.8 2.8 l-.1 -.1 a1 1 0 0 0 -1.1 -.2 a1 1 0 0 0 -.6 .9 V20 a2 2 0 1 1 -4 0 v-.1 a1 1 0 0 0 -.7 -.9 a1 1 0 0 0 -1.1 .2 l-.1 .1 a2 2 0 1 1 -2.8 -2.8 l.1 -.1 a1 1 0 0 0 .2 -1.1 a1 1 0 0 0 -.9 -.6 H4 a2 2 0 1 1 0 -4 h.1 a1 1 0 0 0 .9 -.7 a1 1 0 0 0 -.2 -1.1 l-.1 -.1 a2 2 0 1 1 2.8 -2.8 l.1 .1 a1 1 0 0 0 1.1 .2 H9 a1 1 0 0 0 .6 -.9 V4 a2 2 0 1 1 4 0 v.1 a1 1 0 0 0 .6 .9 a1 1 0 0 0 1.1 -.2 l.1 -.1 a2 2 0 1 1 2.8 2.8 l-.1 .1 a1 1 0 0 0 -.2 1.1 V9 a1 1 0 0 0 .9 .6 H20 a2 2 0 1 1 0 4 h-.1 a1 1 0 0 0 -.9 .6 Z" /></>,
  play:          <><path d="M6 4 L20 12 L6 20 Z" fill="currentColor" /></>,
  pause:         <><rect x="6" y="4" width="4" height="16" fill="currentColor" /><rect x="14" y="4" width="4" height="16" fill="currentColor" /></>,
  skip_back:     <><path d="M6 4 V20" /><path d="M20 4 L6 12 L20 20 Z" fill="currentColor" /></>,
  skip_fwd:      <><path d="M18 4 V20" /><path d="M4 4 L18 12 L4 20 Z" fill="currentColor" /></>,
  record:        <><circle cx="12" cy="12" r="6" fill="currentColor" /></>,
  plus:          <><path d="M12 5 V19" /><path d="M5 12 H19" /></>,
  minus:         <><path d="M5 12 H19" /></>,
  fit:           <><path d="M4 9 V4 H9" /><path d="M20 9 V4 H15" /><path d="M4 15 V20 H9" /><path d="M20 15 V20 H15" /></>,
  search:        <><circle cx="11" cy="11" r="6" /><path d="M16 16 L21 21" /></>,
  chevron_right: <path d="M9 6 L15 12 L9 18" />,
  chevron_down:  <path d="M6 9 L12 15 L18 9" />,
  sparkle:       <><path d="M12 3 L13.5 9 L19 10.5 L13.5 12 L12 18 L10.5 12 L5 10.5 L10.5 9 Z" fill="currentColor" /></>,
  history:       <><path d="M3 12 a9 9 0 1 0 3 -6.7" /><path d="M3 4 V9 H8" /><path d="M12 7 V12 L15 14" /></>,
  download:      <><path d="M12 4 V16" /><path d="M6 11 L12 17 L18 11" /><path d="M4 20 H20" /></>,
  eye:           <><path d="M2 12 s4 -7 10 -7 s10 7 10 7 s-4 7 -10 7 s-10 -7 -10 -7 Z" /><circle cx="12" cy="12" r="3" /></>,
};

interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: IconName;
}

export const Icon: React.FC<IconProps> = ({ name, ...rest }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    {ICON_PATHS[name]}
  </svg>
);

// ── Wave ────────────────────────────────────────────────────────────────────

interface WaveProps {
  width?: number;
  height?: number;
  seed?: number;
  color?: string;
  count?: number;
  opacity?: number;
}

export const Wave: React.FC<WaveProps> = ({
  width = 200,
  height = 24,
  seed = 1,
  color = "currentColor",
  count = 60,
  opacity = 0.85,
}) => {
  const rng = (i: number) => {
    const x = Math.sin((seed * 9301 + i * 49297) % 233280) * 43758;
    return Math.abs(x - Math.floor(x));
  };

  const bw = width / count;
  const bars = Array.from({ length: count }, (_, i) => {
    const env = Math.sin((i / count) * Math.PI) * 0.6 + 0.4;
    const r = (rng(i) * 0.7 + 0.3) * env;
    const h = Math.max(1, r * height);
    return (
      <rect
        key={i}
        x={i * bw + bw * 0.2}
        y={(height - h) / 2}
        width={bw * 0.55}
        height={h}
        fill={color}
        opacity={opacity}
      />
    );
  });

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {bars}
    </svg>
  );
};

// ── StatusRing ──────────────────────────────────────────────────────────────

type StatusRingStatus = "draft" | "gen" | "generating" | "ready" | "assets_ready" | "composed" | "rendered";

interface StatusRingProps {
  status: StatusRingStatus;
}

export const StatusRing: React.FC<StatusRingProps> = ({ status }) => {
  const cls =
    status === "gen" || status === "generating" ? "gen"
    : status === "ready" || status === "assets_ready" ? "ready"
    : status === "composed" || status === "rendered" ? "rendered"
    : "draft";
  return <span className={`status-ring ${cls}`} />;
};
