// Rust Fountain parser, scoped for one-shot CLI import. Mirrors the semantics
// of `src/lib/fountain.ts` but adds **scene-aware** splitting: scene headings
// become document boundaries, and each parsed scene carries the blocks that
// fall under it.
//
// The browser-side parser stays canonical for the editor (round-trip with
// stable IDs); this Rust parser is intentionally simpler — import is always
// a fresh-write operation.

use crate::models::ScriptRow;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub enum BlockType {
    Dialogue,
    Sfx,
    Bed,
    Music,
    Direction,
}

impl BlockType {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockType::Dialogue => "DIALOGUE",
            BlockType::Sfx => "SFX",
            BlockType::Bed => "BED",
            BlockType::Music => "MUSIC",
            BlockType::Direction => "DIRECTION",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Block {
    pub id: String,
    pub block_type: BlockType,
    pub character: String,     // empty for non-DIALOGUE
    pub text: String,
    pub parenthetical: String, // delivery note for DIALOGUE
}

#[derive(Debug, Clone)]
pub struct ParsedScene {
    pub heading: String,       // e.g. "INT. APARTMENT - NIGHT" — empty if unheaded
    pub title: String,         // derived from heading (after location/time-of-day strip)
    pub location: String,      // derived
    pub blocks: Vec<Block>,
    /// The Fountain section (`# Act One`) this scene falls under, if any.
    pub act: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedDocument {
    pub title: Option<String>,
    pub author: Option<String>,
    pub scenes: Vec<ParsedScene>,
    pub characters: Vec<String>,  // unique character names across the document, in first-appearance order
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn make_id() -> String {
    let s = Uuid::new_v4().simple().to_string();
    format!("r-{}", &s[..6])
}

fn is_scene_heading(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("INT.")
        || t.starts_with("EXT.")
        || t.starts_with("EST.")
        || t.starts_with("INT/EXT.")
        || t.starts_with("I/E.")
        || (t.starts_with('.') && t.chars().nth(1).map_or(false, |c| c.is_ascii_uppercase()))
}

fn match_cue(line: &str) -> Option<(BlockType, String)> {
    let t = line.trim();
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("sfx:") {
        return Some((BlockType::Sfx, t[t.len() - rest.len()..].trim().to_string()));
    }
    if let Some(rest) = lower.strip_prefix("bed:") {
        return Some((BlockType::Bed, t[t.len() - rest.len()..].trim().to_string()));
    }
    if let Some(rest) = lower.strip_prefix("music:") {
        return Some((BlockType::Music, t[t.len() - rest.len()..].trim().to_string()));
    }
    if let Some(rest) = lower.strip_prefix("fx:") {
        return Some((BlockType::Sfx, t[t.len() - rest.len()..].trim().to_string()));
    }
    None
}

/// All-caps character cue. Allows optional (V.O.), (O.S.), (CONT'D) suffix.
fn is_character_cue(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || is_scene_heading(t) || match_cue(t).is_some() {
        return false;
    }
    let before_paren = t.split('(').next().unwrap_or("").trim();
    if before_paren.is_empty() {
        return false;
    }
    if !before_paren.chars().any(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    if before_paren.chars().any(|c| c.is_ascii_lowercase()) {
        return false;
    }
    if t.len() > 60 {
        return false;
    }
    // Must be uppercase letters + spaces + apostrophes + dots + hyphens
    before_paren.chars().all(|c| {
        c.is_ascii_uppercase() || c.is_ascii_digit() || c == ' ' || c == '\'' || c == '.' || c == '-'
    })
}

fn extract_character(line: &str) -> String {
    let t = line.trim();
    let before_paren = t.split('(').next().unwrap_or(t).trim();
    before_paren.to_string()
}

fn is_parenthetical(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('(') && t.ends_with(')')
}

// ── Title page ─────────────────────────────────────────────────────────────
//
// A Fountain title page is the optional block at the start with `Key: value`
// lines. We harvest title/author and skip the rest. Title page ends at the
// first blank line followed by content.

/// Fountain's title-page keys. Only these open a title page — a scene that
/// starts with a cue ("BED: wind…", "SFX: a bell") is not one.
fn is_title_key(line: &str) -> bool {
    const KEYS: [&str; 12] = [
        "title", "credit", "author", "authors", "source", "draft date", "date", "contact", "copyright",
        "notes", "revision", "episode",
    ];
    line.split_once(':')
        .map(|(k, _)| KEYS.contains(&k.trim().to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn parse_title_page<'a>(lines: &'a [&str]) -> (Option<String>, Option<String>, usize) {
    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut i = 0;
    let has_title_page = lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .is_some_and(|l| is_title_key(l.trim()));
    if !has_title_page {
        return (None, None, 0);
    }
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        if t.is_empty() {
            i += 1;
            // Title page block ends at first empty line where the next non-empty
            // line is not also a title-page key.
            let next_nonempty = lines
                .iter()
                .skip(i)
                .find(|l| !l.trim().is_empty())
                .map(|s| s.trim());
            let still_title_page = next_nonempty.map(is_title_key).unwrap_or(false);
            if !still_title_page {
                break;
            }
            continue;
        }
        if let Some((key, val)) = t.split_once(':') {
            let key_l = key.trim().to_ascii_lowercase();
            let val = val.trim().to_string();
            if key_l == "title" {
                title = Some(val);
            } else if key_l == "author" || key_l == "credit" || key_l == "authors" {
                if author.is_none() {
                    author = Some(val);
                }
            }
        }
        i += 1;
    }
    (title, author, i)
}

// ── Main parse ─────────────────────────────────────────────────────────────

/// Name → id lookup for cues. Fountain reads "PERCEY WEASLEY (GOF)" as the
/// cue "PERCEY WEASLEY" plus an extension, so a name ending in a parenthetical
/// is also keyed without it; exact names win.
pub fn cue_lookup<'a>(cast: impl Iterator<Item = (&'a str, &'a str)>) -> std::collections::HashMap<String, String> {
    let cast: Vec<_> = cast.collect();
    let mut map = std::collections::HashMap::new();
    for (name, id) in &cast {
        map.insert(name.trim().to_ascii_uppercase(), id.to_string());
    }
    for (name, id) in &cast {
        let bare = name.split('(').next().unwrap_or(name).trim().to_ascii_uppercase();
        map.entry(bare).or_insert_with(|| id.to_string());
    }
    map
}

/// `# Act One` → "Act One". Fountain sections are one or more `#` then text.
fn section_name(line: &str) -> Option<String> {
    let rest = line.strip_prefix('#')?.trim_start_matches('#').trim();
    (!rest.is_empty()).then(|| rest.to_string())
}

pub fn parse_document(text: &str) -> ParsedDocument {
    let lines: Vec<&str> = text.split('\n').collect();
    let (title, author, mut i) = parse_title_page(&lines);

    let mut scenes: Vec<ParsedScene> = Vec::new();
    let mut current = ParsedScene {
        heading: String::new(),
        title: String::new(),
        location: String::new(),
        blocks: Vec::new(),
        act: None,
    };
    let mut character_set: Vec<String> = Vec::new();
    // The latest section heading; scenes after it belong to that act.
    let mut act: Option<String> = None;

    while i < lines.len() {
        let raw = lines[i];
        let trimmed = raw.trim();

        // Blank line — just advance
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Section heading (`# Act One`, `## Part 2`): names the act for the
        // scenes that follow. Not spoken, not a direction.
        if let Some(name) = section_name(trimmed) {
            act = Some(name);
            if current.heading.is_empty() && current.blocks.is_empty() {
                current.act = act.clone();
            }
            i += 1;
            continue;
        }

        // Scene heading: close current and start new
        if is_scene_heading(trimmed) {
            if !current.blocks.is_empty() || !current.heading.is_empty() {
                scenes.push(current);
            }
            let (title_part, location_part) = derive_scene_meta(trimmed);
            current = ParsedScene {
                heading: trimmed.to_string(),
                title: title_part,
                location: location_part,
                blocks: Vec::new(),
                act: act.clone(),
            };
            i += 1;
            continue;
        }

        // SFX/BED/MUSIC cue
        if let Some((block_type, cue_text)) = match_cue(trimmed) {
            current.blocks.push(Block {
                id: make_id(),
                block_type,
                character: String::new(),
                text: cue_text,
                parenthetical: String::new(),
            });
            i += 1;
            continue;
        }

        // Character cue
        if is_character_cue(trimmed) {
            let character = extract_character(trimmed);
            // Track unique character names in first-appearance order
            if !character_set.iter().any(|c| c.eq_ignore_ascii_case(&character)) {
                character_set.push(character.clone());
            }
            i += 1;
            let mut dialogue_text = String::new();
            let mut parenthetical = String::new();
            while i < lines.len() {
                let next = lines[i].trim();
                if next.is_empty() {
                    break;
                }
                if is_character_cue(next) || match_cue(next).is_some() || is_scene_heading(next) {
                    break;
                }
                if is_parenthetical(next) {
                    let inner = &next[1..next.len() - 1];
                    if parenthetical.is_empty() {
                        parenthetical = inner.to_string();
                    } else {
                        parenthetical.push_str("; ");
                        parenthetical.push_str(inner);
                    }
                } else {
                    if dialogue_text.is_empty() {
                        dialogue_text = next.to_string();
                    } else {
                        dialogue_text.push(' ');
                        dialogue_text.push_str(next);
                    }
                }
                i += 1;
            }
            current.blocks.push(Block {
                id: make_id(),
                block_type: BlockType::Dialogue,
                character,
                text: dialogue_text,
                parenthetical,
            });
            continue;
        }

        // Fallthrough: action / direction
        current.blocks.push(Block {
            id: make_id(),
            block_type: BlockType::Direction,
            character: String::new(),
            text: trimmed.to_string(),
            parenthetical: String::new(),
        });
        i += 1;
    }

    if !current.blocks.is_empty() || !current.heading.is_empty() {
        scenes.push(current);
    }

    // If the document had no scene headings at all, wrap blocks in one default scene
    if scenes.is_empty() {
        // No scenes detected and no blocks; nothing to do
    }

    ParsedDocument {
        title,
        author,
        scenes,
        characters: character_set,
    }
}

/// Derive a clean scene title and location from a heading like
/// `INT. MIRA'S APARTMENT - NIGHT` → ("Mira's Apartment", "interior, night, mira's apartment")
fn derive_scene_meta(heading: &str) -> (String, String) {
    let t = heading.trim();
    // Strip prefix
    let mut body = t;
    for p in ["INT/EXT.", "I/E.", "INT.", "EXT.", "EST."] {
        if let Some(rest) = body.strip_prefix(p) {
            body = rest.trim_start();
            break;
        }
    }
    // Title-case the body, take everything before " - " (or "-") as the location
    let (loc_part, time_part) = match body.rfind(" - ") {
        Some(idx) => (&body[..idx], &body[idx + 3..]),
        None => (body, ""),
    };
    let title = title_case(loc_part);
    let interior_or_exterior = if t.starts_with("INT") { "interior" } else if t.starts_with("EXT") { "exterior" } else { "establishing" };
    let mut location = String::new();
    location.push_str(interior_or_exterior);
    if !time_part.is_empty() {
        location.push_str(", ");
        location.push_str(&time_part.to_lowercase());
    }
    if !loc_part.is_empty() {
        location.push_str(", ");
        location.push_str(&loc_part.to_lowercase());
    }
    (title, location)
}

fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(c) => c.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Block → ScriptRow compilation ──────────────────────────────────────────

/// Build script rows for one scene.
///
/// `scene_no` is the human-facing scene number (e.g. "S03").
/// `character_id_for_name(name)` returns the project-side character ID for
/// a Fountain CHARACTER cue (case-insensitive); if `None`, the cue text is
/// used verbatim — caller can post-process before writing.
pub fn blocks_to_rows(
    blocks: &[Block],
    scene_no: &str,
    character_id_for_name: impl Fn(&str) -> Option<String>,
) -> Vec<ScriptRow> {
    blocks
        .iter()
        .map(|b| {
            let track = match b.block_type {
                BlockType::Dialogue => character_id_for_name(&b.character)
                    .unwrap_or_else(|| b.character.clone())
                    .to_lowercase()
                    .replace(' ', "_"),
                BlockType::Sfx | BlockType::Bed => "FOLEY".to_string(),
                BlockType::Music => "MUSIC".to_string(),
                BlockType::Direction => "NARR".to_string(),
            };
            let character = match b.block_type {
                BlockType::Dialogue => character_id_for_name(&b.character)
                    .unwrap_or_else(|| b.character.clone()),
                _ => String::new(),
            };
            ScriptRow {
                scene: scene_no.to_string(),
                track,
                track_type: b.block_type.as_str().to_string(),
                character,
                prompt: b.text.clone(),
                file: String::new(),
                start_ms: String::new(),
                duration_ms: String::new(),
                r#loop: if b.block_type == BlockType::Bed { "true".to_string() } else { "false".to_string() },
                pan: "0".to_string(),
                gain_db: "0".to_string(),
                instruct: b.parenthetical.clone(),
                fade_in_ms: "50".to_string(),
                fade_out_ms: "50".to_string(),
                reverb_send: "0".to_string(),
                emotion: String::new(),
                notes: format!("id:{}", b.id),
                gain_envelope: String::new(),
                spatial_azimuth: String::new(),
                spatial_elevation: String::new(),
                spatial_path: String::new(),
                spatial_space: String::new(),
            }
        })
        .collect()
}

#[cfg(test)]
mod title_page_tests {
    use super::*;

    #[test]
    fn cues_find_characters_whose_names_end_in_a_parenthetical() {
        let map = cue_lookup([("Percey Weasley (GOF)", "C1"), ("Ron", "C2")].into_iter());
        assert_eq!(map.get(&extract_character("PERCEY WEASLEY (GOF)").to_ascii_uppercase()).map(String::as_str), Some("C1"));
        assert_eq!(map.get("RON").map(String::as_str), Some("C2"));
    }

    #[test]
    fn sections_name_the_act_of_the_scenes_under_them() {
        let doc = parse_document("# Act One\n\nINT. ARCHIVE - NIGHT\n\nWREN\nHello.\n\nEXT. QUAY - NIGHT\n\nA bell.\n\n## Act Two\n\nINT. BOAT - NIGHT\n\nPIP\nGo.\n");
        let acts: Vec<_> = doc.scenes.iter().map(|s| s.act.as_deref()).collect();
        assert_eq!(acts, vec![Some("Act One"), Some("Act One"), Some("Act Two")]);
        assert!(doc.scenes.iter().all(|s| s.blocks.iter().all(|b| !b.text.starts_with('#'))), "sections aren't directions");
    }

    #[test]
    fn a_scene_opening_with_cues_is_not_a_title_page() {
        let doc = parse_document("BED: Wind against high windows\n\nMUSIC: Low piano\n\nNARRATOR\nOn the cliffs.\n");
        assert!(doc.title.is_none());
        let kinds: Vec<&str> = doc.scenes.iter().flat_map(|s| s.blocks.iter().map(|b| b.block_type.as_str())).collect();
        assert_eq!(kinds, vec!["BED", "MUSIC", "DIALOGUE"]);
    }

    #[test]
    fn a_real_title_page_is_still_read() {
        let doc = parse_document("Title: The Lantern Archive\nAuthor: Someone\nDraft date: today\n\nSFX: A bell\n");
        assert_eq!(doc.title.as_deref(), Some("The Lantern Archive"));
        assert_eq!(doc.scenes.iter().map(|s| s.blocks.len()).sum::<usize>(), 1);
    }
}
