//! The writers' room: "make me an episode of X".
//!
//! A series bible (cast, sets, formula, style, sound package, canon) becomes
//! a prompt brief. Claude pitches, plans a beat sheet, writes the episode in
//! audio-drama Fountain and punches it up. The script is imported into a new
//! episode project with the ordinary Fountain import, then `#cue` sound rows
//! are bound to the series' approved audio and the canon log is extended.
//! Everything after the import is the one-shot pipeline, unchanged.

use std::path::Path;

use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_support::{
    app_projects_dir, project_dir, read_json, read_script_rows, scene_dir, write_json, write_script_rows,
};
use crate::commands::series::{create_episode_at, load_canon, load_series, store_canon};
use crate::error::{Error, Result};
use crate::models::{AppConfig, AppState, CanonEntry, Project, Series, Storyboard};

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const DEFAULT_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// Spoken words per minute of audio drama, dialogue and narration together.
const WORDS_PER_MINUTE: u32 = 150;
/// Most recent canon entries given to the writer.
const CANON_IN_BRIEF: usize = 24;

// ── Shapes ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Pitch {
    pub title: String,
    pub logline: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct EpisodePlan {
    pub title: String,
    pub logline: String,
    pub synopsis: String,
    pub scenes: Vec<PlannedScene>,
    /// New characters this episode needs (the monster, the client, the guest).
    pub guests: Vec<Guest>,
    /// Canon facts or running gags the episode pays off.
    pub callbacks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PlannedScene {
    pub heading: String,
    /// `SeriesSet.id`, or "" for a one-off location.
    pub set_id: String,
    /// Formula beat or act this scene belongs to.
    pub act: String,
    pub summary: String,
    pub characters: Vec<String>,
    pub beats: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Guest {
    pub name: String,
    pub description: String,
    /// Timbre for voice design: age, accent, texture.
    pub voice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct Draft {
    fountain: String,
    canon: CanonDraft,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CanonDraft {
    pub summary: String,
    pub facts: Vec<String>,
    pub gags: Vec<String>,
    pub threads: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct WriterSettings {
    pub model: Option<String>,
    pub api_key_env: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct WriteEpisodeArgs {
    pub series_id: String,
    pub premise: String,
    /// Skip planning and write from this beat sheet (e.g. one the user edited).
    pub plan: Option<EpisodePlan>,
    /// Write into this existing episode instead of creating one.
    pub episode_id: Option<String>,
    /// Run the writers'-room punch-up pass (default on).
    pub punch_up: Option<bool>,
    #[serde(flatten)]
    pub settings: WriterSettings,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteEpisodeResult {
    pub project: Project,
    pub plan: EpisodePlan,
    pub fountain: String,
    pub scenes: usize,
    /// `#cue` rows bound to approved series audio.
    pub sound_cues_bound: usize,
    pub new_characters: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriterProgress {
    pub series_id: String,
    pub stage: String,
    pub message: String,
}

// ── Brief ────────────────────────────────────────────────────────────────────

fn push_field(out: &mut String, label: &str, value: &str) {
    let v = value.trim();
    if !v.is_empty() {
        out.push_str(&format!("- {label}: {v}\n"));
    }
}

/// The series bible as Markdown: what every writer prompt is built on, and
/// what `pharaoh series brief` prints.
pub fn series_brief(series: &Series, canon: &[CanonEntry]) -> String {
    let mut o = String::new();
    o.push_str(&format!("# {}\n\n", series.title));
    if series.episode_minutes > 0 {
        o.push_str(&format!(
            "Episodes run about {} minutes (~{} spoken words).\n\n",
            series.episode_minutes,
            series.episode_minutes * WORDS_PER_MINUTE
        ));
    }
    push_field(&mut o, "Logline", &series.logline);
    push_field(&mut o, "Premise", &series.premise);
    push_field(&mut o, "Tone", &series.tone);
    push_field(&mut o, "Rating", &series.style.rating);
    let themes: Vec<&str> = series.themes.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    if !themes.is_empty() {
        push_field(&mut o, "Themes", &themes.join(", "));
    }
    push_field(
        &mut o,
        "Continuity",
        if series.continuity == "serialized" {
            "serialized: events carry forward and canon is binding"
        } else {
            "episodic: the status quo resets by the end of each episode; canon is for callbacks"
        },
    );
    if !series.world.trim().is_empty() {
        o.push_str(&format!("\n## World\n{}\n", series.world.trim()));
    }

    if !series.cast.is_empty() {
        o.push_str("\n## Cast\nCharacter cues must use these names, in capitals.\n");
        for m in &series.cast {
            o.push_str(&format!("\n### {}\n", m.name.trim()));
            push_field(&mut o, "Who", &m.description);
            push_field(&mut o, "Wants", &m.want);
            push_field(&mut o, "Flaw", &m.flaw);
            push_field(&mut o, "Engine", &m.engine);
            push_field(&mut o, "How they talk", &m.voice_notes);
            let cps: Vec<&str> = m.catchphrases.iter().map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
            if !cps.is_empty() {
                push_field(&mut o, "Catchphrases (at most one use each per episode)", &cps.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join("; "));
            }
            let lazzi: Vec<&str> = m.lazzi.iter().map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
            if !lazzi.is_empty() {
                push_field(&mut o, "Signature bits", &lazzi.join("; "));
            }
            push_field(&mut o, "Never", &m.never);
            for r in &m.relationships {
                if let Some(other) = series.cast.iter().find(|x| x.id == r.with) {
                    push_field(&mut o, &format!("With {}", other.name.trim()), &r.dynamic);
                }
            }
        }
    }

    if !series.sets.is_empty() {
        o.push_str("\n## Sets\nRecurring locations. Use the heading exactly and open the scene with its bed line.\n");
        for s in &series.sets {
            let bed = match s.bed_sound.as_deref().and_then(|id| series.sounds.iter().find(|c| c.id == id)) {
                Some(c) => format!("BED: #{}", c.id),
                None if !s.bed.trim().is_empty() => format!("BED: {}", s.bed.trim()),
                None => String::new(),
            };
            o.push_str(&format!("- set_id `{}`: {} — heading `{}`", s.id, s.name.trim(), s.heading.trim()));
            if !bed.is_empty() {
                o.push_str(&format!(" — bed line `{bed}`"));
            }
            if !s.description.trim().is_empty() {
                o.push_str(&format!(" — {}", s.description.trim()));
            }
            o.push('\n');
        }
    }

    let sounds: Vec<_> = series.sounds.iter().filter(|c| !c.id.trim().is_empty()).collect();
    if !sounds.is_empty() {
        o.push_str("\n## Sound package\nThe show's recurring audio. Place one with its tag alone after the cue, e.g. `MUSIC: #theme`; the tag plays the show's recording.\n");
        for c in sounds {
            let line = if c.kind == "bed" || c.kind == "sfx" { if c.kind == "bed" { "BED" } else { "SFX" } } else { "MUSIC" };
            o.push_str(&format!("- `{}: #{}` ({}) {}", line, c.id, c.kind, c.label.trim()));
            if !c.usage.trim().is_empty() {
                o.push_str(&format!(" — use for: {}", c.usage.trim()));
            }
            o.push('\n');
        }
    }

    if !series.formula.is_empty() {
        o.push_str("\n## Formula\n");
        for (i, b) in series.formula.iter().enumerate() {
            o.push_str(&format!("{}. {}", i + 1, b.name.trim()));
            if !b.description.trim().is_empty() {
                o.push_str(&format!(" — {}", b.description.trim()));
            }
            o.push('\n');
        }
    }

    let st = &series.style;
    o.push_str("\n## Style\n");
    match st.narrator.as_str() {
        "full" => push_field(&mut o, "Narrator", &format!("{} narrates throughout, sparingly, between dialogue", narrator_name(series))),
        "cold_open" => push_field(&mut o, "Narrator", &format!("{} speaks only in the cold open and the closing tag", narrator_name(series))),
        _ => push_field(&mut o, "Narrator", "none; everything is carried by dialogue and sound"),
    }
    push_field(&mut o, "House style", &st.house_style);
    let banned: Vec<&str> = st.banned.iter().map(|b| b.trim()).filter(|b| !b.is_empty()).collect();
    if !banned.is_empty() {
        push_field(&mut o, "Never write", &banned.iter().map(|b| format!("\"{b}\"")).collect::<Vec<_>>().join(", "));
    }
    let golden: Vec<_> = st.golden.iter().filter(|g| !g.fountain.trim().is_empty()).collect();
    if !golden.is_empty() {
        o.push_str("\n## Golden scenes\nThe show at its best. Match this voice; don't reuse the jokes.\n");
        for g in golden {
            o.push_str(&format!("\n### {}\n", if g.title.trim().is_empty() { "Example" } else { g.title.trim() }));
            if !g.note.trim().is_empty() {
                o.push_str(&format!("Why it works: {}\n", g.note.trim()));
            }
            o.push_str(&format!("```fountain\n{}\n```\n", g.fountain.trim()));
        }
    }

    if !canon.is_empty() {
        o.push_str("\n## Canon so far\nPrevious episodes, oldest first. Don't repeat their plots; pay off their gags and threads when it helps.\n");
        let skip = canon.len().saturating_sub(CANON_IN_BRIEF);
        for c in &canon[skip..] {
            o.push_str(&format!("\n### {}\n{}\n", c.episode_title.trim(), c.summary.trim()));
            for (label, items) in [("Facts", &c.facts), ("Running gags", &c.gags), ("Open threads", &c.threads)] {
                let items: Vec<&str> = items.iter().map(|x| x.trim()).filter(|x| !x.is_empty()).collect();
                if !items.is_empty() {
                    o.push_str(&format!("- {label}: {}\n", items.join("; ")));
                }
            }
        }
    }
    o
}

fn narrator_name(series: &Series) -> String {
    let n = series.style.narrator_name.trim();
    if n.is_empty() { "NARRATOR".into() } else { n.to_uppercase() }
}

const SYSTEM: &str = "You are the head writer of an audio drama series. You know the show's bible by heart and write for the ear.\n\
\n\
Scripts are Fountain, extended for audio:\n\
- Every scene starts with a heading line (INT./EXT. PLACE - TIME). Acts or formula beats are section lines: `# Cold Open`, `# Act One`.\n\
- CHARACTER cues in capitals on their own line, dialogue beneath. Use the cast's names exactly.\n\
- (parenthetical) under a cue is a short delivery note for the voice actor: tone, pace, volume. Never physical action.\n\
- `SFX: …` sound effects, `BED: …` ambience for the scene, `MUSIC: …` score. A tag such as `MUSIC: #theme` plays the show's own recording; use tags only from the sound package.\n\
- Plain lines are directions; the listener never hears them, so keep them rare.\n\
\n\
Write for the ear: anything that matters must be heard, through dialogue, sound or the narrator. Characters say who they're talking to when it isn't obvious. Short, speakable lines; interruptions end with `--`; `(beat)` marks a timing pause. Comedy comes from the characters' engines colliding, not from jokes bolted on: specific, surprising, escalating, with callbacks paid off. Keep each character's voice distinct enough to identify without the cue.\n\
\n\
Never reproduce lyrics or copyrighted text.";

// ── Claude ───────────────────────────────────────────────────────────────────

struct Claude {
    client: reqwest::Client,
    key: String,
    model: String,
    tokens: (u64, u64),
}

impl Claude {
    fn new(settings: &WriterSettings) -> Result<Self> {
        let env = settings.api_key_env.clone().filter(|e| !e.trim().is_empty()).unwrap_or_else(|| DEFAULT_KEY_ENV.into());
        let key = std::env::var(&env).ok().filter(|k| !k.trim().is_empty()).ok_or_else(|| {
            Error::Other(format!("{env} is not set; the episode writer needs an Anthropic API key"))
        })?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(1800))
            .build()
            .map_err(|e| Error::Other(format!("http client init failed: {e}")))?;
        Ok(Self {
            client,
            key,
            model: settings.model.clone().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| DEFAULT_MODEL.into()),
            tokens: (0, 0),
        })
    }

    /// One structured-output request, streamed so long scripts don't hit
    /// HTTP timeouts. Returns the parsed JSON object.
    async fn ask<T: for<'de> Deserialize<'de>>(
        &mut self,
        prompt: &str,
        schema: serde_json::Value,
        effort: &str,
        max_tokens: u32,
    ) -> Result<T> {
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "stream": true,
            "system": SYSTEM,
            "thinking": { "type": "adaptive" },
            "output_config": {
                "effort": effort,
                "format": { "type": "json_schema", "schema": schema }
            },
            "fallbacks": "default",
            "messages": [{ "role": "user", "content": prompt }],
        });
        let resp = self
            .client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.key)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "server-side-fallback-2026-07-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Other(format!("anthropic request failed: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let msg = resp.text().await.unwrap_or_default().chars().take(500).collect::<String>();
            return Err(Error::Other(format!("anthropic returned {status}: {msg}")));
        }

        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut text = String::new();
        let mut stop_reason: Option<String> = None;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| Error::Other(format!("anthropic stream failed: {e}")))?;
            buf.extend_from_slice(&chunk);
            while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(data) = line.trim().strip_prefix("data:") else { continue };
                let Ok(ev) = serde_json::from_str::<serde_json::Value>(data.trim()) else { continue };
                match ev["type"].as_str() {
                    Some("message_start") => {
                        self.tokens.0 += ev["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
                    }
                    Some("content_block_start") => {
                        // A mid-stream decline hands over to the fallback
                        // model, which starts its answer again.
                        if ev["content_block"]["type"] == "fallback" {
                            text.clear();
                        }
                    }
                    Some("content_block_delta") => {
                        if ev["delta"]["type"] == "text_delta" {
                            text.push_str(ev["delta"]["text"].as_str().unwrap_or(""));
                        }
                    }
                    Some("message_delta") => {
                        if let Some(r) = ev["delta"]["stop_reason"].as_str() {
                            stop_reason = Some(r.to_string());
                        }
                        self.tokens.1 += ev["usage"]["output_tokens"].as_u64().unwrap_or(0);
                    }
                    Some("error") => {
                        return Err(Error::Other(format!(
                            "anthropic stream error: {}",
                            ev["error"]["message"].as_str().unwrap_or("unknown")
                        )));
                    }
                    _ => {}
                }
            }
        }
        match stop_reason.as_deref() {
            Some("refusal") => return Err(Error::Other("Claude declined to write this; try a different premise".into())),
            Some("max_tokens") => return Err(Error::Other("the answer was cut off (max_tokens); try a shorter episode length".into())),
            _ => {}
        }
        serde_json::from_str(text.trim()).map_err(|e| Error::Other(format!("Claude's answer wasn't valid JSON: {e}")))
    }
}

