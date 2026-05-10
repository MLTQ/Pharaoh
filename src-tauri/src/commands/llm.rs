// Anthropic LLM integration: scene drafting from project context.
//
// Reads the API key from the env var named in project.json's `llm_config.api_key_env`
// (default: ANTHROPIC_API_KEY). The key is never logged or returned to the frontend.

use serde::{Deserialize, Serialize};
use crate::error::{Error, Result};

#[derive(Debug, Deserialize)]
pub struct DraftSceneArgs {
    pub project_title: String,
    pub logline: String,
    pub synopsis: String,
    pub tone: String,
    pub characters: Vec<DraftCharacter>,
    pub scene_title: String,
    pub scene_description: String,
    pub scene_location: String,
    pub previous_fountain: Option<String>,  // existing scene fountain to revise
    pub model: Option<String>,              // override; defaults to claude-sonnet-4-6
    pub api_key_env: Option<String>,        // override; defaults to ANTHROPIC_API_KEY
}

#[derive(Debug, Deserialize)]
pub struct DraftCharacter {
    pub name: String,
    pub description: String,
    pub voice_direction: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DraftSceneResult {
    pub fountain: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_KEY_ENV: &str = "ANTHROPIC_API_KEY";

const SYSTEM_PROMPT: &str = "You are a co-writer for an audio drama. You write in Fountain format, extended for audio:\n\
- CHARACTER names ALL CAPS on their own line, dialogue beneath.\n\
- (parenthetical) for delivery notes — brief, sensory, not literal action.\n\
- SFX: line for sound effects (e.g. SFX: rain on glass, distant).\n\
- BED: line for ambient beds (e.g. BED: low room tone, cold).\n\
- MUSIC: line for score cues (e.g. MUSIC: tense underscore, sparse piano).\n\
- Plain text lines are stage directions / action.\n\
\n\
Audio drama is dialogue-driven. Avoid silent action; convert visual moments into dialogue, sound, or breath. Keep lines short and speakable. Never use lyrics or copyrighted material.\n\
\n\
Return ONLY the Fountain text — no commentary, no markdown fences, no explanation.";

pub async fn draft_scene_impl(args: DraftSceneArgs) -> Result<DraftSceneResult> {
    let model = args.model.clone().unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let key_env = args.api_key_env.clone().unwrap_or_else(|| DEFAULT_KEY_ENV.to_string());

    let api_key = std::env::var(&key_env).map_err(|_| {
        Error::Other(format!(
            "environment variable {} is not set — export your Anthropic API key first",
            key_env
        ))
    })?;
    if api_key.trim().is_empty() {
        return Err(Error::Other(format!("{} is empty", key_env)));
    }

    let user_prompt = build_user_prompt(&args);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| Error::Other(format!("http client init failed: {}", e)))?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "system": SYSTEM_PROMPT,
        "messages": [
            { "role": "user", "content": user_prompt }
        ],
    });

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("anthropic request failed: {}", e)))?;

    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| Error::Other(format!("anthropic read failed: {}", e)))?;
    if !status.is_success() {
        let body_str = String::from_utf8_lossy(&bytes);
        return Err(Error::Other(format!(
            "anthropic returned {}: {}",
            status,
            body_str.chars().take(500).collect::<String>()
        )));
    }

    #[derive(Deserialize)]
    struct ContentBlock { #[serde(rename = "type")] kind: String, text: Option<String> }
    #[derive(Deserialize)]
    struct Usage { input_tokens: u64, output_tokens: u64 }
    #[derive(Deserialize)]
    struct AnthropicResponse {
        content: Vec<ContentBlock>,
        usage: Usage,
        model: String,
    }

    let parsed: AnthropicResponse = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Other(format!("anthropic parse failed: {}", e)))?;

    let fountain = parsed.content.iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if fountain.is_empty() {
        return Err(Error::Other("anthropic returned no text content".into()));
    }

    Ok(DraftSceneResult {
        fountain,
        model: parsed.model,
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
    })
}

