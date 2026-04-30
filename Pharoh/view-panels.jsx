// Generation panels — TTS / SFX / Music with rich descriptors, scene picker, Send-to-Scene
const SceneRouter = ({ scenes, scene, setScene, accent, onSend }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", border: `1px solid ${accent}`, background: `color-mix(in oklch, ${accent} 8%, var(--bg-2))`, borderRadius: 2 }}>
    <span className="kicker" style={{ color: accent }}>ROUTE TO</span>
    <select className="select" style={{ flex: 1, background: "var(--bg-0)" }} value={scene} onChange={e => setScene(e.target.value)}>
      {scenes.map(s => <option key={s.no} value={s.no}>{s.no} · {s.title}</option>)}
    </select>
    <button className="btn btn-primary" onClick={onSend}><Icon name="download" /> Send to scene</button>
  </div>
);

// Rich qwen3-tts style description editor with chip-tags + inline directives
const RichDirector = ({ tags, setTags, value, setValue, accent, presets }) => {
  const allTags = ["whispered", "intimate close mic", "weary", "weatherworn", "low register", "trailing breath", "slight bronchial catch", "deliberate cadence", "Dutch loanwords", "subvocal"];
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {allTags.map(t => {
          const on = tags.includes(t);
          return <button key={t} onClick={() => setTags(on ? tags.filter(x => x !== t) : [...tags, t])}
            style={{ padding: "4px 10px", border: `1px solid ${on ? accent : "var(--line-2)"}`, background: on ? `color-mix(in oklch, ${accent} 14%, transparent)` : "var(--bg-2)", color: on ? "var(--fg-0)" : "var(--fg-2)", borderRadius: 1, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.05em", cursor: "pointer" }}>{t}</button>;
        })}
      </div>
      <textarea className="textarea" value={value} onChange={e => setValue(e.target.value)} style={{ minHeight: 160, fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6 }} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {presets.map(p => <button key={p.label} onClick={() => setValue(v => v + p.insert)} className="btn btn-sm" style={{ borderColor: accent, color: accent }}>+ {p.label}</button>)}
      </div>
    </div>
  );
};

function TTSPanel({ cast, scenes, defaultScene }) {
  const [scene, setScene] = React.useState(defaultScene);
  const [speaker, setSpeaker] = React.useState("VERA");
  const [tags, setTags] = React.useState(["intimate close mic", "weary", "trailing breath"]);
  const [value, setValue] = React.useState("[voice: VERA · elv·burnish-04]\n[delivery: half-whispered, looking up; the lamp is the only light]\n[acoustic: salt chamber, 2.4s tail, no music bed]\n\n(she swallows)\nIt can't go this deep. The geological survey said sixty meters — we've been descending for twenty minutes.\n\n[breath · 0.4s]\n\n(barely audible)\nAbel? Is that you down there?");
  const [pace, setPace] = React.useState(0.92);
  return (
    <div className="panel-view">
      <div className="panel-main">
        <div className="panel-header">
          <div className="panel-header-left">
            <span className="eyebrow tts">qwen3-tts · elv·burnish-04</span>
            <span className="ttl">Voice / Dialogue</span>
            <span className="desc">Rich-text director: bracket directives shape voice, delivery, acoustic, and timing. Chip tags, inline cues, and stage directions all interpreted by the model.</span>
          </div>
          <button className="btn btn-tts"><Icon name="sparkle" /> Generate take</button>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={setScene} accent="var(--tts)" onSend={() => alert(`Sent to ${scene}`)} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Speaker</div>
        <div className="speaker-grid">
          {cast.slice(0, 6).map(c => (
            <div key={c.id} className={`speaker-card ${speaker === c.id ? "active" : ""}`} onClick={() => setSpeaker(c.id)}>
              <span className="id">{c.id} · {c.scenes} sc</span>
              <span className="name">{c.name}</span>
              <span className="desc">{c.voice}</span>
              <div className="wave"><Wave width={200} height={16} seed={c.id.charCodeAt(0)} count={42} color="var(--tts)" /></div>
            </div>
          ))}
        </div>

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · rich text</div>
        <RichDirector tags={tags} setTags={setTags} value={value} setValue={setValue} accent="var(--tts)" presets={[
          { label: "breath", insert: "\n[breath · 0.3s]\n" },
          { label: "stage direction", insert: "\n(beat, looking away)\n" },
          { label: "voice override", insert: "\n[voice: NARR · third-person, patinated]\n" },
          { label: "acoustic", insert: "\n[acoustic: dry close mic, no reverb]\n" },
          { label: "emphasis", insert: " *emphasis*" },
        ]} />

        <div className="field-row" style={{ marginTop: 18 }}>
          <div className="field"><div className="field-label"><span>Pace</span><span className="hint">{pace.toFixed(2)}×</span></div>
            <div className="slider-row"><input type="range" className="slider tts" min="0.5" max="1.5" step="0.01" value={pace} onChange={e => setPace(+e.target.value)} /><span className="slider-val">{pace.toFixed(2)}</span></div></div>
          <div className="field"><div className="field-label"><span>Mic distance</span></div>
            <div className="toggle-group"><button>close</button><button className="active">intimate</button><button>room</button><button>distant</button></div></div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <div className="field-label"><span>Latest take · 0:18 · take 4</span><span className="hint">seed 4412</span></div>
          <div style={{ border: "1px solid var(--line-1)", background: "var(--bg-2)", padding: 14, borderRadius: 2, display: "flex", alignItems: "center", gap: 14 }}>
            <button className="btn btn-icon" style={{ background: "var(--tts)", color: "var(--bg-0)", borderColor: "var(--tts)" }}><Icon name="play" /></button>
            <div style={{ flex: 1, height: 36 }}><Wave width={500} height={36} seed={42} count={120} color="var(--tts)" /></div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)" }}>0:00 / 0:18</span>
          </div>
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section"><h3>Voice fingerprint</h3>
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "var(--fg-2)" }}>Burnished alto with a slight bronchial catch on consonants. Locked to creator approval 2026-04-12.</div></div>
        <div className="panel-side-section"><h3>Continuity check</h3>
          {[{ ok: true, t: "Pronunciation 'Constance' matches S02 take 4" }, { ok: true, t: "Mic distance consistent with Vault scenes" }, { ok: false, t: "'salt' vowel drift — 2.1% from baseline" }].map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 11.5, lineHeight: 1.4, marginBottom: 6 }}>
              <span style={{ color: c.ok ? "var(--st-rendered)" : "var(--st-gen)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{c.ok ? "✓ OK" : "△ WARN"}</span>
              <span style={{ color: "var(--fg-1)" }}>{c.t}</span></div>))}</div>
        <div className="panel-side-section"><h3>Cost</h3>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--fg-3)" }}>EST.</span><span>0.018 cr · 12s</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--fg-3)" }}>EPISODE</span><span>4.21 cr · 47m</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--fg-3)" }}>BUDGET</span><span style={{ color: "var(--st-rendered)" }}>17.79 cr</span></div></div></div>
      </div>
    </div>
  );
}