fn obj(props: serde_json::Value) -> serde_json::Value {
    let required: Vec<String> = props.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    serde_json::json!({ "type": "object", "additionalProperties": false, "required": required, "properties": props })
}

fn strings() -> serde_json::Value {
    serde_json::json!({ "type": "array", "items": { "type": "string" } })
}

fn s() -> serde_json::Value {
    serde_json::json!({ "type": "string" })
}

fn pitch_schema() -> serde_json::Value {
    obj(serde_json::json!({
        "pitches": { "type": "array", "items": obj(serde_json::json!({ "title": s(), "logline": s() })) }
    }))
}

fn plan_schema() -> serde_json::Value {
    obj(serde_json::json!({
        "title": s(),
        "logline": s(),
        "synopsis": s(),
        "scenes": { "type": "array", "items": obj(serde_json::json!({
            "heading": s(), "set_id": s(), "act": s(), "summary": s(),
            "characters": strings(), "beats": strings(),
        })) },
        "guests": { "type": "array", "items": obj(serde_json::json!({ "name": s(), "description": s(), "voice": s() })) },
        "callbacks": strings(),
    }))
}

fn draft_schema() -> serde_json::Value {
    obj(serde_json::json!({
        "fountain": s(),
        "canon": obj(serde_json::json!({ "summary": s(), "facts": strings(), "gags": strings(), "threads": strings() })),
    }))
}

