//! Rebuild — turn a dissected recording back into the Pharaoh project that
//! could have made it ("render → project").
//!
//! From a finished import's manifest this creates a new project with:
//!
//! - **scenes** — one per chapter (or per ~12 min stretch without chapters),
//!   split at a pause when a chapter is long, so no scene has more ffmpeg
//!   inputs than the renderer can open;
//! - **characters** — one per substantial voice (named from spoken credits when
//!   heard), with its best clips as clone references, plus an "Extras"
//!   character for the minor voices;
//! - **script rows** — a DIALOGUE row per line, an SFX / BED / MUSIC row per
//!   detected sound, each placed at its original time — and a matching
//!   `script.fountain` so the editor shows a screenplay;
//! - **remainder beds** — per stem, everything the itemised rows don't cover
//!   (room tone, unlabelled sounds, quiet music).
//!
//! Within each stem the itemised clips and the remainder are a partition of
//! the audio — every frame belongs to exactly one file, overlaps resolved by
//! priority — and rows carry no fades or gain, so rendering the scene sums
//! back to the source. Change any row and the rest of the scene stays put.
//!
//! Clips are 24-bit FLAC (lossless against the 24-bit stems), mono only when
//! both channels are bit-identical (a mono source's
//! stems are): ~100 MB per hour of source rather than ~3.5 GB as 24-bit stereo
//! WAV. The renderer upmixes these mono `mix:as-is` clips at full level.
//!
//! Requires the rights confirmation: the project reproduces the performances.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_support::{app_projects_dir, project_dir, read_json, write_json, write_script_rows};
use crate::commands::dissect::{imports_root, DEFAULT_RIGHTS_STATEMENT};
use crate::error::{Error, Result};
use crate::models::{
    Character, LlmConfig, Project, Scene, SceneStatus, ScriptRow, Storyboard, VoiceAssignment,
    VoiceProvenance, CURRENT_CHARACTER_SCHEMA,
};

const SR: u32 = 48_000;
// Disk estimate per counted frame (clip frames plus each remainder's full
// length). 24-bit FLAC of a dual-mono 44-min drama measured 0.4 B/frame
// (201 MB vs 2.6 GB as 24-bit stereo WAV); a genuinely stereo, music-heavy
// source runs ~2× that. Not an upper bound — the build gate adds 2 GB.
const BYTES_PER_FRAME: f64 = 1.0;

// ── Options / plan ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebuildOptions {
    #[serde(default)]
    pub title: Option<String>,
    /// Chapter indices to include; None or empty = everything.
    #[serde(default)]
    pub chapters: Option<Vec<usize>>,
    #[serde(default = "d_scene_minutes")]
    pub max_scene_minutes: f64,
    #[serde(default = "d_scene_lines")]
    pub max_scene_lines: usize,
    /// Voices with less speech than this go to the shared "Extras" character.
    #[serde(default = "d_min_speech")]
    pub min_character_speech_s: f64,
    #[serde(default = "d_true")]
    pub include_sounds: bool,
    #[serde(default = "d_true")]
    pub include_remainders: bool,
    #[serde(default)]
    pub rights_confirmed: bool,
    #[serde(default)]
    pub rights_statement: Option<String>,
}

fn d_scene_minutes() -> f64 { 12.0 }
fn d_scene_lines() -> usize { 120 }
fn d_min_speech() -> f64 { 60.0 }
fn d_true() -> bool { true }

