//! Prose → audio-drama script (Fountain).
//!
//! A chapter of prose becomes narrator lines, dialogue in each character's
//! voice, and effect / bed / music cues. The work is split so the words are
//! never rewritten:
//!
//! 1. [`parse`] splits the text into ordered segments — narration and quoted
//!    speech — deterministically. Nobody paraphrases anything.
//! 2. A [`Plan`] says who speaks each quote (and how), where scenes start and
//!    where cues go. [`heuristic_plan`] makes one from dialogue tags ("Hagrid
//!    said") and turn-taking; `commands::prose_script` asks Claude for a
//!    better one (speakers, delivery, scenes, effects, music).
//! 3. [`assemble`] writes the Fountain. With `intros` on, a character's first
//!    line in each scene is followed by the narrator naming them ("Said
//!    Hagrid.") unless the prose around the line already does — so listeners
//!    learn the voices. A pronoun tag right after the line ("he said") is
//!    turned into the name instead of adding a second tag.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

// ── Segments ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    pub id: usize,
    /// Paragraph index; a quote and the narration around it share one.
    pub para: usize,
    pub quote: bool,
    pub text: String,
    /// A section break (`---`, `***`, `* * *`) came before this segment.
    #[serde(default)]
    pub section_break: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Source {
    /// From a leading `# Heading`, if any.
    pub title: Option<String>,
    pub segments: Vec<Segment>,
}

fn is_metadata(line: &str) -> bool {
    let l = line.trim().trim_start_matches(['_', '*']).to_lowercase();
    ["source:", "words:", "author:", "rating:", "summary:", "url:"].iter().any(|k| l.starts_with(k))
}

fn is_rule(line: &str) -> bool {
    let t: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    t.len() >= 3 && (t.chars().all(|c| c == '-') || t.chars().all(|c| c == '*') || t.chars().all(|c| c == '_') || t.chars().all(|c| c == '~'))
}

/// Remove markdown emphasis markers (`*x*`, `_x_`, `**x**`) but keep the words.
fn strip_emphasis(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '*' {
            continue;
        }
        if c == '_' {
            // An underscore between letters is part of a word (snake_case); an
            // emphasis marker sits at a word edge.
            let prev = i.checked_sub(1).map(|j| chars[j]);
            let next = chars.get(i + 1).copied();
            if prev.is_some_and(|p| p.is_alphanumeric()) && next.is_some_and(|n| n.is_alphanumeric()) {
                out.push(c);
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn tidy(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Split prose into paragraphs of narration and quoted speech.
pub fn parse(text: &str) -> Source {
    let mut title = None;
    let mut paragraphs: Vec<(String, bool)> = Vec::new(); // (text, section break before)
    let mut current: Vec<String> = Vec::new();
    let mut pending_break = false;
    let flush = |current: &mut Vec<String>, paragraphs: &mut Vec<(String, bool)>, pending_break: &mut bool| {
        if !current.is_empty() {
            paragraphs.push((tidy(&current.join(" ")), *pending_break));
            *pending_break = false;
            current.clear();
        }
    };
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            flush(&mut current, &mut paragraphs, &mut pending_break);
            continue;
        }
        if let Some(h) = t.strip_prefix('#') {
            flush(&mut current, &mut paragraphs, &mut pending_break);
            let h = h.trim_start_matches('#').trim().to_string();
            if title.is_none() && paragraphs.is_empty() {
                title = Some(h);
            } else {
                pending_break = true;
            }
            continue;
        }
        if is_rule(t) {
            flush(&mut current, &mut paragraphs, &mut pending_break);
            // A rule straight after the title block is decoration, not a break.
            if !paragraphs.is_empty() {
                pending_break = true;
            }
            continue;
        }
        if is_metadata(t) {
            continue;
        }
        current.push(strip_emphasis(t));
    }
    flush(&mut current, &mut paragraphs, &mut pending_break);

    let mut segments = Vec::new();
    for (para, (p, brk)) in paragraphs.iter().enumerate() {
        let mut first = true;
        for (quote, piece) in split_quotes(p) {
            let text = if quote { tidy_quote(&piece) } else { tidy_narration(&piece) };
            if !text.chars().any(|c| c.is_alphanumeric()) {
                continue;
            }
            segments.push(Segment { id: segments.len(), para, quote, text, section_break: *brk && first });
            first = false;
        }
    }
    Source { title, segments }
}

/// Alternate narration / speech in one paragraph. Straight quotes toggle;
/// curly quotes open and close. An unclosed quote runs to the paragraph end.
fn split_quotes(p: &str) -> Vec<(bool, String)> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut in_quote = false;
    for c in p.chars() {
        match c {
            '“' | '"' if !in_quote => {
                out.push((false, std::mem::take(&mut buf)));
                in_quote = true;
            }
            '”' | '"' if in_quote => {
                out.push((true, std::mem::take(&mut buf)));
                in_quote = false;
            }
            '”' => {} // stray closing quote outside speech
            _ => buf.push(c),
        }
    }
    out.push((in_quote, buf));
    out
}

/// Speech as it should be read: a trailing comma (`"Okay," he said`) ends the
/// line with a full stop instead.
fn tidy_quote(s: &str) -> String {
    let mut t = tidy(s);
    if t.ends_with(',') {
        t.pop();
        t.push('.');
    }
    t
}

/// Narration fragment: trimmed of the punctuation left at its edges by the
/// quotes around it.
fn tidy_narration(s: &str) -> String {
    let t = tidy(s).trim_start_matches([',', ';', ' ', '—', '-']).trim().to_string();
    // "he asked." read on its own starts a sentence.
    let mut c = t.chars();
    match c.next() {
        Some(f) if f.is_lowercase() => f.to_uppercase().collect::<String>() + c.as_str(),
        _ => t,
    }
}

// ── Cast ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastMember {
    /// The project's name for them (cue name), e.g. "Harry Potter (GOF)".
    pub name: String,
    /// Lowercase names the prose may use: "harry potter", "harry", "potter".
    pub aliases: Vec<String>,
    /// How the narrator names them: the alias the prose uses most ("Harry").
    pub short: String,
}

