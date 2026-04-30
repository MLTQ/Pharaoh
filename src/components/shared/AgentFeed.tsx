import React from "react";
import type { AgentLogEntry } from "../../lib/types";

interface AgentFeedProps {
  log: AgentLogEntry[];
}

export const AgentFeed: React.FC<AgentFeedProps> = ({ log }) => (
  <div className="agent-feed">
    <div className="asset-group-head">
      <span>AGENT ACTIVITY</span>
      <span style={{ color: "var(--agent)" }}>● live</span>
    </div>
    {log.map((m, i) => (
      <div key={i} className="agent-msg">
        <div className="who">
          <span className="dot" />
          {m.who}
        </div>
        <div className="body">{m.body}</div>
        <div className="meta">
          <span>{m.t}</span>
          <span>· accept</span>
          <span>· dismiss</span>
        </div>
      </div>
    ))}
  </div>
);
