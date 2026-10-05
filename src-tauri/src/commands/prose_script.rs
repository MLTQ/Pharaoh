//! Prose → script: the Claude-backed plan for `prose::assemble`, and the
//! Tauri commands behind "Script from prose".
//!
//! Claude never writes the script text. It reads numbered segments (from
//! `prose::parse`) and answers, as structured JSON, who speaks each quote and
//! how, where scenes start, and which effects, beds and music to add. The
//! words of the chapter go through untouched; `prose::assemble` writes the
//! Fountain. Without an API key (or with `heuristic`), the plan comes from
//! dialogue tags and turn-taking instead.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::prose::{self, AssembleOptions, AssembleStats, CastMember, LineAttr, Plan, Source};

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const DEFAULT_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// Characters of prose per request. Keeps each answer well inside max_tokens.
const CHUNK_CHARS: usize = 24_000;
/// Already-attributed segments shown before each chunk, for continuity.
const CONTEXT_SEGMENTS: usize = 14;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProseToScriptArgs {
    pub text: String,
    /// Cast names to attribute to (a project's characters). New speakers may
    /// still appear when Claude finds someone not in the list.
    #[serde(default)]
    pub cast: Vec<CastHint>,
    #[serde(default)]
    pub narrator: Option<String>,
    /// Name each voice after its first line in a scene (default on).
    #[serde(default)]
    pub intros: Option<bool>,
    /// Skip Claude; attribute from dialogue tags and turn-taking.
    #[serde(default)]
    pub heuristic: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CastHint {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProseToScriptResult {
    pub fountain: String,
    pub stats: AssembleStats,
    /// "claude" or "heuristic".
    pub mode: String,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Speakers that aren't in the cast; importing creates them.
    pub new_characters: Vec<String>,
    /// Why Claude wasn't used, when it was asked for but unavailable.
    pub note: Option<String>,
}

/// Convert prose to Fountain. Uses Claude when a key is set (and `heuristic`
/// is off); otherwise, or if no key is found, the heuristic plan.
pub async fn prose_to_script_impl(args: ProseToScriptArgs) -> Result<ProseToScriptResult> {
    let narrator = args.narrator.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Narrator".into());
    let src = prose::parse(&args.text);
    if src.segments.is_empty() {
        return Err(Error::Other("no prose found in the text".into()));
    }
    let mut names: Vec<String> = args.cast.iter().map(|c| c.name.clone()).collect();
    if !names.iter().any(|n| n.eq_ignore_ascii_case(&narrator)) {
        names.insert(0, narrator.clone());
    }
    // Speakers the dialogue tags name that the cast doesn't have yet.
    let found = prose::discover_names(&src, &prose::cast_from_names(&names, &args.text));
    names.extend(found);
    let cast = prose::cast_from_names(&names, &args.text);
    let mut plan = prose::heuristic_plan(&src, &cast, &narrator);

    let key_env = args.api_key_env.clone().unwrap_or_else(|| DEFAULT_KEY_ENV.to_string());
    let key = std::env::var(&key_env).ok().filter(|k| !k.trim().is_empty());
    let (mut mode, mut model, mut tokens, mut note) = ("heuristic".to_string(), None, (0, 0), None);
    if !args.heuristic {
        match key {
            Some(key) => {
                let m = args.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_MODEL.into());
                let (claude, t) = claude_plan(&src, &args.cast, &narrator, &cast, &plan, &m, &key).await?;
                plan = merge(plan, claude, &cast);
                mode = "claude".into();
                model = Some(m);
                tokens = t;
            }
            None => note = Some(format!("{} is not set, so speakers come from dialogue tags and turn-taking", key_env)),
        }
    }

    let opts = AssembleOptions { narrator: narrator.clone(), intros: args.intros.unwrap_or(true), ..Default::default() };
    let (fountain, stats) = prose::assemble(&src, &plan, &cast, &opts);
    let known: Vec<String> = args.cast.iter().map(|c| c.name.to_lowercase()).chain([narrator.to_lowercase()]).collect();
    let new_characters = stats.speakers.iter().filter(|s| !known.contains(&s.to_lowercase())).cloned().collect();
    Ok(ProseToScriptResult { fountain, stats, mode, model, input_tokens: tokens.0, output_tokens: tokens.1, new_characters, note })
}

/// Claude's lines replace the heuristic ones they cover; its cues and scenes
/// are used as given. Speaker names are snapped to the cast's spelling.
fn merge(base: Plan, claude: Plan, cast: &[CastMember]) -> Plan {
    let snap = |name: &str| -> String {
        let n = name.trim();
        let lower = n.to_lowercase();
        cast.iter()
            .find(|m| m.name.to_lowercase() == lower)
            .or_else(|| cast.iter().find(|m| m.aliases.contains(&lower)))
            .map(|m| m.name.clone())
            .unwrap_or_else(|| n.to_string())
    };
    let mut by_id: HashMap<usize, LineAttr> = base.lines.into_iter().map(|l| (l.id, l)).collect();
    for l in claude.lines {
        if let Some(slot) = by_id.get_mut(&l.id) {
            *slot = LineAttr { speaker: snap(&l.speaker), ..l };
        }
    }
    let mut lines: Vec<LineAttr> = by_id.into_values().collect();
    lines.sort_by_key(|l| l.id);
    Plan {
        lines,
        cues: claude.cues,
        scenes: if claude.scenes.is_empty() { base.scenes } else { claude.scenes },
    }
}

// ── Claude ───────────────────────────────────────────────────────────────────

const SYSTEM: &str = "You adapt prose fiction into a plan for a full-cast audio drama. \
The prose has been split into numbered segments: N = narration (read by the narrator), Q = quoted speech. \
You do not rewrite any text. You decide:\n\
1. lines — for EVERY Q segment in the chunk: who speaks it (use the cast name exactly as listed; \
if the speaker isn't in the cast, give their name as the prose calls them, or a short description such as \"Shopkeeper\"), \
the narrator's verb for it (said, asked, whispered, muttered, called, snapped…, matching the prose's own tag when there is one), \
and a short delivery direction for the voice actor (emotion, volume, pace — a few words, or empty for plain delivery). \
Read carefully: tags can come before, after or in the middle of a line, a quote can be interrupted by narration, \
untagged lines in a two-person exchange alternate, and action beats (\"Ron grinned.\") identify the speaker.\n\
2. scenes — the segment where each new scene starts (a change of place or a jump in time), with a Fountain heading \
like \"INT. MADAM MALKIN'S ROBES - DAY\" or \"EXT. HOGWARTS LAKE - NIGHT\". Include the first scene of the chunk only if \
it starts a new scene (the first chunk's first segment always does).\n\
3. cues — sound to add after a segment: BED for a scene's ambience (start one at each new scene: room tone, weather, crowd), \
SFX for distinct sounds the prose describes (a door, footsteps, an owl, a spell), MUSIC sparingly for transitions and big moments. \
Write each prompt as a concrete description of the sound for a sound-effects model (\"heavy oak door creaks open, stone hall\"). \
Never name copyrighted music or ask for lyrics. Don't overdo it: a cue where a listener would miss the sound.";

fn plan_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["lines", "scenes", "cues"],
        "properties": {
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "speaker", "verb", "delivery"],
                    "properties": {
                        "id": { "type": "integer" },
                        "speaker": { "type": "string" },
                        "verb": { "type": "string" },
                        "delivery": { "type": "string" }
                    }
                }
            },
            "scenes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["at", "heading"],
                    "properties": {
                        "at": { "type": "integer" },
                        "heading": { "type": "string" }
                    }
                }
            },
            "cues": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["after", "kind", "prompt"],
                    "properties": {
                        "after": { "type": "integer" },
                        "kind": { "type": "string", "enum": ["SFX", "BED", "MUSIC"] },
                        "prompt": { "type": "string" }
                    }
                }
            }
        }
    })
}

