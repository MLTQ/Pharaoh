import React from "react";
import { Icon } from "./atoms";
import { useAudioStore } from "../../store/audioStore";

interface PlayButtonProps {
  path: string | null;
  size?: number;
}

export const PlayButton: React.FC<PlayButtonProps> = ({ path, size = 14 }) => {
  const { playing, toggle } = useAudioStore();
  if (!path) return null;
  const active = playing === path;
  return (
    <button
      className="btn btn-sm"
      style={{ padding: "2px 5px", minWidth: 0, lineHeight: 1 }}
      title={active ? "Stop" : "Preview"}
      onClick={(e) => { e.stopPropagation(); toggle(path); }}
    >
      <Icon name={active ? "pause" : "play"} style={{ width: size, height: size }} />
    </button>
  );
};