const TITLES: &[&str] = &[
    "mr", "mrs", "ms", "miss", "madam", "madame", "professor", "sir", "lady", "lord", "the", "of", "and", "dr",
    "jr", "sr", "uncle", "aunt", "master", "mistress", "captain", "young", "old", "little",
];

fn bare(name: &str) -> String {
    name.split('(').next().unwrap_or(name).trim().to_string()
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|w| !w.is_empty()).map(|w| w.to_lowercase()).collect()
}

/// Whole-word, case-insensitive occurrences of `needle` (one or more words) in `hay`.
fn count_word(hay_words: &[String], needle: &str) -> usize {
    let n = words(needle);
    if n.is_empty() || n.len() > hay_words.len() {
        return 0;
    }
    hay_words.windows(n.len()).filter(|w| *w == n.as_slice()).count()
}

/// Cast members with the aliases the prose can call them by. A word shared by
/// two characters ("Weasley") isn't an alias for either.
pub fn cast_from_names(names: &[String], text: &str) -> Vec<CastMember> {
    let mut token_owners: HashMap<String, usize> = HashMap::new();
    for n in names {
        for w in words(&bare(n)).into_iter().collect::<HashSet<_>>() {
            *token_owners.entry(w).or_default() += 1;
        }
    }
    let text_words = words(text);
    names
        .iter()
        .map(|n| {
            let b = bare(n);
            let mut aliases = vec![b.to_lowercase()];
            let ws = words(&b);
            for w in &ws {
                if w.len() >= 3 && !TITLES.contains(&w.as_str()) && token_owners.get(w) == Some(&1) && !aliases.contains(w) {
                    aliases.push(w.clone());
                }
            }
            // "Mr Dursley" for "Mr. Dursley".
            if ws.len() >= 2 && TITLES.contains(&ws[0].as_str()) {
                let t = ws.join(" ");
                if !aliases.contains(&t) {
                    aliases.push(t);
                }
            }
            // The narrator's name for them: the alias the prose uses most,
            // in the original capitalisation.
            let best = aliases.iter().max_by_key(|a| (count_word(&text_words, a), std::cmp::Reverse(a.len()))).cloned().unwrap_or_default();
            let short = if count_word(&text_words, &best) == 0 { b.clone() } else { recase(&b, &best) };
            CastMember { name: n.clone(), aliases, short }
        })
        .collect()
}

const NOT_NAMES: &[&str] = &[
    "The", "A", "An", "He", "She", "They", "It", "I", "You", "We", "His", "Her", "Their", "Then", "But", "And",
    "Nobody", "Somebody", "Someone", "Everyone", "Everybody", "No", "Yes", "Oh", "Well", "So", "That", "This",
    "There", "Here", "What", "Who", "Why", "How", "When", "Where", "Mr", "Mrs", "Ms", "Miss", "Professor", "Sir",
];