/// Segment ranges of about `CHUNK_CHARS`, never splitting a paragraph.
fn chunks(src: &Source) -> Vec<std::ops::Range<usize>> {
    let segs = &src.segments;
    let mut out = Vec::new();
    let (mut start, mut size) = (0, 0);
    for (i, s) in segs.iter().enumerate() {
        let para_start = i == 0 || segs[i - 1].para != s.para;
        if para_start && size >= CHUNK_CHARS && i > start {
            out.push(start..i);
            start = i;
            size = 0;
        }
        size += s.text.len() + 8;
    }
    if start < segs.len() {
        out.push(start..segs.len());
    }
    out
}

fn segment_line(s: &prose::Segment, speaker: Option<&str>) -> String {
    match (s.quote, speaker) {
        (true, Some(who)) => format!("[{}] Q ({}): {}", s.id, who, s.text),
        (true, None) => format!("[{}] Q: {}", s.id, s.text),
        (false, _) => format!("[{}] N: {}", s.id, s.text),
    }
}

async fn claude_plan(
    src: &Source,
    hints: &[CastHint],
    narrator: &str,
    cast: &[CastMember],
    heuristic: &Plan,
    model: &str,
    key: &str,
) -> Result<(Plan, (u64, u64))> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| Error::Other(format!("http client init failed: {}", e)))?;
    let cast_list = cast
        .iter()
        .filter(|m| m.name != narrator)
        .map(|m| {
            let desc = hints.iter().find(|h| h.name == m.name).map(|h| h.description.trim()).filter(|d| !d.is_empty());
            match desc {
                Some(d) => format!("- {} — {}", m.name, d.chars().take(160).collect::<String>()),
                None => format!("- {}", m.name),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut plan = Plan::default();
    let mut tokens = (0u64, 0u64);
    let ranges = chunks(src);
    for (ci, range) in ranges.iter().enumerate() {
        // Earlier segments, with the speakers decided so far, for continuity.
        let decided: HashMap<usize, &str> = plan.lines.iter().map(|l| (l.id, l.speaker.as_str())).collect();
        let context = src.segments[range.start.saturating_sub(CONTEXT_SEGMENTS)..range.start]
            .iter()
            .map(|s| segment_line(s, decided.get(&s.id).copied()))
            .collect::<Vec<_>>()
            .join("\n");
        let body_text = src.segments[range.clone()].iter().map(|s| segment_line(s, None)).collect::<Vec<_>>().join("\n");
        let quotes = src.segments[range.clone()].iter().filter(|s| s.quote).count();
        let prompt = format!(
            "Title: {}\nNarrator: {}\nCast:\n{}\n\n{}Chunk {} of {} ({} Q segments to attribute):\n{}",
            src.title.as_deref().unwrap_or("(untitled)"),
            narrator,
            if cast_list.is_empty() { "(none yet)".into() } else { cast_list.clone() },
            if context.is_empty() { String::new() } else { format!("Already attributed, for context only:\n{}\n\n", context) },
            ci + 1,
            ranges.len(),
            quotes,
            body_text,
        );
        let (mut part, t) = request_plan(&client, model, key, &prompt).await?;
        tokens.0 += t.0;
        tokens.1 += t.1;
        // Keep only answers about this chunk's segments.
        part.lines.retain(|l| range.contains(&l.id) && src.segments[l.id].quote);
        part.cues.retain(|c| range.contains(&c.after));
        part.scenes.retain(|s| range.contains(&s.at));
        plan.lines.extend(part.lines);
        plan.cues.extend(part.cues);
        plan.scenes.extend(part.scenes);
    }
    // Quotes Claude skipped keep the heuristic guess (merge does that); make
    // sure the script starts with a scene.
    if !plan.scenes.iter().any(|s| s.at == 0) {
        if let Some(first) = heuristic.scenes.iter().find(|s| s.at == 0) {
            plan.scenes.insert(0, first.clone());
        }
    }
    Ok((plan, tokens))
}

async fn request_plan(client: &reqwest::Client, model: &str, key: &str, prompt: &str) -> Result<(Plan, (u64, u64))> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 16000,
        "system": SYSTEM,
        "thinking": { "type": "adaptive" },
        "output_config": {
            "effort": "high",
            "format": { "type": "json_schema", "schema": plan_schema() }
        },
        "fallbacks": "default",
        "messages": [{ "role": "user", "content": prompt }],
    });
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("anthropic request failed: {}", e)))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| Error::Other(format!("anthropic read failed: {}", e)))?;
    if !status.is_success() {
        let msg = String::from_utf8_lossy(&bytes).chars().take(500).collect::<String>();
        return Err(Error::Other(format!("anthropic returned {}: {}", status, msg)));
    }

    #[derive(Deserialize)]
    struct Block {
        #[serde(rename = "type")]
        kind: String,
        text: Option<String>,
    }
    #[derive(Deserialize)]
    struct Usage {
        input_tokens: u64,
        output_tokens: u64,
    }
    #[derive(Deserialize)]
    struct Response {
        content: Vec<Block>,
        stop_reason: Option<String>,
        usage: Usage,
    }
    let r: Response = serde_json::from_slice(&bytes).map_err(|e| Error::Other(format!("anthropic parse failed: {}", e)))?;
    match r.stop_reason.as_deref() {
        Some("refusal") => return Err(Error::Other("Claude declined to plan this text".into())),
        Some("max_tokens") => return Err(Error::Other("Claude's plan was cut off (max_tokens); try a shorter chapter".into())),
        _ => {}
    }
    let text: String = r.content.iter().filter(|b| b.kind == "text").filter_map(|b| b.text.as_deref()).collect();
    let plan: Plan = serde_json::from_str(text.trim()).map_err(|e| Error::Other(format!("Claude's plan wasn't valid JSON: {}", e)))?;
    Ok((plan, (r.usage.input_tokens, r.usage.output_tokens)))
}