function SFXPanel({ scenes, defaultScene }) {
  const [scene, setScene] = React.useState(defaultScene);
  const [tags, setTags] = React.useState(["wet salt", "cavern · 2.4s tail", "doubled rhythm"]);
  const [value, setValue] = React.useState("[surface: wet salt floor, fine grit underfoot]\n[space: salt chamber, 2.4s reverb tail, low rumble bed]\n[rhythm: slow walk · 52 bpm · doubled half-beat behind]\n\nFootsteps approach from camera, deliberate and measured. A second pair, half a beat behind, echoing back from the tunnel — same gait, same weight. The doubling tightens through the middle, then drifts ahead of the original.");
  return (
    <div className="panel-view">
      <div className="panel-main">
        <div className="panel-header">
          <div className="panel-header-left">
            <span className="eyebrow sfx">sfx-v3 · foley</span>
            <span className="ttl">Sound Design</span>
            <span className="desc">Describe foley, ambiences and one-shots with structured directives. Length-locked to selection on the timeline.</span>
          </div>
          <button className="btn" style={{ borderColor: "var(--sfx-d)", color: "var(--sfx)", background: "color-mix(in oklch, var(--sfx) 10%, transparent)" }}><Icon name="sparkle" /> Generate · 4 variations</button>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={setScene} accent="var(--sfx)" onSend={() => alert(`Sent to ${scene}`)} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · rich text</div>
        <RichDirector tags={tags} setTags={setTags} value={value} setValue={setValue} accent="var(--sfx)" presets={[
          { label: "surface", insert: "\n[surface: gravel slope, dry]\n" },
          { label: "space", insert: "\n[space: cavern · 2.4s tail]\n" },
          { label: "rhythm", insert: "\n[rhythm: 52 bpm · sparse]\n" },
          { label: "layer", insert: "\n[layer: distant generator, sub 60Hz]\n" },
        ]} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Variations · 4</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
          {[{ v: "A", seed: 1188, sel: false, note: "doubled · half-beat" }, { v: "B", seed: 1189, sel: true, note: "doubled · in rhythm" }, { v: "C", seed: 1190, sel: false, note: "single · pronounced" }, { v: "D", seed: 1191, sel: false, note: "scuffle · uneven" }].map(v => (
            <div key={v.v} style={{ border: `1px solid ${v.sel ? "var(--sfx)" : "var(--line-1)"}`, background: v.sel ? "color-mix(in oklch, var(--sfx) 8%, var(--bg-2))" : "var(--bg-2)", padding: 12, borderRadius: 2, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}><span style={{ color: "var(--fg-1)" }}>VARIATION {v.v}</span><span style={{ color: "var(--fg-3)" }}>seed {v.seed}</span></div>
              <div style={{ height: 36 }}><Wave width={400} height={36} seed={v.seed} count={100} color="var(--sfx)" /></div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontSize: 11, color: "var(--fg-2)" }}>{v.note}</span><button className="btn btn-sm">{v.sel ? "use" : "audition"}</button></div>
            </div>))}
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section"><h3>Reference uploads</h3>
          <div className="dropzone"><span className="label">Drop reference WAV / MP3</span><span className="sublabel">Up to 30s · timbre + rhythm anchor</span></div></div>
        <div className="panel-side-section"><h3>Library matches</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
            {[{ n: "salt-flat-walk-04.wav", m: "92%" }, { n: "mine-shaft-double.wav", m: "81%" }, { n: "wet-grit-slow.wav", m: "74%" }].map(l => (
              <div key={l.n} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--line-1)" }}><span style={{ color: "var(--fg-1)" }}>{l.n}</span><span style={{ color: "var(--sfx)" }}>{l.m}</span></div>))}
          </div></div>
      </div>
    </div>
  );
}

function MusicPanel({ scenes, defaultScene }) {
  const [scene, setScene] = React.useState(defaultScene);
  const [tags, setTags] = React.useState(["Am", "64 bpm", "textless voice", "low strings", "metronome"]);
  const [value, setValue] = React.useState("[key: Am · tempo: 64 bpm · meter: 4/4]\n[ensemble: textless female voice, low strings, hand percussion, metronome that drifts -3% by 1:04]\n[arc: salt hymn dissolving into arithmetic]\n[hits: 0:42 — Vera reaches chamber floor; 1:28 — final line, cut to silence]\n\nA salt hymn dissolving into arithmetic. Begin sparse on solo voice. Strings join at 0:18 with a sub on Db. The metronome, once steady, gradually loses time. Resolves on Vera's last line.");
  return (
    <div className="panel-view">
      <div className="panel-main">
        <div className="panel-header">
          <div className="panel-header-left">
            <span className="eyebrow music">score-v2</span>
            <span className="ttl">Score Composition</span>
            <span className="desc">Compose cues against a hit list. Score-v2 follows tempo, key, and beat anchors locked to the scene timeline.</span>
          </div>
          <button className="btn" style={{ borderColor: "var(--music-d)", color: "var(--music)", background: "color-mix(in oklch, var(--music) 10%, transparent)" }}><Icon name="sparkle" /> Compose cue</button>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={setScene} accent="var(--music)" onSend={() => alert(`Sent to ${scene}`)} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · rich text</div>
        <RichDirector tags={tags} setTags={setTags} value={value} setValue={setValue} accent="var(--music)" presets={[
          { label: "key", insert: "\n[key: Am]\n" }, { label: "tempo", insert: "\n[tempo: 64 bpm]\n" },
          { label: "ensemble", insert: "\n[ensemble: low strings, voice]\n" }, { label: "hit", insert: "\n[hit: 0:42 — moment]\n" },
        ]} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Hit list · 1:36</div>
        <div style={{ border: "1px solid var(--line-1)", background: "var(--bg-2)", borderRadius: 2 }}>
          {[{ t: "0:00", n: "Cue start · solo voice enters" }, { t: "0:18", n: "Strings join · sub on Db" }, { t: "0:42", n: "HIT · Vera reaches chamber floor" }, { t: "1:04", n: "Metronome begins to drift (-3%)" }, { t: "1:28", n: "HIT · final line · cut to silence" }].map((h, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "70px 1fr auto", padding: "8px 14px", borderBottom: i < 4 ? "1px solid var(--line-1)" : "none", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--music)" }}>{h.t}</span>
              <span style={{ fontSize: 12, color: "var(--fg-1)" }}>{h.n}</span>
              <button className="btn btn-sm">edit</button></div>))}
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section"><h3>Reference</h3>
          <div className="dropzone"><span className="label">Drop reference cue</span><span className="sublabel">Stems separate automatically</span></div></div>
      </div>
    </div>
  );
}