// ── Stages ───────────────────────────────────────────────────────────────────

fn load_bible(projects_dir: &Path, series_id: &str) -> Result<(Series, Vec<CanonEntry>, String)> {
    let series = load_series(projects_dir, series_id)?;
    let canon = load_canon(projects_dir, series_id)?;
    let brief = series_brief(&series, &canon);
    Ok((series, canon, brief))
}

pub async fn pitch_impl(projects_dir: &Path, series_id: &str, hint: &str, settings: &WriterSettings) -> Result<Vec<Pitch>> {
    let (_, _, brief) = load_bible(projects_dir, series_id)?;
    let mut claude = Claude::new(settings)?;
    let ask = if hint.trim().is_empty() { String::new() } else { format!(" Steer toward: {}.", hint.trim()) };
    let prompt = format!(
        "{brief}\n\n---\nPitch three new episodes of this show. Make them different from each other and from the canon: different engines, different cast pairings, at least one built around a guest.{ask} Title plus a one- or two-sentence logline that names the complication."
    );
    #[derive(Deserialize)]
    struct Pitches {
        pitches: Vec<Pitch>,
    }
    let p: Pitches = claude.ask(&prompt, pitch_schema(), "medium", 16000).await?;
    Ok(p.pitches)
}

async fn plan_with(claude: &mut Claude, brief: &str, series: &Series, premise: &str) -> Result<EpisodePlan> {
    let minutes = series.episode_minutes.max(1);
    let prompt = format!(
        "{brief}\n\n---\nPremise for this episode: {premise}\n\n\
Write the beat sheet. Follow the formula if there is one; each scene names its act or beat. Use the series sets where they fit (set_id and their exact heading); for a one-off place leave set_id empty. Aim for {minutes} minutes: scenes that each turn something. Give every scene the beats that happen in it, in order. \
List any new characters the episode needs as guests (at most two), each with a voice description for casting: age, accent, timbre, texture. Note which canon facts, gags or threads it pays off.",
        premise = if premise.trim().is_empty() { "(your choice; surprise me)" } else { premise.trim() },
    );
    claude.ask(&prompt, plan_schema(), "high", 32000).await
}