impl Default for RebuildOptions {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

// Manifest subset this module reads.
#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    source_name: String,
    duration_s: f64,
    #[serde(default)]
    chapters: Vec<Chapter>,
    #[serde(default)]
    source_tags: HashMap<String, String>,
    speakers: Vec<Speaker>,
    turns: Vec<Turn>,
    #[serde(default)]
    sounds: Option<Sounds>,
    #[serde(default)]
    stems: HashMap<String, String>,
}
#[derive(Debug, Clone, Deserialize)]
struct Chapter { title: String, start: f64, end: f64 }
#[derive(Debug, Clone, Deserialize)]
struct Speaker {
    id: String,
    label: String,
    total_speech_s: f64,
    #[serde(default)]
    credits: Vec<Credit>,
    #[serde(default)]
    candidates: Vec<Candidate>,
}
#[derive(Debug, Clone, Deserialize)]
struct Credit { character: String, performer: String }
#[derive(Debug, Clone, Deserialize)]
struct Candidate { path: String, #[serde(default)] transcript: String }
#[derive(Debug, Clone, Deserialize)]
struct Turn { speaker: String, start: f64, end: f64, #[serde(default)] text: String }
#[derive(Debug, Clone, Default, Deserialize)]
struct Sounds {
    #[serde(default)] sfx: Vec<Sound>,
    #[serde(default)] ambience: Vec<Sound>,
    #[serde(default)] music: Vec<Sound>,
}
#[derive(Debug, Clone, Deserialize)]
struct Sound {
    kind: String,
    start: f64,
    end: f64,
    name: String,
    #[serde(default)] labels: Vec<Label>,
}
#[derive(Debug, Clone, Deserialize)]
struct Label { label: String }

#[derive(Debug, Clone, Serialize)]
pub struct PlanLine { pub speaker: String, pub start: f64, pub end: f64, pub text: String }

#[derive(Debug, Clone, Serialize)]
pub struct PlanSound { pub kind: String, pub start: f64, pub end: f64, pub name: String, pub labels: Vec<String> }

#[derive(Debug, Clone, Serialize)]
pub struct PlanScene {
    pub title: String,
    pub start: f64,
    pub end: f64,
    pub lines: Vec<PlanLine>,
    pub sounds: Vec<PlanSound>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanCharacter {
    /// Speaker ids folded into this character (several for Extras).
    pub speaker_ids: Vec<String>,
    pub name: String,
    pub performer: Option<String>,
    pub extras: bool,
    pub speech_s: f64,
    pub reference_clips: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub title: String,
    pub scenes: Vec<PlanScene>,
    pub characters: Vec<PlanCharacter>,
    pub rows: usize,
    /// Upper bound — silent remainders are skipped at build time.
    pub est_bytes: u64,
    pub duration_s: f64,
}

/// Lightweight plan for the wizard (no per-line detail).
#[derive(Debug, Clone, Serialize)]
pub struct PlanSummary {
    pub title: String,
    pub scenes: Vec<SceneSummary>,
    pub characters: Vec<PlanCharacter>,
    pub rows: usize,
    pub est_bytes: u64,
    pub free_bytes: Option<u64>,
    pub duration_s: f64,
    pub chapters: Vec<ChapterSummary>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SceneSummary { pub title: String, pub start: f64, pub end: f64, pub lines: usize, pub sounds: usize }
#[derive(Debug, Clone, Serialize)]
pub struct ChapterSummary { pub index: usize, pub title: String, pub start: f64, pub end: f64 }

fn clean_chapter_title(t: &str) -> String {
    // "02 - Matthew Cuthbert is Surprised" → "Matthew Cuthbert is Surprised"
    let s = t.trim();
    let stripped = s
        .trim_start_matches(|c: char| c.is_ascii_digit())
        .trim_start_matches([' ', '-', '.', ':', '–', '—']);
    if stripped.len() < s.len() && !stripped.trim().is_empty() { stripped.trim().to_string() } else { s.to_string() }
}

/// Consecutive turns by the same voice with a short gap become one line.
fn merge_lines(turns: &[&Turn]) -> Vec<PlanLine> {
    let mut out: Vec<PlanLine> = Vec::new();
    for t in turns {
        if let Some(last) = out.last_mut() {
            if last.speaker == t.speaker && t.start - last.end <= 1.0 && t.end - last.start <= 30.0 {
                last.end = last.end.max(t.end);
                if !t.text.trim().is_empty() {
                    if !last.text.is_empty() { last.text.push(' '); }
                    last.text.push_str(t.text.trim());
                }
                continue;
            }
        }
        out.push(PlanLine { speaker: t.speaker.clone(), start: t.start, end: t.end, text: t.text.trim().to_string() });
    }
    out
}

/// Cut a section into scenes at pauses once it runs long, so a scene never
/// has more rows (= ffmpeg inputs) than the renderer can open.
fn split_section(a: f64, b: f64, lines: &[PlanLine], max_s: f64, max_lines: usize) -> Vec<(f64, f64)> {
    let mut cuts = vec![a];
    let mut count = 0usize;
    let mut prev_end = a;
    for l in lines {
        let since = l.start - cuts.last().unwrap();
        let long = since >= max_s || count >= max_lines;
        let pause = l.start - prev_end >= 1.0;
        if count > 0 && ((long && pause) || since >= max_s * 1.5 || count >= max_lines * 3 / 2) {
            let cut = if l.start > prev_end { (prev_end + l.start) / 2.0 } else { l.start };
            if cut > *cuts.last().unwrap() + 1.0 && cut < b - 1.0 {
                cuts.push(cut);
                count = 0;
            }
        }
        count += 1;
        prev_end = prev_end.max(l.end);
    }
    // A short tail folds back into the scene before it (a split once left a
    // 6-second, one-line scene at the end of a chapter).
    if cuts.len() > 2 && b - cuts[cuts.len() - 1] < (0.25 * max_s).min(120.0) {
        cuts.pop();
    }
    cuts.push(b);
    cuts.windows(2).map(|w| (w[0], w[1])).collect()
}

fn plan(m: &Manifest, opts: &RebuildOptions) -> Result<Plan> {
    let wanted: Option<HashSet<usize>> = opts.chapters.as_ref().filter(|c| !c.is_empty()).map(|c| c.iter().copied().collect());
    let mut sections: Vec<(f64, f64, String)> = Vec::new();
    if m.chapters.is_empty() {
        sections.push((0.0, m.duration_s, String::new()));
    } else {
        for (i, c) in m.chapters.iter().enumerate() {
            if wanted.as_ref().is_none_or(|w| w.contains(&i)) {
                sections.push((c.start, c.end.min(m.duration_s), clean_chapter_title(&c.title)));
            }
        }
    }
    if sections.is_empty() {
        return Err(Error::Other("no chapters selected".into()));
    }

    let mut turns: Vec<&Turn> = m.turns.iter().collect();
    turns.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    let sounds = m.sounds.clone().unwrap_or_default();
    let all_sounds: Vec<&Sound> = sounds.sfx.iter().chain(sounds.ambience.iter()).chain(sounds.music.iter()).collect();

    let max_s = opts.max_scene_minutes.max(1.0) * 60.0;
    let mut scenes = Vec::new();
    for (a, b, title) in &sections {
        let sec_turns: Vec<&Turn> = turns.iter().copied().filter(|t| t.start >= *a && t.start < *b).collect();
        let lines = merge_lines(&sec_turns);
        let parts = split_section(*a, *b, &lines, max_s, opts.max_scene_lines.max(10));
        let n = parts.len();
        for (k, (s0, s1)) in parts.into_iter().enumerate() {
            let base = if title.is_empty() { format!("Part {}", scenes.len() + 1) } else { title.clone() };
            let scene_title = if n > 1 { format!("{} · {}", base, k + 1) } else { base };
            let scene_lines: Vec<PlanLine> = lines.iter()
                .filter(|l| l.start >= s0 && l.start < s1)
                .map(|l| PlanLine { end: l.end.min(s1), ..l.clone() })
                .filter(|l| l.end - l.start > 0.05)
                .collect();
            let scene_sounds: Vec<PlanSound> = if opts.include_sounds {
                all_sounds.iter()
                    .filter(|x| x.end > s0 && x.start < s1)
                    .map(|x| PlanSound {
                        kind: x.kind.clone(),
                        start: x.start.max(s0),
                        end: x.end.min(s1),
                        name: x.name.clone(),
                        labels: x.labels.iter().map(|l| l.label.clone()).collect(),
                    })
                    .filter(|x| x.end - x.start >= 0.1)
                    .collect()
            } else { vec![] };
            scenes.push(PlanScene { title: scene_title, start: s0, end: s1, lines: scene_lines, sounds: scene_sounds });
        }
    }

    // Characters: substantial voices get their own; the rest share Extras.
    let present: HashSet<&str> = scenes.iter().flat_map(|s| s.lines.iter().map(|l| l.speaker.as_str())).collect();
    // 60 s suits a book; in a 5-minute scene a 48 s part is a lead. Scale with
    // the recording: at most the configured threshold, ≥ 10 s, 5 % of speech.
    let total_speech: f64 = m.speakers.iter().map(|s| s.total_speech_s).sum();
    let min_speech = opts.min_character_speech_s.min((0.05 * total_speech).max(10.0));
    let mut characters: Vec<PlanCharacter> = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();
    let mut extras = PlanCharacter { speaker_ids: vec![], name: "Extras".into(), performer: None, extras: true, speech_s: 0.0, reference_clips: 0 };
    for sp in &m.speakers {
        if !present.contains(sp.id.as_str()) { continue; }
        if sp.total_speech_s < min_speech {
            extras.speaker_ids.push(sp.id.clone());
            extras.speech_s += sp.total_speech_s;
            continue;
        }
        let credit = sp.credits.first();
        let mut name = credit.map(|c| c.character.clone()).unwrap_or_else(|| sp.label.clone());
        let base = name.clone();
        let mut k = 2;
        while !used_names.insert(name.to_lowercase()) {
            name = format!("{} {}", base, k);
            k += 1;
        }
        characters.push(PlanCharacter {
            speaker_ids: vec![sp.id.clone()],
            name,
            performer: credit.map(|c| c.performer.clone()),
            extras: false,
            speech_s: sp.total_speech_s,
            reference_clips: sp.candidates.len().min(3),
        });
    }
    if !extras.speaker_ids.is_empty() {
        characters.push(extras);
    }

    // Size estimate (upper bound) and row count.
    let mut frames = 0f64;
    let mut rows = 0usize;
    let stems_present = |s: &str| m.stems.contains_key(s);
    for s in &scenes {
        let dur = s.end - s.start;
        frames += s.lines.iter().map(|l| l.end - l.start).sum::<f64>();
        frames += s.sounds.iter().map(|x| x.end - x.start).sum::<f64>();
        rows += s.lines.len() + s.sounds.len();
        if opts.include_remainders {
            for stem in ["dialogue", "effects", "music"] {
                if stems_present(stem) {
                    frames += dur;
                    rows += 1;
                }
            }
        }
    }
    let title = opts.title.clone().filter(|t| !t.trim().is_empty())
        .or_else(|| m.source_tags.get("album").cloned())
        .or_else(|| m.source_tags.get("title").cloned())
        .unwrap_or_else(|| Path::new(&m.source_name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Rebuilt project".into()));
    Ok(Plan {
        title,
        est_bytes: (frames * SR as f64 * BYTES_PER_FRAME) as u64,
        rows,
        duration_s: scenes.iter().map(|s| s.end - s.start).sum(),
        scenes,
        characters,
    })
}

// ── Interval partitioning ─────────────────────────────────────────────────

type Span = (u64, u64);

/// `want` minus the (sorted, disjoint) `taken` spans.
fn subtract(want: Span, taken: &[Span]) -> Vec<Span> {
    let mut out = Vec::new();
    let mut cur = want.0;
    for &(a, b) in taken {
        if b <= cur || a >= want.1 { continue; }
        if a > cur { out.push((cur, a.min(want.1))); }
        cur = cur.max(b);
        if cur >= want.1 { break; }
    }
    if cur < want.1 { out.push((cur, want.1)); }
    out
}

fn insert_disjoint(set: &mut Vec<Span>, add: &[Span]) {
    set.extend_from_slice(add);
    set.sort();
    let mut merged: Vec<Span> = Vec::with_capacity(set.len());
    for &(a, b) in set.iter() {
        if let Some(last) = merged.last_mut() {
            if a <= last.1 { last.1 = last.1.max(b); continue; }
        }
        merged.push((a, b));
    }
    *set = merged;
}

/// Assign every frame to at most one item, highest priority first (lower
/// number wins; ties by start). Returns each item's owned segments and the
/// union of everything owned.
fn partition(spans: &[(Span, u32)]) -> (Vec<Vec<Span>>, Vec<Span>) {
    let mut order: Vec<usize> = (0..spans.len()).collect();
    order.sort_by_key(|&i| (spans[i].1, spans[i].0 .0));
    let mut claimed: Vec<Span> = Vec::new();
    let mut owned = vec![Vec::new(); spans.len()];
    for i in order {
        let segs = subtract(spans[i].0, &claimed);
        insert_disjoint(&mut claimed, &segs);
        owned[i] = segs;
    }
    (owned, claimed)
}

// ── Stem splitting (streaming) ────────────────────────────────────────────

struct Piece {
    span: Span,
    owned: Vec<Span>,
    path: PathBuf,
}

struct SplitResult {
    /// Frames written per piece, and whether the remainder was kept.
    remainder_kept: bool,
}

/// One output clip, buffered as 24-bit stereo and written as FLAC when it's
/// finished. FLAC is lossless — same samples as a 24-bit WAV, matching the
/// 24-bit stems — and stores the long stretches of digital silence in
/// itemised stems almost for free. A clip is written mono only when its two
/// channels are bit-identical (a mono source's stems are dual-mono), so the
/// stereo field is never touched.
struct Clip {
    path: PathBuf,
    pcm: Vec<i32>,
    dual_mono: bool,
}

fn to_i24(x: f32) -> i32 {
    (x.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32
}

impl Clip {
    fn new(path: &Path) -> Self {
        Clip { path: path.to_path_buf(), pcm: Vec::new(), dual_mono: true }
    }

    fn push(&mut self, l: f32, r: f32) {
        let (a, b) = (to_i24(l), to_i24(r));
        self.dual_mono &= a == b;
        self.pcm.push(a);
        self.pcm.push(b);
    }

    fn finish(self) -> Result<()> {
        let channels = if self.dual_mono { 1 } else { 2 };
        write_flac(&self.path, &self.pcm, channels)
    }
}

/// flacenc source over interleaved stereo 24-bit samples, yielding `channels` (1 = left only).
struct PcmSource<'a> {
    pcm: &'a [i32],
    channels: usize,
    head: usize, // frame
    scratch: Vec<i32>,
}

impl flacenc::source::Source for PcmSource<'_> {
    fn channels(&self) -> usize { self.channels }
    fn bits_per_sample(&self) -> usize { 24 }
    fn sample_rate(&self) -> usize { SR as usize }
    fn read_samples<F: flacenc::source::Fill>(&mut self, block_size: usize, dest: &mut F) -> std::result::Result<usize, flacenc::error::SourceError> {
        let frames = self.pcm.len() / 2;
        let end = (self.head + block_size).min(frames);
        self.scratch.clear();
        for f in self.head..end {
            self.scratch.push(self.pcm[2 * f]);
            if self.channels == 2 {
                self.scratch.push(self.pcm[2 * f + 1]);
            }
        }
        dest.fill_interleaved(&self.scratch)?;
        let n = end - self.head;
        self.head = end;
        Ok(n)
    }
    fn len_hint(&self) -> Option<usize> { Some(self.pcm.len() / 2) }
}

/// flacenc records the short final block as STREAMINFO's minimum block size,
/// so a fixed-blocksize stream reads as variable (min 288, max 4096). Apple's
/// decoder — WebKit's <audio>, i.e. every preview in the app — then reports a
/// 0 s duration and play() never starts. The reference encoder writes
/// min == max for fixed-blocksize streams; do the same.
pub fn fix_min_block_size(bytes: &mut [u8]) -> bool {
    // "fLaC", then the STREAMINFO block header (4 bytes): min at 8..10, max at 10..12.
    if bytes.len() < 12 || &bytes[..4] != b"fLaC" || bytes[4] & 0x7f != 0 || bytes[8..10] == bytes[10..12] {
        return false;
    }
    let (min, max) = bytes.split_at_mut(10);
    min[8..10].copy_from_slice(&max[..2]);
    true
}

fn write_flac(path: &Path, pcm: &[i32], channels: usize) -> Result<()> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| Error::Other(format!("flac config: {:?}", e)))?;
    let source = PcmSource { pcm, channels, head: 0, scratch: Vec::new() };
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| Error::Other(format!("flac encode {}: {:?}", path.display(), e)))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| Error::Other(format!("flac write: {:?}", e)))?;
    let mut bytes = sink.as_slice().to_vec();
    fix_min_block_size(&mut bytes);
    std::fs::write(path, bytes)?;
    Ok(())
}

fn in_spans(spans: &[Span], cursor: &mut usize, f: u64) -> bool {
    while *cursor < spans.len() && spans[*cursor].1 <= f { *cursor += 1; }
    *cursor < spans.len() && spans[*cursor].0 <= f
}

/// Decode [t0, t1) of a stem once and write every piece plus the remainder.
fn split_stem(stem: &Path, t0: f64, t1: f64, pieces: &[Piece], claimed: &[Span], remainder: Option<&Path>) -> Result<SplitResult> {
    let mut child = Command::new("ffmpeg")
        .args(["-nostdin", "-loglevel", "error", "-ss", &format!("{:.6}", t0), "-t", &format!("{:.6}", t1 - t0), "-i"])
        .arg(stem)
        .args(["-ac", "2", "-ar", &SR.to_string(), "-f", "f32le", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Other(format!("could not run ffmpeg: {}", e)))?;
    let mut out = BufReader::with_capacity(1 << 20, child.stdout.take().unwrap());

    let mut order: Vec<usize> = (0..pieces.len()).collect();
    order.sort_by_key(|&i| pieces[i].span.0);
    let mut next = 0usize; // next piece (in `order`) to open
    let mut active: Vec<(usize, Clip, usize)> = Vec::new();
    let mut rem = remainder.map(Clip::new);
    let mut rem_cursor = 0usize;
    let mut rem_nonzero = false;
    let mut f: u64 = 0;
    let mut buf = vec![0u8; 8 * 8192];

    loop {
        let n = out.read(&mut buf).map_err(|e| Error::Other(format!("ffmpeg read: {}", e)))?;
        if n == 0 { break; }
        let mut usable = n - n % 8;
        // Keep frames whole across reads.
        if usable < n {
            let extra = n - usable;
            let mut tail = vec![0u8; 8 - extra];
            out.read_exact(&mut tail).ok();
            buf[n..n + tail.len()].copy_from_slice(&tail);
            usable = n + tail.len();
        }
        for chunk in buf[..usable].chunks_exact(8) {
            let l = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let r = f32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
            while next < order.len() && pieces[order[next]].span.0 <= f {
                let i = order[next];
                active.push((i, Clip::new(&pieces[i].path), 0));
                next += 1;
            }
            let mut k = 0;
            while k < active.len() {
                let i = active[k].0;
                if f >= pieces[i].span.1 {
                    let (_, w, _) = active.swap_remove(k);
                    w.finish()?;
                    continue;
                }
                let owned = in_spans(&pieces[i].owned, &mut active[k].2, f);
                let (wl, wr) = if owned { (l, r) } else { (0.0, 0.0) };
                active[k].1.push(wl, wr);
                k += 1;
            }
            if let Some(w) = rem.as_mut() {
                let covered = in_spans(claimed, &mut rem_cursor, f);
                let (rl, rr) = if covered { (0.0, 0.0) } else { (l, r) };
                if !covered && !rem_nonzero {
                    rem_nonzero = to_i24(rl) != 0 || to_i24(rr) != 0;
                }
                w.push(rl, rr);
            }
            f += 1;
        }
    }
    for (_, w, _) in active.drain(..) {
        w.finish()?;
    }
    // Pieces that start past the decoded end still need a (silent) file.
    while next < order.len() {
        Clip::new(&pieces[order[next]].path).finish()?;
        next += 1;
    }
    let status = child.wait().map_err(|e| Error::Other(format!("ffmpeg: {}", e)))?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() { let _ = e.read_to_string(&mut err); }
        return Err(Error::Other(format!("ffmpeg failed decoding {}: {}", stem.display(), &err[..err.len().min(400)])));
    }
    let mut remainder_kept = false;
    if let Some(w) = rem {
        w.finish()?;
        // Dropped only when it's digital silence: any signal at all, however
        // quiet, is part of the original and stays.
        remainder_kept = rem_nonzero;
        if !remainder_kept {
            if let Some(p) = remainder { let _ = std::fs::remove_file(p); }
        }
    }
    Ok(SplitResult { remainder_kept })
}

// ── Build ─────────────────────────────────────────────────────────────────

fn slugify(s: &str) -> String {
    let out: String = s.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let parts: Vec<&str> = out.split('_').filter(|p| !p.is_empty()).collect();
    let joined = parts.join("_");
    joined.chars().take(40).collect::<String>().trim_end_matches('_').to_string()
}

fn short_id() -> String {
    let s = Uuid::new_v4().simple().to_string();
    format!("r-{}", &s[..6])
}

fn ms(frames: u64) -> u64 { frames * 1000 / SR as u64 }

#[allow(clippy::too_many_arguments)]
fn base_row(scene_no: &str, track: &str, kind: &str, character: &str, prompt: &str, file: &str, start_f: u64, len_f: u64, note: &str) -> (ScriptRow, String) {
    let id = short_id();
    let row = ScriptRow {
        scene: scene_no.into(),
        track: track.into(),
        track_type: kind.into(),
        character: character.into(),
        prompt: prompt.into(),
        file: file.into(),
        start_ms: ms(start_f).to_string(),
        duration_ms: ms(len_f).to_string(),
        r#loop: "false".into(),
        pan: "0".into(),
        gain_db: "0".into(),
        instruct: String::new(),
        // No fades: pieces and remainders tile the stem exactly.
        fade_in_ms: "0".into(),
        fade_out_ms: "0".into(),
        reverb_send: "0".into(),
        emotion: String::new(),
        // mix:as-is — the renderer leaves these out of ducking / bus trims:
        // the source mix already has its balance.
        notes: format!("id:{}; mix:as-is; {}", id, note),
        gain_envelope: String::new(),
        spatial_azimuth: String::new(),
        spatial_elevation: String::new(),
        spatial_path: String::new(),
        spatial_space: String::new(),
    };
    (row, id)
}

fn fountain_line(kind: &str, name: &str, text: &str, id: &str) -> String {
    match kind {
        "DIALOGUE" => format!("{} [[id:{}]]\n{}\n", name.to_uppercase(), id, if text.is_empty() { "(unintelligible)" } else { text }),
        "SFX" | "BED" | "MUSIC" => format!("{}: {} [[id:{}]]\n", kind, text, id),
        _ => format!("{} [[id:{}]]\n", text, id),
    }
}

fn new_project_character(id: &str, name: &str, description: &str) -> Character {
    Character {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        voice_assignment: VoiceAssignment {
            model: "Chatterbox".into(),
            speaker: None,
            instruct_default: None,
            ref_audio_path: None,
            ref_audio_sources: vec![],
            ref_transcript: None,
            base_voice_description: String::new(),
            emotional_palette: vec![],
            production_pipeline: "chatterbox".into(),
            rvc: None,
            rvc_model_path: None,
            rvc_index_path: None,
            rvc_pitch_shift: 0,
            rvc_index_rate: 0.5,
            rvc_protect: 0.33,
            rvc_enabled: false,
            audiosr: false,
        },
        schema_version: CURRENT_CHARACTER_SCHEMA,
        library_id: None,
        library_version: None,
        voice_provenance: vec![],
    }
}

pub type Progress<'a> = &'a (dyn Fn(f32, &str) + Sync);

/// Build the project. Returns its id. A failed build removes its directory,
/// so a half-made project never shows up in the launcher.
fn build(projects_dir: &Path, import_id: &str, import_dir: &Path, m: &Manifest, p: &Plan, opts: &RebuildOptions, progress: Progress) -> Result<String> {
    let project_id = Uuid::new_v4().to_string();
    let root = project_dir(projects_dir, &project_id);
    match build_into(&root, &project_id, import_id, import_dir, m, p, opts, progress) {
        Ok(()) => Ok(project_id),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&root);
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_into(root: &Path, project_id: &str, import_id: &str, import_dir: &Path, m: &Manifest, p: &Plan, opts: &RebuildOptions, progress: Progress) -> Result<()> {
    let project_id = project_id.to_string();
    let root = root.to_path_buf();
    std::fs::create_dir_all(root.join("scenes"))?;
    std::fs::create_dir_all(root.join("output"))?;
    let now = Utc::now();
    let statement = opts.rights_statement.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| DEFAULT_RIGHTS_STATEMENT.to_string());

    // Characters + voice references.
    progress(0.01, "Creating characters");
    let mut char_of_speaker: HashMap<String, (String, String)> = HashMap::new(); // speaker → (char id, name)
    let mut characters = Vec::new();
    let speakers: HashMap<&str, &Speaker> = m.speakers.iter().map(|s| (s.id.as_str(), s)).collect();
    for pc in &p.characters {
        let cid = format!("CHAR_{}", &Uuid::new_v4().simple().to_string()[..6].to_ascii_uppercase());
        let desc = if pc.extras {
            format!("Minor voices from {} ({} speakers).", m.source_name, pc.speaker_ids.len())
        } else {
            format!("Voice from {} ({}).", m.source_name, pc.speaker_ids.join(", "))
        };
        let mut c = new_project_character(&cid, &pc.name, &desc);
        if !pc.extras {
            if let Some(sp) = speakers.get(pc.speaker_ids[0].as_str()) {
                let dir = root.join("characters").join(&cid).join("imports");
                std::fs::create_dir_all(&dir)?;
                let mut clips = Vec::new();
                for (k, cand) in sp.candidates.iter().take(3).enumerate() {
                    let src = import_dir.join(&cand.path);
                    if !src.starts_with(import_dir) || !src.is_file() { continue; }
                    let dest = dir.join(format!("dissect_{}_{}.wav", &import_id[..8], k + 1));
                    std::fs::copy(&src, &dest)?;
                    let d = dest.to_string_lossy().into_owned();
                    if k == 0 {
                        c.voice_assignment.ref_audio_path = Some(d.clone());
                        c.voice_assignment.ref_transcript = Some(cand.transcript.clone()).filter(|t| !t.is_empty());
                    }
                    c.voice_assignment.ref_audio_sources.push(d);
                    clips.push(format!("imports/{}", dest.file_name().unwrap().to_string_lossy()));
                }
                c.voice_provenance.push(VoiceProvenance {
                    kind: "dissect".into(),
                    source_name: m.source_name.clone(),
                    import_id: import_id.to_string(),
                    speaker_id: sp.id.clone(),
                    clips,
                    performer: pc.performer.clone(),
                    rights_statement: statement.clone(),
                    rights_confirmed_at: now.to_rfc3339(),
                });
                // An emotional palette from the performance, when its emotions were read.
                if let Err(e) = crate::commands::emotions::fill_palette(
                    root.parent().unwrap_or(&root), &mut c, &root.join("characters").join(&cid), &crate::commands::emotions::FillOptions::default(),
                ) {
                    eprintln!("palette fill skipped for {}: {}", c.name, e);
                }
            }
        }
        for sid in &pc.speaker_ids {
            char_of_speaker.insert(sid.clone(), (cid.clone(), pc.name.clone()));
        }
        characters.push(c);
    }

    let project = Project {
        id: project_id.clone(),
        title: p.title.clone(),
        logline: m.source_tags.get("comment").cloned().unwrap_or_default().chars().take(300).collect(),
        synopsis: m.source_tags.get("description").cloned().unwrap_or_default(),
        tone: String::new(),
        global_audio_notes: format!("Rebuilt from {} by Dissect (import {}). Rows carry no fades or gain: the clips and remainder beds tile each stem, so the scenes render back to the source.", m.source_name, import_id),
        target_duration_minutes: (p.duration_s / 60.0).round().max(1.0) as u32,
        created_at: now,
        updated_at: now,
        characters: characters.clone(),
        llm_config: LlmConfig { provider: "anthropic".into(), model: "claude-sonnet-4-6".into(), api_key_env: "ANTHROPIC_API_KEY".into() },
    };
    write_json(&root.join("project.json"), &project)?;

    // Scenes.
    let stem_file = |s: &str| m.stems.get(s).map(|rel| import_dir.join(rel)).filter(|p| p.is_file());
    let mut scenes_out = Vec::new();
    let total = p.scenes.len().max(1) as f32;
    for (si, s) in p.scenes.iter().enumerate() {
        let slug = format!("{:02}_{}", si, { let x = slugify(&s.title); if x.is_empty() { "scene".into() } else { x } });
        let scene_no = format!("S{:02}", si + 1);
        let sdir = root.join("scenes").join(&slug);
        let assets = sdir.join("assets");
        std::fs::create_dir_all(&assets)?;
        std::fs::create_dir_all(sdir.join("render"))?;
        let to_f = |t: f64| (((t - s.start).max(0.0)) * SR as f64).round() as u64;
        let mut rows: Vec<(ScriptRow, String, String, String)> = Vec::new(); // row, id, display name, text
        let label = |stage: &str| format!("Scene {} of {} · {}", si + 1, p.scenes.len(), stage);

        // dialogue: lines (priority by start)
        if let Some(stem) = stem_file("dialogue") {
            progress((si as f32 + 0.1) / total, &label("dialogue"));
            let spans: Vec<(Span, u32)> = s.lines.iter().map(|l| ((to_f(l.start), to_f(l.end).max(to_f(l.start) + 1)), 0)).collect();
            let (owned, claimed) = partition(&spans);
            let mut pieces = Vec::new();
            let mut counters: HashMap<String, usize> = HashMap::new();
            for (i, l) in s.lines.iter().enumerate() {
                let (cid, name) = char_of_speaker.get(&l.speaker).cloned().unwrap_or_else(|| (String::new(), l.speaker.clone()));
                let n = counters.entry(cid.clone()).or_insert(0);
                *n += 1;
                let file = assets.join(format!("{}_{:03}.dissect.flac", slugify(&name), n));
                pieces.push(Piece { span: spans[i].0, owned: owned[i].clone(), path: file.clone() });
                let track = if cid.is_empty() { "dialogue".to_string() } else { cid.to_lowercase() };
                let (row, id) = base_row(&scene_no, &track, "DIALOGUE", &cid, &l.text, &file.to_string_lossy(), spans[i].0 .0, spans[i].0 .1 - spans[i].0 .0, &format!("dissect {} @{:.2}s", l.speaker, l.start));
                rows.push((row, id, name, l.text.clone()));
            }
            let rem = opts.include_remainders.then(|| assets.join("room_tone_and_unassigned.dissect.flac"));
            let res = split_stem(&stem, s.start, s.end, &pieces, &claimed, rem.as_deref())?;
            if let (Some(rp), true) = (rem, res.remainder_kept) {
                let (row, id) = base_row(&scene_no, "room", "BED", "", "Room tone & unassigned speech (original)", &rp.to_string_lossy(), 0, to_f(s.end), "dissect remainder: dialogue");
                rows.push((row, id, String::new(), "Room tone & unassigned speech (original)".into()));
            }
        }

        // effects: sfx (priority 0) over ambience (1); music: cues
        for (stem_name, kinds) in [("effects", vec!["sfx", "ambience"]), ("music", vec!["music"])] {
            let Some(stem) = stem_file(stem_name) else { continue };
            progress((si as f32 + if stem_name == "effects" { 0.5 } else { 0.8 }) / total, &label(stem_name));
            let items: Vec<&PlanSound> = s.sounds.iter().filter(|x| kinds.contains(&x.kind.as_str())).collect();
            let spans: Vec<(Span, u32)> = items.iter().map(|x| {
                let pri = if x.kind == "sfx" { 0 } else { 1 };
                ((to_f(x.start), to_f(x.end).max(to_f(x.start) + 1)), pri)
            }).collect();
            let (owned, claimed) = partition(&spans);
            let mut pieces = Vec::new();
            for (i, x) in items.iter().enumerate() {
                let file = assets.join(format!("{}_{}_{}.dissect.flac", x.kind, i + 1, slugify(&x.name)));
                pieces.push(Piece { span: spans[i].0, owned: owned[i].clone(), path: file.clone() });
                let (kind, track) = match x.kind.as_str() { "sfx" => ("SFX", "FOLEY"), "ambience" => ("BED", "FOLEY"), _ => ("MUSIC", "MUSIC") };
                let mut prompt = x.name.clone();
                if !x.labels.is_empty() && x.labels.len() > 2 { prompt = format!("{} ({})", x.name, x.labels[2..].join(", ")); }
                let (row, id) = base_row(&scene_no, track, kind, "", &prompt, &file.to_string_lossy(), spans[i].0 .0, spans[i].0 .1 - spans[i].0 .0, &format!("dissect {} @{:.2}s", x.kind, x.start));
                rows.push((row, id, String::new(), prompt));
            }
            let rem = opts.include_remainders.then(|| assets.join(format!("{}_remainder.dissect.flac", stem_name)));
            let res = split_stem(&stem, s.start, s.end, &pieces, &claimed, rem.as_deref())?;
            if let (Some(rp), true) = (rem, res.remainder_kept) {
                let (kind, track, text) = if stem_name == "music" {
                    ("MUSIC", "MUSIC", "Music bed (original remainder)")
                } else {
                    ("BED", "FOLEY", "Effects bed (original remainder)")
                };
                let (row, id) = base_row(&scene_no, track, kind, "", text, &rp.to_string_lossy(), 0, to_f(s.end), &format!("dissect remainder: {}", stem_name));
                rows.push((row, id, String::new(), text.into()));
            }
        }

        rows.sort_by_key(|r| r.0.start_ms.parse::<u64>().unwrap_or(0));
        let script_rows: Vec<ScriptRow> = rows.iter().map(|r| r.0.clone()).collect();
        write_script_rows(&sdir.join("script.csv"), &script_rows)?;
        let fountain: String = rows.iter().map(|(r, id, name, text)| fountain_line(&r.track_type, name, text, id)).collect::<Vec<_>>().join("\n");
        std::fs::write(sdir.join("script.fountain"), fountain)?;

        let mut names: Vec<String> = Vec::new();
        for l in &s.lines {
            if let Some((_, n)) = char_of_speaker.get(&l.speaker) {
                if !names.contains(n) { names.push(n.clone()); }
            }
        }
        scenes_out.push(Scene {
            id: Uuid::new_v4().to_string(),
            index: si as u32,
            slug,
            title: s.title.clone(),
            description: s.lines.iter().find(|l| !l.text.is_empty()).map(|l| l.text.chars().take(200).collect()).unwrap_or_default(),
            location: String::new(),
            characters: names,
            notes: format!("{}–{} of {}", fmt_hms(s.start), fmt_hms(s.end), m.source_name),
            connects_from: None,
            connects_to: None,
            status: SceneStatus::AssetsReady,
            tension: None,
        });
    }
    write_json(&root.join("storyboard.json"), &Storyboard { scenes: scenes_out })?;
    progress(1.0, "Done");
    let _ = project_id;
    Ok(())
}

fn fmt_hms(s: f64) -> String {
    let s = s.max(0.0) as u64;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

// ── Disk ──────────────────────────────────────────────────────────────────

pub fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 { return None; }
        Some(st.f_bavail as u64 * st.f_frsize as u64)
    }
    #[cfg(not(unix))]
    { let _ = path; None }
}