function StoryBibleView({ project, cast }) {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--bg-1)" }}>
      <div className="grain" />
      <div className="doc">
        <div style={{ borderBottom: "1px solid var(--line-1)", paddingBottom: 22, marginBottom: 24 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>Story Bible · {project.revision} · last sync {project.lastSync}</div>
          <h1 style={{ fontSize: 34, margin: "0 0 8px", fontWeight: 600, letterSpacing: "-0.015em", color: "var(--fg-0)" }}>{project.title}</h1>
          <div style={{ color: "var(--fg-2)", fontSize: 14, fontStyle: "italic" }}>{project.subtitle}</div>
        </div>
        <h2>Logline</h2>
        <p style={{ fontStyle: "italic", color: "var(--fg-0)", fontSize: 14 }}>"{project.logline}"</p>
        <h2>Synopsis</h2>
        <p>Vera Halloran has spent three winters cataloguing the disappearing dialects of the salt belt. When her brother Abel sends a final transmission consisting only of a hymn and a man counting backward in Dutch, Vera drives north toward a town called Sluis that no satellite has ever photographed.</p>
        <p>What she finds beneath the salt is older than the mine. The voice on the radio has been speaking for forty-one years. It knows her name.</p>
        <h3>Cast & voice direction</h3>
        {cast.map(c => (
          <div key={c.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--line-1)", display: "grid", gridTemplateColumns: "120px 1fr 100px", gap: 16, alignItems: "baseline" }}>
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--fg-3)", fontSize: 11, letterSpacing: "0.1em" }}>{c.id}</div>
            <div><div style={{ color: "var(--fg-0)", fontWeight: 500, marginBottom: 4 }}>{c.name}</div>
              <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
                {c.id === "VERA" && "Burnished alto. Forensic, attentive. Understates fear."}
                {c.id === "ABEL" && "Lower, hoarser. Long breaths between phrases."}
                {c.id === "CONST" && "Warm but professionally distant. Knows more than she says."}
                {c.id === "RADIO" && "Disembodied. Counts backward in Dutch."}
                {c.id === "NARR" && "Patinated, third-person."}
              </div></div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--tts)", textAlign: "right" }}>{c.voice}</div>
          </div>))}
      </div>
    </div>
  );
}

window.TTSPanel = TTSPanel;
window.SFXPanel = SFXPanel;
window.MusicPanel = MusicPanel;
window.StoryBibleView = StoryBibleView;