pub async fn plan_impl(projects_dir: &Path, series_id: &str, premise: &str, settings: &WriterSettings) -> Result<EpisodePlan> {
    let (series, _, brief) = load_bible(projects_dir, series_id)?;
    let mut claude = Claude::new(settings)?;
    plan_with(&mut claude, &brief, &series, premise).await
}

/// Plan (unless given), write, punch up, import, bind sound cues, log canon.
pub async fn write_impl(
    config: &AppConfig,
    args: WriteEpisodeArgs,
    progress: &(dyn Fn(&str, &str) + Send + Sync),
) -> Result<WriteEpisodeResult> {
    let projects_dir = std::path::PathBuf::from(&config.projects_dir);
    let (series, mut canon, brief) = load_bible(&projects_dir, &args.series_id)?;
    // Fail before spending tokens if the target episode is wrong.
    if let Some(eid) = args.episode_id.as_deref() {
        let p: Project = read_json(&project_dir(&projects_dir, eid).join("project.json"))?;
        if p.series_id.as_deref() != Some(series.id.as_str()) {
            return Err(Error::Other(format!("project {eid} is not an episode of {}", series.title)));
        }
    }
    let mut claude = Claude::new(&args.settings)?;

    let plan = match args.plan.clone().filter(|p| !p.scenes.is_empty()) {
        Some(p) => p,
        None => {
            progress("plan", "Breaking the story");
            plan_with(&mut claude, &brief, &series, &args.premise).await?
        }
    };
    let plan_json = serde_json::to_string_pretty(&plan)?;
    let words = series.episode_minutes.max(1) * WORDS_PER_MINUTE;

    progress("write", "Writing the script");
    let mut draft: Draft = claude
        .ask(
            &format!(
                "{brief}\n\n---\nBeat sheet:\n```json\n{plan_json}\n```\n\n\
Write the full episode from this beat sheet: about {words} spoken words. Start with a title page line `Title: {}`. Use section lines for the acts, every scene heading from the sheet, the set bed lines, and the sound package tags where they belong (opening titles, act breaks, the closing). Guests speak under the names in the sheet. \
Also return the canon entry this episode adds: a two-sentence summary, the facts it establishes, running gags it starts or extends, and threads it leaves open.",
                plan.title
            ),
            draft_schema(),
            "high",
            64000,
        )
        .await?;

    if args.punch_up.unwrap_or(true) {
        progress("punch_up", "Writers' room pass");
        draft = claude
            .ask(
                &format!(
                    "{brief}\n\n---\nDraft:\n```fountain\n{}\n```\n\n\
Writers' room pass. Read each character's lines against their engine and how they talk, and rewrite any line another character could have said. Sharpen the jokes: cut the obvious one, find the specific one, land each scene's button. Pay off a callback where it's earned. Cut anything the listener can't hear and trim fat by about a tenth. Keep the structure, headings, cues and sound tags. Return the complete revised script and its canon entry.",
                    draft.fountain
                ),
                draft_schema(),
                "high",
                64000,
            )
            .await?;
    }

    progress("import", "Building the episode");
    let landed = land_episode(
        config,
        &series,
        &mut canon,
        &plan,
        &draft.fountain,
        draft.canon,
        args.episode_id.as_deref(),
        serde_json::json!({
            "premise": args.premise,
            "model": claude.model,
            "input_tokens": claude.tokens.0,
            "output_tokens": claude.tokens.1,
        }),
    )?;
    progress("done", "Episode ready");

    Ok(WriteEpisodeResult {
        project: landed.project,
        plan,
        fountain: draft.fountain,
        scenes: landed.scenes,
        sound_cues_bound: landed.sound_cues_bound,
        new_characters: landed.new_characters,
        input_tokens: claude.tokens.0,
        output_tokens: claude.tokens.1,
    })
}