// ── Commands ──────────────────────────────────────────────────────────────

fn load(projects_dir: &Path, import_id: &str) -> Result<(PathBuf, Manifest)> {
    if Uuid::parse_str(import_id).is_err() {
        return Err(Error::Other(format!("invalid import id '{}'", import_id)));
    }
    let dir = imports_root(projects_dir).join(import_id);
    let m: Manifest = read_json(&dir.join("manifest.json"))
        .map_err(|_| Error::Other("this import has not finished (no manifest yet)".into()))?;
    Ok((dir, m))
}

pub fn plan_for(projects_dir: &Path, import_id: &str, opts: &RebuildOptions) -> Result<PlanSummary> {
    let (_, m) = load(projects_dir, import_id)?;
    let p = plan(&m, opts)?;
    Ok(PlanSummary {
        title: p.title.clone(),
        scenes: p.scenes.iter().map(|s| SceneSummary { title: s.title.clone(), start: s.start, end: s.end, lines: s.lines.len(), sounds: s.sounds.len() }).collect(),
        characters: p.characters.clone(),
        rows: p.rows,
        est_bytes: p.est_bytes,
        free_bytes: free_bytes(projects_dir),
        duration_s: p.duration_s,
        chapters: m.chapters.iter().enumerate().map(|(i, c)| ChapterSummary { index: i, title: clean_chapter_title(&c.title), start: c.start, end: c.end }).collect(),
    })
}