fn build_user_prompt(a: &DraftSceneArgs) -> String {
    let mut s = String::new();
    s.push_str(&format!("PROJECT: {}\n", a.project_title));
    if !a.logline.is_empty()  { s.push_str(&format!("LOGLINE: {}\n", a.logline)); }
    if !a.synopsis.is_empty() { s.push_str(&format!("SYNOPSIS: {}\n", a.synopsis)); }
    if !a.tone.is_empty()     { s.push_str(&format!("TONE: {}\n", a.tone)); }

    if !a.characters.is_empty() {
        s.push_str("\nCAST:\n");
        for c in &a.characters {
            s.push_str(&format!("- {}: {}", c.name, c.description));
            if let Some(v) = &c.voice_direction { if !v.is_empty() { s.push_str(&format!(" [voice: {}]", v)); } }
            s.push('\n');
        }
    }

    s.push_str(&format!("\nSCENE: {}\n", a.scene_title));
    if !a.scene_location.is_empty()    { s.push_str(&format!("LOCATION: {}\n", a.scene_location)); }
    if !a.scene_description.is_empty() { s.push_str(&format!("DESCRIPTION: {}\n", a.scene_description)); }

    if let Some(prev) = &a.previous_fountain {
        if !prev.trim().is_empty() {
            s.push_str("\nEXISTING DRAFT (revise rather than starting from scratch):\n");
            s.push_str("---\n");
            s.push_str(prev);
            s.push_str("\n---\n");
        }
    }

    s.push_str("\nDraft this scene as Fountain. Aim for 6–14 dialogue exchanges. Layer sound and music sparingly to support the emotional beats — never wall-to-wall. Open and close with intent.");
    s
}

// ── Storyboard continuity review ───────────────────────────────────────────
//
// Architecture spec calls this a "Chekhov's Gun pass": re-read every scene's
// script and surface dropped narrative threads (setups without payoffs),
// characters who arrive and vanish without arc, factual inconsistencies
// between scenes, and missing connective tissue. The model returns markdown
// the user reads — structured tool-use is overkill for a manual review pass.