/// Speakers the prose names in its dialogue tags ("Wren snapped", "said
/// Pip") that the cast doesn't cover. A name that appears in the text with a
/// surname ("Pip Holloway") is returned in full.
pub fn discover_names(src: &Source, cast: &[CastMember]) -> Vec<String> {
    let segs = &src.segments;
    let all_text: String = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    let cap = |w: &str| -> Option<String> {
        let t = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'');
        let first = t.chars().next()?;
        (first.is_uppercase() && t.len() >= 2 && !NOT_NAMES.contains(&t)).then(|| t.to_string())
    };
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut beats: HashMap<String, usize> = HashMap::new();
    for (i, s) in segs.iter().enumerate() {
        if s.quote {
            continue;
        }
        let beside_quote = (i > 0 && segs[i - 1].quote && segs[i - 1].para == s.para)
            || segs.get(i + 1).is_some_and(|n| n.quote && n.para == s.para);
        if !beside_quote {
            continue;
        }
        let ws: Vec<&str> = s.text.split_whitespace().collect();
        for (vi, w) in ws.iter().enumerate() {
            let lw = w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
            if !SPEECH_VERBS.contains(&lw.as_str()) {
                continue;
            }
            // "Wren snapped" / "said Wren" / "Master Corvin said".
            let before = vi.checked_sub(1).and_then(|j| cap(ws[j]));
            let after = ws.get(vi + 1).and_then(|x| cap(x));
            if let Some(n) = before.or(after) {
                *counts.entry(n).or_default() += 1;
            }
        }
        // An action beat: "Corvin dropped into the chair." / "Master Corvin
        // looked up." — a name opening the fragment, then a lowercase word.
        let lead = ws.iter().position(|w| !TITLES.contains(&w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase().as_str())).unwrap_or(0);
        if let (Some(n), Some(next)) = (ws.get(lead).and_then(|w| cap(w)), ws.get(lead + 1)) {
            if next.chars().next().is_some_and(|c| c.is_lowercase()) && !ws[lead].ends_with(['.', ',', '!', '?']) {
                *beats.entry(n).or_default() += 1;
            }
        }
    }
    // A beat name must be a name the text uses more than once ("Somewhere in
    // the back…" is not a person).
    let all_words: Vec<&str> = all_text.split(|c: char| !c.is_alphanumeric() && c != '\'').collect();
    for (n, k) in beats {
        if all_words.iter().filter(|w| **w == n).count() >= 2 {
            *counts.entry(n).or_default() += k;
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut found: Vec<(String, usize)> = counts.into_iter().collect();
    found.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (n, _) in found {
        let lower = n.to_lowercase();
        if cast.iter().any(|m| m.aliases.contains(&lower)) {
            continue;
        }
        // The full name, if the prose gives one: "Pip Holloway".
        let full = all_text
            .split(|c: char| !c.is_alphanumeric() && c != '\'' && c != ' ')
            .flat_map(|run| {
                let ws: Vec<&str> = run.split_whitespace().collect();
                (0..ws.len().saturating_sub(1))
                    .filter(|&k| ws[k] == n && cap(ws[k + 1]).is_some() && !TITLES.contains(&ws[k + 1].to_lowercase().as_str()))
                    .map(|k| format!("{} {}", ws[k], ws[k + 1]))
                    .collect::<Vec<_>>()
            })
            .next()
            .unwrap_or(n);
        if !out.iter().any(|o| o.split_whitespace().any(|w| w.eq_ignore_ascii_case(&lower))) {
            out.push(full);
        }
    }
    out
}

/// `alias` in the capitalisation `name` uses ("harry" in "Harry Potter" → "Harry").
fn recase(name: &str, alias: &str) -> String {
    let lower = name.to_lowercase();
    match lower.find(alias) {
        Some(i) => name[i..i + alias.len()].to_string(),
        None => alias.to_string(),
    }
}

fn mentions(text: &str, m: &CastMember) -> bool {
    let tw = words(text);
    m.aliases.iter().any(|a| count_word(&tw, a) > 0)
}

// ── Plan ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LineAttr {
    /// Segment id of the quote.
    pub id: usize,
    /// Cast name (or a new character's name).
    pub speaker: String,
    /// The narrator's verb for this line ("said", "whispered", "asked").
    #[serde(default)]
    pub verb: String,
    /// A short performance direction for the voice ("nervous, quiet").
    #[serde(default)]
    pub delivery: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CuePlan {
    /// The cue goes after this segment (or before the first, if 0 and `at_start`).
    pub after: usize,
    /// "SFX", "BED" or "MUSIC".
    pub kind: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SceneStart {
    /// The first segment of the scene.
    pub at: usize,
    /// A Fountain heading, e.g. "INT. MADAM MALKIN'S SHOP - DAY".
    pub heading: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Plan {
    pub lines: Vec<LineAttr>,
    #[serde(default)]
    pub cues: Vec<CuePlan>,
    #[serde(default)]
    pub scenes: Vec<SceneStart>,
}

const SPEECH_VERBS: &[&str] = &[
    "said", "says", "asked", "asks", "replied", "answered", "whispered", "shouted", "yelled", "cried", "called",
    "muttered", "mumbled", "murmured", "snapped", "growled", "hissed", "added", "continued", "began", "insisted",
    "exclaimed", "laughed", "sighed", "sobbed", "groaned", "gasped", "breathed", "drawled", "sneered", "barked",
    "roared", "bellowed", "screamed", "stammered", "stuttered", "pleaded", "demanded", "agreed", "admitted",
    "explained", "informed", "told", "repeated", "interrupted", "retorted", "chuckled", "grumbled", "squeaked",
];

/// Delivery implied by a tag verb.
fn delivery_for(verb: &str) -> &'static str {
    match verb {
        "whispered" | "breathed" => "whispering",
        "shouted" | "yelled" | "bellowed" | "roared" | "screamed" | "barked" => "shouting",
        "cried" | "exclaimed" => "with feeling, raised voice",
        "muttered" | "mumbled" | "murmured" | "grumbled" => "muttering, low",
        "snapped" | "hissed" | "growled" => "sharp, angry",
        "sneered" | "drawled" => "sneering, disdainful",
        "laughed" | "chuckled" => "laughing",
        "sighed" => "with a sigh",
        "sobbed" => "through tears",
        "gasped" => "breathless, shocked",
        "stammered" | "stuttered" => "nervous, stammering",
        "pleaded" => "pleading",
        "squeaked" => "high and startled",
        _ => "",
    }
}

const PRONOUNS: &[&str] = &["he", "she", "they"];

/// A dialogue tag in a narration fragment: (speaker index in cast or pronoun,
/// verb, adverb). `after` = the fragment follows the quote (tag at its start).
/// A tag's speaker: a cast member, or a pronoun ("he", "she", "they").
#[derive(Debug, Clone, PartialEq)]
enum TagWho {
    Cast(usize),
    Pronoun(String),
}

fn find_tag(text: &str, cast: &[CastMember], after: bool) -> Option<(TagWho, String, String)> {
    let ws = words(text);
    // Look near the quote: the start of a following fragment, the end of a
    // preceding one.
    let window: Vec<String> = if after { ws.iter().take(8).cloned().collect() } else { ws.iter().rev().take(8).rev().cloned().collect() };
    let vi = window.iter().position(|w| SPEECH_VERBS.contains(&w.as_str()))?;
    let verb = window[vi].clone();
    let adverb = window.get(vi + 1).filter(|w| w.ends_with("ly") && w.len() > 4).cloned().unwrap_or_default();
    // A name or pronoun beside the verb ("Hagrid said", "said Hagrid", "he said").
    let near = window.join(" ");
    let who = cast
        .iter()
        .enumerate()
        .filter(|(_, m)| m.aliases.iter().any(|a| count_word(&window, a) > 0))
        .min_by_key(|(_, m)| {
            m.aliases.iter().filter_map(|a| near.find(a.as_str())).map(|p| (p as i64 - near.find(&verb).unwrap_or(0) as i64).abs()).min().unwrap_or(i64::MAX)
        })
        .map(|(i, _)| i);
    if let Some(ci) = who {
        return Some((TagWho::Cast(ci), verb, adverb));
    }
    let pronoun = window.iter().take(vi + 2).find(|w| PRONOUNS.contains(&w.as_str()))?;
    Some((TagWho::Pronoun(pronoun.clone()), verb, adverb))
}

/// "she" / "he" for each cast member, from the pronouns that follow their
/// name in the narration (None when the prose doesn't make it clear).
fn pronouns_of(src: &Source, cast: &[CastMember]) -> Vec<Option<&'static str>> {
    let mut tally = vec![(0i32, 0i32); cast.len()];
    for s in src.segments.iter().filter(|s| !s.quote) {
        let sentences: Vec<&str> = s.text.split_inclusive(['.', '!', '?']).collect();
        for (k, sent) in sentences.iter().enumerate() {
            let named: Vec<usize> = (0..cast.len()).filter(|&i| mentions(sent, &cast[i])).collect();
            if named.len() != 1 {
                continue;
            }
            // Pronouns after the name in this sentence, and a pronoun opening
            // the next one ("Wren set down her cloth." / "Pip sat. He …").
            let m = &cast[named[0]];
            let ws = words(sent);
            let at = ws.iter().position(|w| m.aliases.iter().any(|a| a.split(' ').next_back() == Some(w.as_str()))).unwrap_or(0);
            let mut follow: Vec<String> = ws[at..].to_vec();
            if let Some(first) = sentences.get(k + 1).and_then(|n| words(n).into_iter().next()) {
                follow.push(first);
            }
            for w in follow {
                match w.as_str() {
                    "she" | "her" | "herself" => tally[named[0]].0 += 1,
                    "he" | "him" | "his" | "himself" => tally[named[0]].1 += 1,
                    _ => {}
                }
            }
        }
    }
    tally
        .into_iter()
        .map(|(f, m)| if f > m { Some("she") } else if m > f { Some("he") } else { None })
        .collect()
}

/// Attribute quotes from dialogue tags and turn-taking — no model needed.
/// Pronoun tags go to the character most recently named in the narration;
/// untagged lines alternate between the conversation's last two speakers.
pub fn heuristic_plan(src: &Source, cast: &[CastMember], narrator: &str) -> Plan {
    let segs = &src.segments;
    let mut lines: Vec<LineAttr> = Vec::new();
    let mut by_para: HashMap<usize, String> = HashMap::new();
    let mut recent_named: Vec<usize> = Vec::new(); // cast indices, most recent last
    let mut speakers: Vec<String> = Vec::new(); // in order of lines
    let mut scenes = Vec::new();
    let mut part = 1;
    let genders = pronouns_of(src, cast);
    for (i, s) in segs.iter().enumerate() {
        if s.section_break {
            part += 1;
            scenes.push(SceneStart { at: s.id, heading: format!("INT. {} PART {}", heading_title(src), part) });
            speakers.clear();
        }
        if !s.quote {
            for (ci, m) in cast.iter().enumerate() {
                if m.name != narrator && mentions(&s.text, m) {
                    recent_named.retain(|&x| x != ci);
                    recent_named.push(ci);
                }
            }
            continue;
        }
        let next = segs.get(i + 1).filter(|n| !n.quote && n.para == s.para);
        let prev = i.checked_sub(1).map(|j| &segs[j]).filter(|p| !p.quote && p.para == s.para);
        let tag = next.and_then(|n| find_tag(&n.text, cast, true)).or_else(|| prev.and_then(|p| find_tag(&p.text, cast, false)));
        let last_speaker = speakers.last().cloned();
        let named = |ci: usize| cast[ci].name.clone();
        let speaker = match &tag {
            Some((TagWho::Cast(ci), _, _)) => named(*ci),
            Some((TagWho::Pronoun(p), _, _)) => {
                // The most recently named character the pronoun fits.
                let fits = |ci: usize| p == "they" || genders[ci].is_none_or(|g| g == p);
                recent_named
                    .iter()
                    .rev()
                    .filter(|&&ci| fits(ci))
                    .map(|&ci| named(ci))
                    .find(|n| Some(n) != last_speaker.as_ref())
                    .or_else(|| recent_named.iter().rev().find(|&&ci| fits(ci)).map(|&ci| named(ci)))
                    .unwrap_or_else(|| "UNKNOWN".into())
            }
            // An action beat beside the line names exactly one character
            // ("Pip ducked under the beam.").
            None if beat_speaker(prev, next, cast, narrator).is_some() => named(beat_speaker(prev, next, cast, narrator).unwrap()),
            None => by_para.get(&s.para).cloned().unwrap_or_else(|| {
                // Turn-taking: the speaker before the last one.
                let mut distinct = speakers.iter().rev().fold(Vec::<String>::new(), |mut acc, sp| {
                    if !acc.contains(sp) {
                        acc.push(sp.clone());
                    }
                    acc
                });
                if distinct.len() >= 2 {
                    distinct.swap_remove(1)
                } else {
                    recent_named.iter().rev().map(|&ci| named(ci)).find(|n| Some(n) != last_speaker.as_ref()).unwrap_or_else(|| "UNKNOWN".into())
                }
            }),
        };
        let (verb, delivery) = match &tag {
            Some((_, v, adv)) => {
                let d = [delivery_for(v), adv.as_str()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(", ");
                (v.clone(), d)
            }
            None => (if s.text.trim_end().ends_with('?') { "asked".into() } else { "said".into() }, String::new()),
        };
        by_para.insert(s.para, speaker.clone());
        speakers.push(speaker.clone());
        lines.push(LineAttr { id: s.id, speaker, verb, delivery });
    }
    Plan { lines, cues: vec![], scenes }
}

/// The one character named in the narration right beside a quote (the
/// following fragment first), if exactly one is.
fn beat_speaker(prev: Option<&Segment>, next: Option<&Segment>, cast: &[CastMember], narrator: &str) -> Option<usize> {
    [next, prev].into_iter().flatten().find_map(|seg| {
        let hits: Vec<usize> = cast.iter().enumerate().filter(|(_, m)| m.name != narrator && mentions(&seg.text, m)).map(|(i, _)| i).collect();
        (hits.len() == 1).then(|| hits[0])
    })
}

fn heading_title(src: &Source) -> String {
    let t = src.title.clone().unwrap_or_else(|| "SCENE".into());
    // "Chapter 1: Into the magical world" → the part after the colon.
    let t = t.split_once(':').map(|(_, r)| r.trim().to_string()).filter(|r| !r.is_empty()).unwrap_or(t);
    t.to_uppercase()
}

// ── Assembly ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssembleOptions {
    /// The narrator's cast name.
    pub narrator: String,
    /// Name each character after their first line in every scene.
    pub intros: bool,
    /// Split narration longer than this into sentence-bounded lines.
    pub max_narration_chars: usize,
}

impl Default for AssembleOptions {
    fn default() -> Self {
        AssembleOptions { narrator: "Narrator".into(), intros: true, max_narration_chars: 450 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssembleStats {
    pub scenes: usize,
    pub narration_lines: usize,
    pub dialogue_lines: usize,
    pub intros_added: usize,
    pub tags_named: usize,
    pub cues: usize,
    pub speakers: Vec<String>,
    /// Quotes nobody could attribute (cue "UNKNOWN").
    pub unknown: usize,
}

/// Sentence-bounded pieces of at most ~`max` characters.
fn chunk_sentences(text: &str, max: usize) -> Vec<String> {
    if text.chars().count() <= max {
        return vec![text.to_string()];
    }
    let mut sentences = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let end = matches!(c, '.' | '!' | '?' | '…') && chars.get(i + 1).is_none_or(|n| n.is_whitespace());
        if end {
            sentences.push(cur.trim().to_string());
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        sentences.push(cur.trim().to_string());
    }
    let mut out = Vec::new();
    let mut acc = String::new();
    for s in sentences {
        if !acc.is_empty() && acc.chars().count() + 1 + s.chars().count() > max {
            out.push(std::mem::take(&mut acc));
        }
        if !acc.is_empty() {
            acc.push(' ');
        }
        acc.push_str(&s);
    }
    if !acc.is_empty() {
        out.push(acc);
    }
    out
}

/// "he said, grinning" → "Harry said, grinning" when the pronoun opens a tag.
fn name_pronoun_tag(narration: &str, short: &str) -> Option<String> {
    let ws: Vec<&str> = narration.split_whitespace().collect();
    let first = ws.first()?.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    let second = ws.get(1)?.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    if PRONOUNS.contains(&first.as_str()) && SPEECH_VERBS.contains(&second.as_str()) {
        let rest = narration.trim_start()[ws[0].len()..].to_string();
        return Some(format!("{}{}", short, rest));
    }
    None
}

fn cue_name(name: &str) -> String {
    name.trim().to_uppercase()
}

fn block(out: &mut String, who: &str, direction: &str, text: &str) {
    out.push_str(&cue_name(who));
    out.push('\n');
    if !direction.trim().is_empty() {
        out.push_str(&format!("({})\n", direction.trim().trim_matches(['(', ')'])));
    }
    out.push_str(text.trim());
    out.push_str("\n\n");
}

/// Write the Fountain script for `src` following `plan`.
pub fn assemble(src: &Source, plan: &Plan, cast: &[CastMember], o: &AssembleOptions) -> (String, AssembleStats) {
    let mut stats = AssembleStats::default();
    let attrs: HashMap<usize, &LineAttr> = plan.lines.iter().map(|l| (l.id, l)).collect();
    let mut scene_at: HashMap<usize, &SceneStart> = plan.scenes.iter().map(|s| (s.at, s)).collect();
    let default_scene = SceneStart { at: 0, heading: format!("INT. {}", heading_title(src)) };
    scene_at.entry(0).or_insert(&default_scene);
    let mut cues_after: HashMap<usize, Vec<&CuePlan>> = HashMap::new();
    for c in &plan.cues {
        cues_after.entry(c.after).or_default().push(c);
    }
    let by_name: HashMap<String, &CastMember> = cast.iter().map(|m| (m.name.to_lowercase(), m)).collect();
    let short_of = |name: &str| by_name.get(&name.to_lowercase()).map(|m| m.short.clone()).unwrap_or_else(|| bare(name));

    let mut out = String::new();
    let mut introduced: HashSet<String> = HashSet::new();
    let mut speakers: Vec<String> = Vec::new();
    let mut skip_narration: HashSet<usize> = HashSet::new();
    let segs = &src.segments;
    for (i, s) in segs.iter().enumerate() {
        if let Some(sc) = scene_at.get(&s.id) {
            out.push_str(sc.heading.trim());
            out.push_str("\n\n");
            introduced.clear();
            stats.scenes += 1;
        }
        if s.quote {
            let a = attrs.get(&s.id);
            let speaker = a.map(|a| a.speaker.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "UNKNOWN".into());
            if speaker == "UNKNOWN" {
                stats.unknown += 1;
            }
            block(&mut out, &speaker, a.map(|a| a.delivery.as_str()).unwrap_or(""), &s.text);
            stats.dialogue_lines += 1;
            if !speakers.contains(&speaker) {
                speakers.push(speaker.clone());
            }
            // Name a voice the first time it speaks in the scene.
            if o.intros && speaker != "UNKNOWN" && !speaker.eq_ignore_ascii_case(&o.narrator) && introduced.insert(speaker.to_lowercase()) {
                let member = by_name.get(&speaker.to_lowercase()).copied();
                let fallback = CastMember { name: speaker.clone(), aliases: vec![bare(&speaker).to_lowercase()], short: bare(&speaker) };
                let m = member.unwrap_or(&fallback);
                let next = segs.get(i + 1).filter(|n| !n.quote && n.para == s.para);
                let prev = i.checked_sub(1).map(|j| &segs[j]).filter(|p| !p.quote && p.para == s.para);
                let named_nearby = next.is_some_and(|n| mentions(&n.text, m)) || prev.is_some_and(|p| mentions(&p.text, m));
                if !named_nearby {
                    let short = short_of(&speaker);
                    if let Some(n) = next.and_then(|n| name_pronoun_tag(&n.text, &short).map(|t| (n.id, t))) {
                        // The prose's own tag, with the name in place of "he".
                        block(&mut out, &o.narrator, "", &n.1);
                        skip_narration.insert(n.0);
                        stats.tags_named += 1;
                        stats.narration_lines += 1;
                    } else {
                        let verb = a.map(|a| a.verb.trim()).filter(|v| !v.is_empty()).unwrap_or("said");
                        let verb = verb.to_lowercase();
                        let mut v = verb.chars();
                        let verb: String = v.next().map(|f| f.to_uppercase().collect::<String>() + v.as_str()).unwrap_or_default();
                        block(&mut out, &o.narrator, "", &format!("{} {}.", verb, short));
                        stats.intros_added += 1;
                    }
                }
            }
        } else if !skip_narration.contains(&s.id) {
            for piece in chunk_sentences(&s.text, o.max_narration_chars) {
                block(&mut out, &o.narrator, "", &piece);
                stats.narration_lines += 1;
            }
        }
        for c in cues_after.get(&s.id).into_iter().flatten() {
            let kind = match c.kind.to_uppercase().as_str() {
                "BED" => "BED",
                "MUSIC" => "MUSIC",
                _ => "SFX",
            };
            out.push_str(&format!("{}: {}\n\n", kind, c.prompt.trim()));
            stats.cues += 1;
        }
    }
    stats.speakers = speakers;
    (out.trim_end().to_string() + "\n", stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROSE: &str = "# Chapter 1: The Archive\n\n_Source: somewhere_\n\n---\n\n\
\"Mind the step,\" Wren said as they reached the stair. The lamp hissed.\n\n\
\"I see it.\" Pip ducked under the beam. \"Is it always this cold?\"\n\n\
\"Always.\"\n\n\
\"Then why do you work here?\" he asked.\n\n\
Master Corvin looked up from the ledger. \"Because someone has to.\"\n\n\
* * *\n\n\
The bell rang across the water. \"Again?\" Wren whispered.\n";

    fn cast(src: &str) -> Vec<CastMember> {
        cast_from_names(&["Narrator".into(), "Wren Alder".into(), "Pip Holloway".into(), "Master Corvin".into()], src)
    }

    #[test]
    fn parses_narration_and_speech_and_drops_metadata() {
        let s = parse(PROSE);
        assert_eq!(s.title.as_deref(), Some("Chapter 1: The Archive"));
        assert_eq!(s.segments[0], Segment { id: 0, para: 0, quote: true, text: "Mind the step.".into(), section_break: false });
        assert_eq!(s.segments[1].text, "Wren said as they reached the stair. The lamp hissed.");
        assert!(!s.segments.iter().any(|x| x.text.contains("Source")));
        let brk = s.segments.iter().find(|x| x.section_break).unwrap();
        assert_eq!(brk.text, "The bell rang across the water.");
    }

    #[test]
    fn aliases_and_short_names_follow_the_prose() {
        let c = cast(PROSE);
        let wren = c.iter().find(|m| m.name == "Wren Alder").unwrap();
        assert_eq!(wren.short, "Wren");
        let corvin = c.iter().find(|m| m.name == "Master Corvin").unwrap();
        assert!(corvin.aliases.contains(&"corvin".to_string()));
        assert!(!corvin.aliases.contains(&"master".to_string()), "titles aren't aliases");
    }

    #[test]
    fn heuristics_use_tags_paragraphs_turn_taking_and_pronouns() {
        let src = parse(PROSE);
        let c = cast(PROSE);
        let p = heuristic_plan(&src, &c, "Narrator");
        let who: Vec<(&str, &str)> = p.lines.iter().map(|l| (src.segments[l.id].text.as_str(), l.speaker.as_str())).collect();
        assert_eq!(who[0], ("Mind the step.", "Wren Alder"), "tag after the line");
        assert_eq!(who[1].1, "Pip Holloway", "named in the narration around it");
        assert_eq!(who[2].1, "Pip Holloway", "same paragraph, same speaker");
        assert_eq!(who[3], ("Always.", "Wren Alder"), "turn-taking");
        assert_eq!(who[4].1, "Pip Holloway", "pronoun tag");
        assert_eq!(who[5].1, "Master Corvin");
        assert_eq!(who[6].1, "Wren Alder");
        assert_eq!(p.lines[6].verb, "whispered");
        assert_eq!(p.lines[6].delivery, "whispering");
        assert_eq!(p.scenes.len(), 1, "the section break starts a scene");
    }

    #[test]
    fn introduces_each_voice_once_per_scene_unless_the_prose_already_does() {
        let src = parse(PROSE);
        let c = cast(PROSE);
        let p = heuristic_plan(&src, &c, "Narrator");
        let (f, stats) = assemble(&src, &p, &c, &AssembleOptions::default());
        // Wren's first line is already tagged ("Wren said") — no extra intro.
        assert!(!f.contains("Said Wren."));
        // Pip is named in the narration beside his first line, so no intro either;
        // Corvin's line follows "Master Corvin looked up" — named, no intro.
        assert!(!f.contains("Said Corvin."));
        // A new scene re-introduces voices; Wren's tag ("Wren whispered") names her.
        assert_eq!(stats.scenes, 2);
        assert_eq!(stats.unknown, 0);
        // The script parses back into the same speakers.
        let doc = crate::fountain::parse_document(&f);
        let spoken: Vec<String> = doc.scenes.iter().flat_map(|s| s.blocks.iter()).filter(|b| matches!(b.block_type, crate::fountain::BlockType::Dialogue) && b.character != "NARRATOR").map(|b| b.character.clone()).collect();
        assert_eq!(spoken.first().map(String::as_str), Some("WREN ALDER"));
    }

    #[test]
    fn adds_said_name_when_nothing_identifies_the_speaker() {
        let src = parse("\"Hello there.\"\n\n\"Who's that?\"\n");
        let c = cast_from_names(&["Narrator".into(), "Hagrid".into(), "Harry Potter".into()], "Hagrid Harry");
        let plan = Plan {
            lines: vec![
                LineAttr { id: 0, speaker: "Hagrid".into(), verb: "said".into(), delivery: String::new() },
                LineAttr { id: 1, speaker: "Harry Potter".into(), verb: "asked".into(), delivery: "nervous".into() },
            ],
            ..Default::default()
        };
        let (f, stats) = assemble(&src, &plan, &c, &AssembleOptions::default());
        assert!(f.contains("HAGRID\nHello there.\n\nNARRATOR\nSaid Hagrid.\n"));
        assert!(f.contains("HARRY POTTER\n(nervous)\nWho's that?\n\nNARRATOR\nAsked Harry.\n"));
        assert_eq!(stats.intros_added, 2);
    }

    #[test]
    fn a_pronoun_tag_gets_the_name_instead_of_a_second_tag() {
        let src = parse("\"Not again,\" he muttered, shaking his head.\n");
        let c = cast_from_names(&["Narrator".into(), "Ron Weasley".into()], "Ron");
        let plan = Plan { lines: vec![LineAttr { id: 0, speaker: "Ron Weasley".into(), verb: "muttered".into(), delivery: String::new() }], ..Default::default() };
        let (f, stats) = assemble(&src, &plan, &c, &AssembleOptions::default());
        assert!(f.contains("NARRATOR\nRon muttered, shaking his head.\n"), "{f}");
        assert!(!f.contains("he muttered"));
        assert_eq!((stats.tags_named, stats.intros_added), (1, 0));
    }

    #[test]
    fn discovers_speakers_from_tags_with_full_names() {
        let text = "Pip Holloway came in.\n\n\"Hi,\" said Pip.\n\n\"Out,\" Wren snapped.\n\n\"Fine,\" said Pip. Then he left.\n";
        let src = parse(text);
        let c = cast_from_names(&["Narrator".into()], text);
        assert_eq!(discover_names(&src, &c), vec!["Pip Holloway".to_string(), "Wren".to_string()]);
        let known = cast_from_names(&["Narrator".into(), "Wren Alder".into()], text);
        assert_eq!(discover_names(&src, &known), vec!["Pip Holloway".to_string()]);
    }

    #[test]
    fn long_narration_splits_at_sentences() {
        let text = "One two three. ".repeat(60);
        let parts = chunk_sentences(text.trim(), 120);
        assert!(parts.len() > 5 && parts.iter().all(|p| p.len() <= 120 && p.ends_with('.')));
    }

    #[test]
    fn cues_land_after_their_segment() {
        let src = parse("The door opened.\n\n\"Hello.\"\n");
        let c = cast_from_names(&["Narrator".into(), "Wren".into()], "Wren");
        let plan = Plan {
            lines: vec![LineAttr { id: 1, speaker: "Wren".into(), ..Default::default() }],
            cues: vec![CuePlan { after: 0, kind: "SFX".into(), prompt: "A heavy wooden door creaks open".into() }],
            scenes: vec![SceneStart { at: 0, heading: "INT. ARCHIVE - NIGHT".into() }],
        };
        let (f, _) = assemble(&src, &plan, &c, &AssembleOptions::default());
        assert!(f.starts_with("INT. ARCHIVE - NIGHT\n\nNARRATOR\nThe door opened.\n\nSFX: A heavy wooden door creaks open\n\nWREN\nHello.\n"), "{f}");
    }
}
