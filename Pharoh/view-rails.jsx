// Asset Browser, Job Queue, Agent Feed (right-rail content)
function AssetBrowser({ assets }) {
  return (
    <div>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="search" style={{ width: 14, height: 14, color: "var(--fg-3)" }} />
        <input className="input" style={{ background: "transparent", border: "none", padding: 0, fontSize: 12 }} placeholder="Search assets…" />
      </div>
      <div className="asset-group-head"><span>DIALOGUE · {assets.dialogue.length}</span><span style={{ color: "var(--fg-4)" }}>elv·*</span></div>
      {assets.dialogue.map((a, i) => (
        <div key={i} className={`asset-row ${a.kind}`}>
          <div className="swatch" />
          <div className="wave"><Wave width={120} height={24} seed={i + 30} count={28} color="var(--tts)" opacity={0.7} /></div>
          <div className="meta"><span className="name">{a.name}</span><span className="sub">{a.sub}</span></div>
          <span className={`badge ${a.state}`}>{a.state}</span>
        </div>
      ))}
      <div className="asset-group-head"><span>SFX · {assets.sfx.length}</span><span style={{ color: "var(--fg-4)" }}>sfx-v3</span></div>
      {assets.sfx.map((a, i) => (
        <div key={i} className={`asset-row ${a.kind}`}>
          <div className="swatch" />
          <div className="wave"><Wave width={120} height={24} seed={i + 60} count={32} color="var(--sfx)" opacity={0.7} /></div>
          <div className="meta"><span className="name">{a.name}</span><span className="sub">{a.sub}</span></div>
          <span className={`badge ${a.state}`}>{a.state}</span>
        </div>
      ))}
      <div className="asset-group-head"><span>MUSIC · {assets.music.length}</span><span style={{ color: "var(--fg-4)" }}>score-v2</span></div>
      {assets.music.map((a, i) => (
        <div key={i} className={`asset-row ${a.kind}`}>
          <div className="swatch" />
          <div className="wave"><Wave width={120} height={24} seed={i + 90} count={36} color="var(--music)" opacity={0.7} /></div>
          <div className="meta"><span className="name">{a.name}</span><span className="sub">{a.sub}</span></div>
          <span className={`badge ${a.state}`}>{a.state}</span>
        </div>
      ))}
    </div>
  );
}

function JobQueue({ jobs }) {
  return (
    <div>
      <div className="asset-group-head"><span>RUNNING · 2</span><span style={{ color: "var(--fg-4)" }}>2 queued</span></div>
      {jobs.map((j, i) => (
        <div key={i} className="job-row">
          <div className="top">
            <span className={`model ${j.model}`}>{j.model}</span>
            <span style={{ color: "var(--fg-3)", fontSize: 10, marginLeft: "auto" }}>{j.t}</span>
          </div>
          <div className="desc">{j.desc}</div>
          <div className="bar"><div className={`bar-fill ${j.pct === 100 ? "done" : ""}`} style={{ width: j.pct + "%" }} /></div>
          <div className="meta"><span>{j.pct}%</span><span>·</span><span>{j.eta}</span></div>
        </div>
      ))}
    </div>
  );
}

function AgentFeed({ log }) {
  return (
    <div className="agent-feed">
      <div className="asset-group-head"><span>AGENT ACTIVITY</span><span style={{ color: "var(--agent)" }}>● live</span></div>
      {log.map((m, i) => (
        <div key={i} className="agent-msg">
          <div className="who"><span className="dot" />{m.who}</div>
          <div className="body">{m.body}</div>
          <div className="meta"><span>{m.t}</span><span>· accept</span><span>· dismiss</span></div>
        </div>
      ))}
    </div>
  );
}

window.AssetBrowser = AssetBrowser;
window.JobQueue = JobQueue;
window.AgentFeed = AgentFeed;