#[derive(Debug, Deserialize)]
pub struct StoryboardReviewArgs {
    pub project_title: String,
    pub logline: String,
    pub synopsis: String,
    pub tone: String,
    pub characters: Vec<DraftCharacter>,
    pub scenes: Vec<SceneSummary>,
    pub model: Option<String>,
    pub api_key_env: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SceneSummary {
    pub slug: String,
    pub no: String,           // e.g. "S03"
    pub title: String,
    pub description: String,
    pub location: String,
    /// Compiled scene prose — usually the dialogue + cue prompts joined.
    /// Caller assembles this from script.csv (or the .fountain file).
    pub prose: String,
}

#[derive(Debug, Serialize)]
pub struct StoryboardReviewResult {
    /// Markdown review with sections for dropped threads, missing payoffs,
    /// inconsistencies, character arcs, and pacing notes.
    pub review: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

const REVIEW_SYSTEM_PROMPT: &str = "You are a continuity editor for an audio drama. The writer has handed you the full script across scenes and wants a brutally specific continuity review.\n\
\n\
Identify, in order of severity:\n\
1. **Dropped threads** — Chekhov's guns introduced and never paid off, hooks that go nowhere, props or facts mentioned once and forgotten. Cite the scene number where each was introduced.\n\
2. **Missing payoffs** — character arcs that don't resolve, emotional beats that don't land, questions that never get answered.\n\
3. **Inconsistencies** — facts, timing, character knowledge, or relationships that contradict between scenes.\n\
4. **Character arc gaps** — characters who appear briefly without enough scenes to register, or who change radically without on-screen reason.\n\
5. **Pacing & coverage** — scenes that feel redundant, transitions that need bridging, or moments that need to breathe.\n\
\n\
Output strict markdown with these section headings: ## Dropped threads, ## Missing payoffs, ## Inconsistencies, ## Character arcs, ## Pacing notes. Under each, use bullet points. For each finding cite the scene number(s) involved. If a section has nothing to flag, write \"None — looks tight.\" Be specific — \"Mira mentions her brother in S01, never referenced again\" is useful; \"could be more developed\" is not. No preamble, no closing summary.";

pub async fn storyboard_review_impl(args: StoryboardReviewArgs) -> Result<StoryboardReviewResult> {
    let model = args.model.clone().unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let key_env = args.api_key_env.clone().unwrap_or_else(|| DEFAULT_KEY_ENV.to_string());

    let api_key = std::env::var(&key_env).map_err(|_| {
        Error::Other(format!(
            "environment variable {} is not set — export your Anthropic API key first",
            key_env
        ))
    })?;
    if api_key.trim().is_empty() {
        return Err(Error::Other(format!("{} is empty", key_env)));
    }

    let user_prompt = build_review_prompt(&args);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| Error::Other(format!("http client init failed: {}", e)))?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "system": REVIEW_SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user_prompt }],
    });

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("anthropic request failed: {}", e)))?;

    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| Error::Other(format!("anthropic read failed: {}", e)))?;
    if !status.is_success() {
        let body_str = String::from_utf8_lossy(&bytes);
        return Err(Error::Other(format!(
            "anthropic returned {}: {}",
            status,
            body_str.chars().take(500).collect::<String>()
        )));
    }

    #[derive(Deserialize)]
    struct ContentBlock { #[serde(rename = "type")] kind: String, text: Option<String> }
    #[derive(Deserialize)]
    struct Usage { input_tokens: u64, output_tokens: u64 }
    #[derive(Deserialize)]
    struct AnthropicResponse {
        content: Vec<ContentBlock>,
        usage: Usage,
        model: String,
    }

    let parsed: AnthropicResponse = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Other(format!("anthropic parse failed: {}", e)))?;

    let review = parsed.content.iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if review.is_empty() {
        return Err(Error::Other("anthropic returned no review text".into()));
    }

    Ok(StoryboardReviewResult {
        review,
        model: parsed.model,
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
    })
}

fn build_review_prompt(a: &StoryboardReviewArgs) -> String {
    let mut s = String::new();
    s.push_str(&format!("PROJECT: {}\n", a.project_title));
    if !a.logline.is_empty()  { s.push_str(&format!("LOGLINE: {}\n", a.logline)); }
    if !a.synopsis.is_empty() { s.push_str(&format!("SYNOPSIS: {}\n", a.synopsis)); }
    if !a.tone.is_empty()     { s.push_str(&format!("TONE: {}\n", a.tone)); }

    if !a.characters.is_empty() {
        s.push_str("\nCAST:\n");
        for c in &a.characters {
            s.push_str(&format!("- {}: {}", c.name, c.description));
            if let Some(v) = &c.voice_direction { if !v.is_empty() { s.push_str(&format!(" [voice: {}]", v)); } }
            s.push('\n');
        }
    }

    s.push_str("\nFULL SCRIPT (every scene in order):\n");
    for sc in &a.scenes {
        s.push_str(&format!("\n=== {} · {} ===\n", sc.no, sc.title));
        if !sc.location.is_empty() { s.push_str(&format!("LOCATION: {}\n", sc.location)); }
        if !sc.description.is_empty() { s.push_str(&format!("DESCRIPTION: {}\n", sc.description)); }
        s.push_str("\n");
        s.push_str(&sc.prose);
        s.push_str("\n");
    }

    s.push_str("\nReview the full script for continuity. Use the section headings exactly as specified. Be specific and cite scene numbers.");
    s
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn draft_scene(args: DraftSceneArgs) -> Result<DraftSceneResult> {
    draft_scene_impl(args).await
}

#[tauri::command]
pub async fn storyboard_review(args: StoryboardReviewArgs) -> Result<StoryboardReviewResult> {
    storyboard_review_impl(args).await
}