/// Run a rebuild synchronously (CLI, tests). Returns the new project id.
pub fn rebuild(projects_dir: &Path, import_id: &str, opts: &RebuildOptions, progress: Progress) -> Result<String> {
    if !opts.rights_confirmed {
        return Err(Error::Other("confirm you have the rights to this recording before rebuilding it — the project reproduces its performances".into()));
    }
    let (dir, m) = load(projects_dir, import_id)?;
    let p = plan(&m, opts)?;
    if let Some(free) = free_bytes(projects_dir) {
        if p.est_bytes + (2u64 << 30) > free {
            return Err(Error::Other(format!(
                "not enough disk: this rebuild needs up to {:.1} GB and {:.1} GB is free — pick fewer chapters",
                p.est_bytes as f64 / 1e9, free as f64 / 1e9
            )));
        }
    }
    build(projects_dir, import_id, &dir, &m, &p, opts, progress)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RebuildStatus {
    pub progress: f32,
    pub message: String,
    pub done: bool,
    pub error: Option<String>,
    pub project_id: Option<String>,
    pub title: String,
}

fn jobs() -> &'static Mutex<HashMap<String, RebuildStatus>> {
    static J: OnceLock<Mutex<HashMap<String, RebuildStatus>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_job(id: &str, f: impl FnOnce(&mut RebuildStatus)) {
    if let Ok(mut m) = jobs().lock() {
        if let Some(j) = m.get_mut(id) { f(j); }
    }
}

#[tauri::command]
pub fn dissect_rebuild_plan(app: AppHandle, import_id: String, options: Option<RebuildOptions>) -> Result<PlanSummary> {
    plan_for(&app_projects_dir(&app)?, &import_id, &options.unwrap_or_default())
}

/// Start a rebuild in the background. Poll `dissect_rebuild_status`.
#[tauri::command]
pub async fn dissect_rebuild_start(app: AppHandle, import_id: String, options: RebuildOptions) -> Result<String> {
    if !options.rights_confirmed {
        return Err(Error::Other("confirm you have the rights to this recording first".into()));
    }
    let projects_dir = app_projects_dir(&app)?;
    let summary = plan_for(&projects_dir, &import_id, &options)?;
    let job_id = Uuid::new_v4().to_string();
    jobs().lock().map_err(|_| Error::Other("lock".into()))?.insert(job_id.clone(), RebuildStatus {
        message: "Starting".into(), title: summary.title.clone(), ..Default::default()
    });
    let jid = job_id.clone();
    tokio::task::spawn_blocking(move || {
        let cb = |f: f32, msg: &str| set_job(&jid, |j| { j.progress = f; j.message = msg.to_string(); });
        let res = rebuild(&projects_dir, &import_id, &options, &cb);
        set_job(&jid, |j| {
            j.done = true;
            match res {
                Ok(pid) => { j.project_id = Some(pid); j.progress = 1.0; j.message = "Done".into(); }
                Err(e) => { j.error = Some(e.to_string()); }
            }
        });
    });
    Ok(job_id)
}

#[tauri::command]
pub fn dissect_rebuild_status(job_id: String) -> Result<RebuildStatus> {
    jobs().lock().map_err(|_| Error::Other("lock".into()))?
        .get(&job_id).cloned()
        .ok_or_else(|| Error::Other("unknown rebuild job (the app was restarted?)".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_are_flac_and_mono_when_both_channels_match() {
        let dir = std::env::temp_dir().join(format!("pharaoh-rebuild-flac-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (mono, stereo, empty) = (dir.join("m.flac"), dir.join("s.flac"), dir.join("e.flac"));
        let mut m = Clip::new(&mono);
        let mut st = Clip::new(&stereo);
        for i in 0..10_000 {
            let x = (i as f32 * 0.01).sin() * 0.5;
            m.push(x, x);
            st.push(x, -x);
        }
        m.finish().unwrap();
        st.finish().unwrap();
        Clip::new(&empty).finish().unwrap();
        let p = |f: &PathBuf| f.to_string_lossy().into_owned();
        assert_eq!(crate::app_support::audio_channels(&p(&mono)), Some(1));
        assert_eq!(crate::app_support::audio_channels(&p(&stereo)), Some(2));
        assert_eq!(crate::app_support::wav_info(&p(&mono)).unwrap().frames, 10_000);
        // Fixed block size declared as such (min == max), or WebKit won't play it.
        let head = std::fs::read(&mono).unwrap();
        assert_eq!(head[8..10], head[10..12]);
        assert_eq!(crate::app_support::wav_info(&p(&mono)).unwrap().sample_rate, SR);
        // Lossless at 24 bits: samples come back within one quantisation step.
        let mut worst = 0f32;
        crate::app_support::for_each_flac_sample(&p(&stereo), 100, |f, c, v| {
            let x = ((f + 100) as f32 * 0.01).sin() * 0.5;
            worst = worst.max((v - if c == 0 { x } else { -x }).abs());
            true
        }).unwrap();
        assert!(worst < 1.0 / 8_000_000.0, "worst error {}", worst);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn subtract_and_partition_make_a_disjoint_tiling() {
        assert_eq!(subtract((0, 100), &[(10, 20), (50, 60)]), vec![(0, 10), (20, 50), (60, 100)]);
        assert_eq!(subtract((15, 55), &[(10, 20), (50, 60)]), vec![(20, 50)]);
        // sfx (pri 0) inside an ambience (pri 1): ambience gets a hole, union covers both.
        let (owned, claimed) = partition(&[((0, 100), 1), ((40, 50), 0)]);
        assert_eq!(owned[1], vec![(40, 50)]);
        assert_eq!(owned[0], vec![(0, 40), (50, 100)]);
        assert_eq!(claimed, vec![(0, 100)]);
        // Overlapping lines of equal priority: the earlier keeps the overlap.
        let (owned, _) = partition(&[((0, 60), 0), ((50, 90), 0)]);
        assert_eq!(owned, vec![vec![(0, 60)], vec![(60, 90)]]);
    }

    fn turn(s: &str, a: f64, b: f64, t: &str) -> Turn { Turn { speaker: s.into(), start: a, end: b, text: t.into() } }

    #[test]
    fn merges_same_voice_and_splits_long_sections_at_pauses() {
        let ts = vec![turn("S1", 0.0, 2.0, "a"), turn("S1", 2.5, 4.0, "b"), turn("S2", 4.2, 6.0, "c"), turn("S1", 9.0, 10.0, "d")];
        let refs: Vec<&Turn> = ts.iter().collect();
        let lines = merge_lines(&refs);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "a b");
        assert_eq!((lines[0].start, lines[0].end), (0.0, 4.0));

        // 40 lines over 400 s, max 60 s per scene → several scenes, cuts at pauses, full cover.
        let many: Vec<PlanLine> = (0..40).map(|i| PlanLine { speaker: "S1".into(), start: i as f64 * 10.0, end: i as f64 * 10.0 + 7.0, text: String::new() }).collect();
        let parts = split_section(0.0, 400.0, &many, 60.0, 120);
        assert!(parts.len() >= 5, "{:?}", parts);
        assert_eq!(parts.first().unwrap().0, 0.0);
        assert_eq!(parts.last().unwrap().1, 400.0);
        for w in parts.windows(2) { assert_eq!(w[0].1, w[1].0); }
        for (a, b) in &parts { assert!(b - a <= 95.0, "{} {}", a, b); }
        // Cuts land in pauses (between 7 and 10 s into a 10 s cell), never mid-line.
        for (a, _) in parts.iter().skip(1) { let r = a % 10.0; assert!(r > 7.0 && r < 10.0, "{}", a); }
    }

    #[test]
    fn short_tails_fold_into_the_previous_scene() {
        // Lines every 10 s for 1600 s, then one line just before the end:
        // a cut near 1600 would leave a 6 s scene.
        let mut ls: Vec<PlanLine> = (0..160).map(|i| PlanLine { speaker: "S1".into(), start: i as f64 * 10.0, end: i as f64 * 10.0 + 7.0, text: String::new() }).collect();
        ls.push(PlanLine { speaker: "S1".into(), start: 1601.0, end: 1604.0, text: String::new() });
        let parts = split_section(0.0, 1606.0, &ls, 720.0, 120);
        assert!(parts.iter().all(|(a, b)| b - a >= 120.0), "{:?}", parts);
        assert_eq!(parts.last().unwrap().1, 1606.0);
    }

    #[test]
    fn titles_lose_leading_numbers() {
        assert_eq!(clean_chapter_title("02 - Matthew Cuthbert is Surprised"), "Matthew Cuthbert is Surprised");
        assert_eq!(clean_chapter_title("Bright River"), "Bright River");
        assert_eq!(clean_chapter_title("1984"), "1984");
    }
}