// ── Tauri ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn prose_to_script(args: ProseToScriptArgs) -> Result<ProseToScriptResult> {
    prose_to_script_impl(args).await
}

/// Add a Fountain script's scenes (and any new speakers) to a project —
/// what `pharaoh script import` does.
#[tauri::command]
pub fn import_script_text(app: AppHandle, project_id: String, fountain: String, dry_run: Option<bool>) -> Result<serde_json::Value> {
    let config = {
        let state = app.state::<crate::models::AppState>();
        let cfg = state.app_config.read().map_err(|_| Error::Other("app_config lock poisoned".into()))?;
        cfg.clone()
    };
    crate::cli::scene_script::import_fountain(&config, &project_id, &fountain, "", "", "CHAR", None, dry_run.unwrap_or(false), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_lines_override_and_snap_to_cast_names() {
        let cast = prose::cast_from_names(&["Narrator".into(), "Harry Potter (GOF)".into()], "Harry");
        let base = Plan { lines: vec![LineAttr { id: 0, speaker: "UNKNOWN".into(), ..Default::default() }, LineAttr { id: 2, speaker: "Harry Potter (GOF)".into(), ..Default::default() }], ..Default::default() };
        let claude = Plan { lines: vec![LineAttr { id: 0, speaker: "harry".into(), verb: "muttered".into(), delivery: "low".into() }, LineAttr { id: 9, speaker: "Ghost".into(), ..Default::default() }], ..Default::default() };
        let m = merge(base, claude, &cast);
        assert_eq!(m.lines.len(), 2, "answers about unknown segments are dropped");
        assert_eq!(m.lines[0].speaker, "Harry Potter (GOF)");
        assert_eq!(m.lines[0].verb, "muttered");
        assert_eq!(m.lines[1].speaker, "Harry Potter (GOF)", "lines Claude skipped keep the heuristic");
    }

    #[test]
    fn chunks_cover_everything_without_splitting_paragraphs() {
        let para = "\"Line,\" she said. Then a long stretch of narration follows here. ".repeat(40);
        let text = (0..30).map(|_| para.clone()).collect::<Vec<_>>().join("\n\n");
        let src = prose::parse(&text);
        let cs = chunks(&src);
        assert!(cs.len() > 1);
        assert_eq!(cs.first().unwrap().start, 0);
        assert_eq!(cs.last().unwrap().end, src.segments.len());
        for w in cs.windows(2) {
            assert_eq!(w[0].end, w[1].start);
            assert_ne!(src.segments[w[1].start - 1].para, src.segments[w[1].start].para);
        }
    }

    #[test]
    fn schema_objects_are_closed() {
        fn walk(v: &serde_json::Value) {
            if v.get("type") == Some(&serde_json::json!("object")) {
                assert_eq!(v["additionalProperties"], serde_json::json!(false));
                let props: Vec<&String> = v["properties"].as_object().unwrap().keys().collect();
                let req: Vec<&str> = v["required"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
                assert!(props.iter().all(|p| req.contains(&p.as_str())));
            }
            if let Some(o) = v.as_object() {
                o.values().for_each(walk);
            }
        }
        walk(&plan_schema());
    }
}
