import React from "react";
import { Icon, Wave, PeaksWave } from "./atoms";
import { PlayButton } from "./PlayButton";
import { useJobStore } from "../../store/jobStore";
import type { Job, MockAssets } from "../../lib/types";

interface AssetBrowserProps {
  assets: MockAssets;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

const KIND_COLOR: Record<string, string> = {
  tts: "var(--tts)",
  sfx: "var(--sfx)",
  music: "var(--music)",
};

function JobAssetRow({ job }: { job: Job }) {
  const color = KIND_COLOR[job.model] ?? "currentColor";
  return (
    <div className={`asset-row ${job.model}`}>
      <div className="swatch" />
      <div className="wave">
        {job.peaks ? (
          <PeaksWave peaks={job.peaks} width={120} height={24} color={color} opacity={0.85} />
        ) : (
          <Wave width={120} height={24} seed={job.id.charCodeAt(0) + job.id.charCodeAt(1)} count={28} color={color} opacity={0.7} />
        )}
      </div>
      <div className="meta">
        <span className="name" title={job.output_path ?? undefined}>{basename(job.output_path!)}</span>
        <span className="sub">{job.description}</span>
      </div>
      <PlayButton path={job.output_path} size={12} />
    </div>
  );
}

export const AssetBrowser: React.FC<AssetBrowserProps> = ({ assets }) => {
  const { jobs } = useJobStore();

  const completedTts   = jobs.filter(j => j.model === "tts"   && j.status === "complete" && j.output_path);
  const completedSfx   = jobs.filter(j => j.model === "sfx"   && j.status === "complete" && j.output_path);
  const completedMusic = jobs.filter(j => j.model === "music" && j.status === "complete" && j.output_path);

  return (
    <div>
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--line-1)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <Icon name="search" style={{ width: 14, height: 14, color: "var(--fg-3)" }} />
        <input
          className="input"
          style={{ background: "transparent", border: "none", padding: 0, fontSize: 12 }}
          placeholder="Search assets…"
        />
      </div>

      <div className="asset-group-head">
        <span>DIALOGUE · {assets.dialogue.length + completedTts.length}</span>
        <span style={{ color: "var(--fg-4)" }}>elv·*</span>
      </div>
      {completedTts.map((j) => <JobAssetRow key={j.id} job={j} />)}
      {assets.dialogue.map((a, i) => (
        <div key={a.id} className={`asset-row ${a.kind}`}>
          <div className="swatch" />
          <div className="wave">
            {a.peaks ? (
              <PeaksWave peaks={a.peaks} width={120} height={24} color="var(--tts)" opacity={0.85} />
            ) : (
              <Wave width={120} height={24} seed={i + 30} count={28} color="var(--tts)" opacity={0.7} />
            )}
          </div>
          <div className="meta">
            <span className="name">{a.name}</span>
            <span className="sub">{a.sub}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <PlayButton path={a.file_path} size={12} />
            <span className={`badge ${a.state}`}>{a.state}</span>
          </div>
        </div>
      ))}

      <div className="asset-group-head">
        <span>SFX · {assets.sfx.length + completedSfx.length}</span>
        <span style={{ color: "var(--fg-4)" }}>sfx-v3</span>
      </div>
      {completedSfx.map((j) => <JobAssetRow key={j.id} job={j} />)}
      {assets.sfx.map((a, i) => (
        <div key={a.id} className={`asset-row ${a.kind}`}>
          <div className="swatch" />
          <div className="wave">
            {a.peaks ? (
              <PeaksWave peaks={a.peaks} width={120} height={24} color="var(--sfx)" opacity={0.85} />
            ) : (
              <Wave width={120} height={24} seed={i + 60} count={32} color="var(--sfx)" opacity={0.7} />
            )}
          </div>
          <div className="meta">
            <span className="name">{a.name}</span>
            <span className="sub">{a.sub}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <PlayButton path={a.file_path} size={12} />
            <span className={`badge ${a.state}`}>{a.state}</span>
          </div>
        </div>
      ))}

      <div className="asset-group-head">
        <span>MUSIC · {assets.music.length + completedMusic.length}</span>
        <span style={{ color: "var(--fg-4)" }}>score-v2</span>
      </div>
      {completedMusic.map((j) => <JobAssetRow key={j.id} job={j} />)}
      {assets.music.map((a, i) => (
        <div key={a.id} className={`asset-row ${a.kind}`}>
          <div className="swatch" />
          <div className="wave">
            {a.peaks ? (
              <PeaksWave peaks={a.peaks} width={120} height={24} color="var(--music)" opacity={0.85} />
            ) : (
              <Wave width={120} height={24} seed={i + 90} count={36} color="var(--music)" opacity={0.7} />
            )}
          </div>
          <div className="meta">
            <span className="name">{a.name}</span>
            <span className="sub">{a.sub}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <PlayButton path={a.file_path} size={12} />
            <span className={`badge ${a.state}`}>{a.state}</span>
          </div>
        </div>
      ))}
    </div>
  );
};