pub struct Landed {
    pub project: Project,
    pub scenes: usize,
    pub sound_cues_bound: usize,
    pub new_characters: Vec<String>,
}

/// A finished script becomes an episode: create (or reuse) the project,
/// import the Fountain, describe new characters, bind `#cue` rows, keep a
/// record, and add the canon entry. Shared by the writer and by
/// `pharaoh episode import` (a script written elsewhere, e.g. by an agent).
#[allow(clippy::too_many_arguments)]
pub fn land_episode(
    config: &AppConfig,
    series: &Series,
    canon: &mut Vec<CanonEntry>,
    plan: &EpisodePlan,
    fountain: &str,
    entry: CanonDraft,
    episode_id: Option<&str>,
    record: serde_json::Value,
) -> Result<Landed> {
    let projects_dir = std::path::PathBuf::from(&config.projects_dir);
    let project = match episode_id {
        Some(eid) => {
            let p: Project = read_json(&project_dir(&projects_dir, eid).join("project.json"))?;
            if p.series_id.as_deref() != Some(series.id.as_str()) {
                return Err(Error::Other(format!("project {eid} is not an episode of {}", series.title)));
            }
            p
        }
        None => create_episode_at(&projects_dir, &series.id, Some(plan.title.clone()), Some(plan.logline.clone()))?,
    };
    let summary = crate::cli::scene_script::import_fountain(config, &project.id, fountain, "", "", "CHAR", None, false, true)?;
    let new_characters: Vec<String> = summary["characters_added"]
        .as_array()
        .map(|a| a.iter().filter_map(|c| c["name"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    let scenes = summary["scenes_added"].as_array().map(|a| a.len()).unwrap_or(0);

    let project = finish_project(&projects_dir, &project.id, series, plan)?;
    let bound = bind_sound_cues(&projects_dir, &project.id, series)?;

    let mut rec = serde_json::json!({
        "series_id": series.id,
        "plan": plan,
        "fountain": fountain,
        "written_at": Utc::now(),
    });
    if let (Some(r), Some(extra)) = (rec.as_object_mut(), record.as_object()) {
        r.extend(extra.clone());
    }
    write_json(&project_dir(&projects_dir, &project.id).join("series_episode.json"), &rec)?;

    if !entry.summary.trim().is_empty() || !entry.facts.is_empty() || !entry.gags.is_empty() || !entry.threads.is_empty() {
        canon.retain(|c| c.episode_id != project.id);
        canon.push(CanonEntry {
            episode_id: project.id.clone(),
            episode_title: project.title.clone(),
            summary: entry.summary,
            facts: entry.facts,
            gags: entry.gags,
            threads: entry.threads,
            created_at: Some(Utc::now()),
        });
        store_canon(&projects_dir, &series.id, canon)?;
    }
    Ok(Landed { project, scenes, sound_cues_bound: bound, new_characters })
}

/// Episode metadata from the plan, and descriptions for characters the
/// import created blank: series cast without a library voice, and guests.
fn finish_project(projects_dir: &Path, project_id: &str, series: &Series, plan: &EpisodePlan) -> Result<Project> {
    let path = project_dir(projects_dir, project_id).join("project.json");
    let mut p: Project = read_json(&path)?;
    if !plan.title.trim().is_empty() {
        p.title = plan.title.trim().to_string();
    }
    if !plan.logline.trim().is_empty() {
        p.logline = plan.logline.trim().to_string();
    }
    if p.synopsis.trim().is_empty() {
        p.synopsis = plan.synopsis.trim().to_string();
    }
    for c in p.characters.iter_mut() {
        let same = |n: &str| n.trim().eq_ignore_ascii_case(c.name.trim());
        if let Some(m) = series.cast.iter().find(|m| same(&m.name)) {
            if c.description.trim().is_empty() {
                c.description = m.description.trim().to_string();
            }
            if c.library_id.is_none() && c.voice_assignment.base_voice_description.trim().is_empty() {
                c.voice_assignment.base_voice_description =
                    [m.description.trim(), m.voice_notes.trim()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(". ");
            }
        } else if let Some(g) = plan.guests.iter().find(|g| same(&g.name)) {
            if c.description.trim().is_empty() {
                c.description = g.description.trim().to_string();
            }
            if c.voice_assignment.base_voice_description.trim().is_empty() {
                c.voice_assignment.base_voice_description = g.voice.trim().to_string();
            }
        }
    }
    p.updated_at = Utc::now();
    write_json(&path, &p)?;
    Ok(p)
}

/// Bind `#cue` rows to the series' approved audio. Each file is copied into
/// the scene's assets (bit-exact) so the episode stays self-contained. A tag
/// with no recording falls back to the cue's prompt for normal generation;
/// an unknown tag just loses its `#`.
pub fn bind_sound_cues(projects_dir: &Path, project_id: &str, series: &Series) -> Result<usize> {
    let storyboard: Storyboard = read_json(&project_dir(projects_dir, project_id).join("storyboard.json"))?;
    let mut bound = 0;
    for scene in &storyboard.scenes {
        let sdir = scene_dir(projects_dir, project_id, &scene.slug);
        let script = sdir.join("script.csv");
        if !script.exists() {
            continue;
        }
        let mut rows = read_script_rows(&script)?;
        let mut changed = false;
        for row in rows.iter_mut() {
            let Some(tag) = row.prompt.trim().strip_prefix('#') else { continue };
            let id: String = tag.chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
            changed = true;
            let Some(cue) = series.sounds.iter().find(|c| c.id.eq_ignore_ascii_case(&id)) else {
                row.prompt = tag.trim().to_string();
                continue;
            };
            row.prompt = if cue.prompt.trim().is_empty() { cue.label.clone() } else { cue.prompt.clone() };
            let Some(src) = cue.file.as_deref().map(Path::new).filter(|f| f.is_file()) else { continue };
            let dest = sdir.join("assets").join(format!("series_{}.wav", cue.id));
            if !dest.exists() {
                std::fs::create_dir_all(dest.parent().unwrap())?;
                std::fs::copy(src, &dest)?;
            }
            row.file = dest.to_string_lossy().to_string();
            row.notes = format!("{} series:{}", row.notes, cue.id).trim().to_string();
            bound += 1;
        }
        if changed {
            write_script_rows(&script, &rows)?;
        }
    }
    Ok(bound)
}

// ── Tauri ────────────────────────────────────────────────────────────────────

fn app_config(app: &AppHandle) -> Result<AppConfig> {
    let state = app.state::<AppState>();
    let cfg = state.app_config.read().map_err(|_| Error::Other("app_config lock poisoned".into()))?;
    Ok(cfg.clone())
}

#[tauri::command]
pub fn series_brief_text(app: AppHandle, series_id: String) -> Result<String> {
    let (_, _, brief) = load_bible(&app_projects_dir(&app)?, &series_id)?;
    Ok(brief)
}

#[tauri::command]
pub async fn pitch_episodes(app: AppHandle, series_id: String, hint: Option<String>, settings: Option<WriterSettings>) -> Result<Vec<Pitch>> {
    let dir = app_projects_dir(&app)?;
    pitch_impl(&dir, &series_id, hint.as_deref().unwrap_or(""), &settings.unwrap_or_default()).await
}

#[tauri::command]
pub async fn plan_episode(app: AppHandle, series_id: String, premise: String, settings: Option<WriterSettings>) -> Result<EpisodePlan> {
    let dir = app_projects_dir(&app)?;
    plan_impl(&dir, &series_id, &premise, &settings.unwrap_or_default()).await
}

/// Emits `episode-writer` events ({series_id, stage, message}) as it goes.
#[tauri::command]
pub async fn write_episode(app: AppHandle, args: WriteEpisodeArgs) -> Result<WriteEpisodeResult> {
    let config = app_config(&app)?;
    let series_id = args.series_id.clone();
    let emitter = app.clone();
    let progress = move |stage: &str, message: &str| {
        let _ = emitter.emit(
            "episode-writer",
            WriterProgress { series_id: series_id.clone(), stage: stage.into(), message: message.into() },
        );
    };
    write_impl(&config, args, &progress).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CastMember, SeriesSet, SoundCue};

    fn series() -> Series {
        Series {
            id: "s1".into(),
            title: "Night Shift".into(),
            episode_minutes: 8,
            cast: vec![CastMember { id: "c1".into(), name: "Dot".into(), engine: "Runs toward danger".into(), catchphrases: vec!["Called it.".into(), " ".into()], ..Default::default() }],
            sets: vec![SeriesSet { id: "court".into(), name: "Food court".into(), heading: "INT. FOOD COURT - NIGHT".into(), bed_sound: Some("hum".into()), ..Default::default() }],
            sounds: vec![
                SoundCue { id: "theme".into(), kind: "theme".into(), label: "Main title".into(), prompt: "surf rock organ".into(), ..Default::default() },
                SoundCue { id: "hum".into(), kind: "bed".into(), label: "Fluorescent hum".into(), prompt: "empty mall hum".into(), ..Default::default() },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn brief_carries_the_bible() {
        let canon = vec![CanonEntry { episode_title: "Pilot".into(), summary: "They meet the escalator.".into(), gags: vec!["Marv's thermos".into()], ..Default::default() }];
        let b = series_brief(&series(), &canon);
        assert!(b.contains("~1200 spoken words"));
        assert!(b.contains("### Dot"));
        assert!(b.contains("\"Called it.\"") && !b.contains("\" \""), "blank catchphrases are dropped");
        assert!(b.contains("bed line `BED: #hum`"));
        assert!(b.contains("`MUSIC: #theme`"));
        assert!(b.contains("Marv's thermos"));
        assert!(!b.contains("## Formula"), "no formula, no section");
    }

    #[test]
    fn schemas_are_closed() {
        fn walk(v: &serde_json::Value) {
            if v.get("type") == Some(&serde_json::json!("object")) {
                assert_eq!(v["additionalProperties"], serde_json::json!(false));
                let props: Vec<&String> = v["properties"].as_object().unwrap().keys().collect();
                let req: Vec<&str> = v["required"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
                assert!(props.iter().all(|p| req.contains(&p.as_str())));
                for p in v["properties"].as_object().unwrap().values() {
                    walk(p);
                }
            }
            if let Some(items) = v.get("items") {
                walk(items);
            }
        }
        walk(&pitch_schema());
        walk(&plan_schema());
        walk(&draft_schema());
    }

    #[test]
    fn sound_tags_bind_to_recordings_and_fall_back_to_prompts() {
        use crate::models::AppConfig;
        let dir = std::env::temp_dir().join(format!("pharaoh-writer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = series();
        crate::commands::series::tests_store(&dir, &s);
        // A recorded theme; the hum has no take yet.
        let take = dir.join("theme.wav");
        let spec = hound::WavSpec { channels: 2, sample_rate: 48000, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&take, spec).unwrap();
        for _ in 0..960 { w.write_sample(1000i32).unwrap(); }
        w.finalize().unwrap();
        s.sounds[0].file = Some(take.to_string_lossy().to_string());

        let ep = create_episode_at(&dir, &s.id, Some("Pilot".into()), None).unwrap();
        let mut config = AppConfig::with_home(&dir);
        config.projects_dir = dir.to_string_lossy().to_string();
        let fountain = "Title: Pilot\n\n# Cold Open\n\nINT. FOOD COURT - NIGHT\n\nBED: #hum\n\nMUSIC: #theme\n\nDOT\n(whisper)\nCalled it.\n\nSFX: #nope a door\n";
        crate::cli::scene_script::import_fountain(&config, &ep.id, fountain, "", "", "CHAR", None, false, true).unwrap();
        assert_eq!(bind_sound_cues(&dir, &ep.id, &s).unwrap(), 1);

        let sb: Storyboard = read_json(&project_dir(&dir, &ep.id).join("storyboard.json")).unwrap();
        assert_eq!(sb.scenes[0].act.as_deref(), Some("Cold Open"));
        let rows = read_script_rows(&scene_dir(&dir, &ep.id, &sb.scenes[0].slug).join("script.csv")).unwrap();
        let bed = rows.iter().find(|r| r.track_type == "BED").unwrap();
        assert_eq!(bed.prompt, "empty mall hum");
        assert!(bed.file.is_empty(), "no recording: generated as usual");
        let music = rows.iter().find(|r| r.track_type == "MUSIC").unwrap();
        assert!(music.file.ends_with("assets/series_theme.wav"));
        assert_eq!(std::fs::read(&music.file).unwrap(), std::fs::read(&take).unwrap(), "copied bit-exact");
        let sfx = rows.iter().find(|r| r.track_type == "SFX").unwrap();
        assert_eq!(sfx.prompt, "nope a door");

        let p = finish_project(&dir, &ep.id, &s, &EpisodePlan { title: "Pilot: The Escalator".into(), synopsis: "x".into(), ..Default::default() }).unwrap();
        assert_eq!(p.title, "Pilot: The Escalator");
        assert!(p.characters.iter().any(|c| c.name == "Dot"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
