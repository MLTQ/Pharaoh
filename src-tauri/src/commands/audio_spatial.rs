//! Spatial (binaural) audio prerendering.
//!
//! ## What this module does
//!
//! Pharaoh stores spatial placement on each script row as three columns:
//!
//! - `spatial_azimuth`   — degrees in `[0, 360)`; 0 = front, 90 = right,
//!                         180 = back, 270 = left
//! - `spatial_elevation` — degrees in `[-90, +90]`; 0 = ear level,
//!                         +90 = directly above
//! - `spatial_path`      — JSON `[{t_frac, az, el}, ...]` waypoints for
//!                         moving sources (empty = static)
//!
//! When a row has spatial data set, the main scene renderer (in
//! `audio_engine.rs`) calls `prerender_spatialized_clip` *before* building
//! its `filter_complex` graph. The prerender writes a stereo binaural WAV
//! to a temp file alongside `scene_dir/.spatial/<row_index>.wav`, and the
//! main render substitutes that file in place of the original — with the
//! normal `pan` filter skipped, since the audio is already binaural.
//!
//! ## Why prerender rather than inline
//!
//! The static case (single `sofalizer` filter) is trivial to inline, but
//! the moving-source case needs `asplit` → N per-segment `sofalizer` →
//! `concat`, which forks the labelled-stream graph in ways that don't
//! compose cleanly with the existing dialogue/bed/music bus structure.
//! Prerendering gives each spatialized clip a self-contained ffmpeg
//! invocation and keeps the main graph identical to today's code.
//!
//! ## Engine selection
//!
//! At call time we look for a `.sofa` HRTF file under `assets/sofa/`. If one
//! is present we use ffmpeg's `sofalizer` filter (true HRTF-based binaural).
//! If none is present we fall back to a pure-ffmpeg ITD + ILD + HF-rolloff
//! approximation — not real HRTF, but better than amplitude panning and
//! works with zero external assets. See `assets/sofa/README.md` for the
//! one-time `download_sofa.sh` setup that installs the MIT KEMAR HRTF set.
//!
//! ## Trajectory rendering
//!
//! Moving sources discretize into ≤32 fixed segments along the clip
//! duration, each rendered at its own interpolated (az, el) and concatted
//! end-to-end. With segments shorter than ~150 ms the boundaries are
//! imperceptible for typical motion (footsteps, flyby, circling).

use crate::error::{Error, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// One waypoint on a spatial trajectory.
#[derive(Debug, Clone, Deserialize)]
pub struct Waypoint {
    /// Fraction of the clip duration this waypoint sits at, `[0, 1]`.
    pub t_frac: f32,
    /// Azimuth in degrees, `[0, 360)`. 0 = front, 90 = right.
    pub az: f32,
    /// Elevation in degrees, `[-90, +90]`. 0 = ear level.
    pub el: f32,
}

/// Parse the `spatial_path` JSON column. Tolerant of garbage — returns an
/// empty Vec on parse failure rather than erroring out, so a corrupt
/// trajectory falls back gracefully to the static azimuth/elevation.
pub fn parse_waypoints(json: &str) -> Vec<Waypoint> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let mut wps: Vec<Waypoint> = serde_json::from_str(trimmed).unwrap_or_default();
    // Clamp values so a hand-edited JSON can't break the renderer downstream.
    for wp in wps.iter_mut() {
        wp.t_frac = wp.t_frac.clamp(0.0, 1.0);
        wp.az = wp.az.rem_euclid(360.0);
        wp.el = wp.el.clamp(-90.0, 90.0);
    }
    wps.sort_by(|a, b| a.t_frac.partial_cmp(&b.t_frac).unwrap_or(std::cmp::Ordering::Equal));
    wps
}

/// Does this row need spatial rendering at all?
///
/// True when either a fixed azimuth is set or a non-empty waypoint trajectory
/// is provided. Elevation alone does nothing without azimuth — we treat that
/// as "no spatial data" so accidental UI state doesn't trigger a prerender.
pub fn row_needs_spatial(spatial_azimuth: &str, spatial_path: &str) -> bool {
    !spatial_azimuth.trim().is_empty() || !spatial_path.trim().is_empty()
}

/// Does this row need a prerender pass (HRTF placement *or* room IR)?
///
/// The main scene renderer calls into `prerender_spatialized_clip` whenever
/// this returns true. A row can have HRTF placement only, a room only, or
/// both — the prerender handles all three.
pub fn row_needs_prerender(
    spatial_azimuth: &str,
    spatial_path: &str,
    spatial_space: &str,
) -> bool {
    row_needs_spatial(spatial_azimuth, spatial_path) || space_is_set(spatial_space)
}

/// True if `spatial_space` names a real space (non-empty, not the "dry"/
/// "anechoic" baseline that is a no-op).
fn space_is_set(slug: &str) -> bool {
    let s = slug.trim();
    !s.is_empty() && s != "anechoic" && s != "dry"
}

/// Locate a SOFA HRTF file shipped with the app (if any).
///
/// Search order:
///   1. `$PHARAOH_SOFA_PATH` env var (explicit override; path or directory)
///   2. `<cwd>/assets/sofa/mit-kemar-normal.sofa`
///   3. First `*.sofa` in `<cwd>/assets/sofa/`
///   4. `<exe-dir>/assets/sofa/` and `<exe-dir>/../Resources/assets/sofa/`
///      (production bundle locations)
///
/// Returns `None` if no SOFA file is found — callers should fall back to the
/// pure-ffmpeg binaural approximation chain in that case.
pub fn find_sofa_file() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("PHARAOH_SOFA_PATH") {
        let p = PathBuf::from(&override_path);
        if p.is_file() {
            return Some(p);
        }
        if p.is_dir() {
            if let Some(file) = first_sofa_in_dir(&p) {
                return Some(file);
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("assets").join("sofa"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("assets").join("sofa"));
            candidates.push(dir.join("..").join("Resources").join("assets").join("sofa"));
        }
    }

    for dir in candidates {
        if !dir.is_dir() {
            continue;
        }
        let preferred = dir.join("mit-kemar-normal.sofa");
        if preferred.is_file() {
            return Some(preferred);
        }
        if let Some(file) = first_sofa_in_dir(&dir) {
            return Some(file);
        }
    }
    None
}

// ── Spatial spaces: room IR catalog ──────────────────────────────────────────

/// One entry in `assets/spaces/spaces.json`. Frontend-facing — surfaced via
/// the `list_spatial_spaces` Tauri command and rendered as the modal dropdown.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct SpaceEntry {
    pub slug: String,
    pub label: String,
    pub description: String,
    /// Relative WAV filename inside `assets/spaces/`. `None` = the "dry"
    /// baseline that needs no IR.
    pub file: Option<String>,
    /// "dry" | "stereo" | "binaural" — informational, doesn't change rendering.
    #[serde(rename = "type")]
    pub kind: String,
    pub source: Option<String>,
    pub url: Option<String>,
    pub license: Option<String>,
    /// Default wet/dry mix when the row doesn't override via `reverb_send`.
    pub default_wet: f32,
    /// True iff the IR file is present on disk (or this is the dry baseline).
    /// Populated by `load_spaces_with_availability`, never read from JSON.
    #[serde(default)]
    pub available: bool,
}

#[derive(Debug, Deserialize)]
struct SpacesManifest {
    spaces: Vec<SpaceEntry>,
}

/// Locate the `assets/spaces/` directory. Mirrors `find_sofa_file`'s search
/// order so dev (cwd) and production (exe-dir) both work, with an env-var
/// override for unusual deployments.
pub fn find_spaces_dir() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("PHARAOH_SPACES_DIR") {
        let p = PathBuf::from(&override_path);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("assets").join("spaces");
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p1 = dir.join("assets").join("spaces");
            if p1.is_dir() {
                return Some(p1);
            }
            let p2 = dir.join("..").join("Resources").join("assets").join("spaces");
            if p2.is_dir() {
                return Some(p2);
            }
        }
    }
    None
}

/// Load `spaces.json` from disk and stamp `available` on each entry based on
/// whether the referenced file actually exists. Surfaced via the Tauri
/// command `list_spatial_spaces` so the frontend can grey out missing
/// presets in the dropdown.
///
/// Returns an empty list if the manifest doesn't parse — never errors —
/// because a broken manifest shouldn't prevent dry rendering. The UI handles
/// "no spaces installed" gracefully.
pub fn load_spaces_with_availability() -> Vec<SpaceEntry> {
    let Some(dir) = find_spaces_dir() else {
        return vec![];
    };
    let manifest_path = dir.join("spaces.json");
    let bytes = match std::fs::read(&manifest_path) {
        Ok(b) => b,
        Err(_) => return vec![],
    };
    let manifest: SpacesManifest = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(_) => return vec![],
    };
    manifest
        .spaces
        .into_iter()
        .map(|mut sp| {
            sp.available = match &sp.file {
                None => sp.kind == "dry",
                Some(fname) => dir.join(fname).is_file(),
            };
            sp
        })
        .collect()
}

/// Resolve a space slug to its (IR path, default_wet) pair. Returns `None`
/// for the dry/anechoic baseline, for an unknown slug, or when the IR file
/// is missing on disk (the renderer skips convolution in that case rather
/// than failing the whole render).
pub fn find_space_ir(slug: &str) -> Option<(PathBuf, f32)> {
    if !space_is_set(slug) {
        return None;
    }
    let dir = find_spaces_dir()?;
    let manifest_path = dir.join("spaces.json");
    let bytes = std::fs::read(&manifest_path).ok()?;
    let manifest: SpacesManifest = serde_json::from_slice(&bytes).ok()?;
    let entry = manifest.spaces.into_iter().find(|s| s.slug == slug)?;
    let file = entry.file?;
    let ir_path = dir.join(file);
    if !ir_path.is_file() {
        return None;
    }
    Some((ir_path, entry.default_wet.clamp(0.0, 1.0)))
}

/// Tauri command — returns the manifest with `available` stamped on each
/// entry. The frontend renders this as the SpatializeModal's space dropdown,
/// greying out entries whose IR file isn't on disk yet.
#[tauri::command]
pub fn list_spatial_spaces() -> Vec<SpaceEntry> {
    load_spaces_with_availability()
}

/// Parse the `reverb_send` column as the per-clip wet override. Empty or
/// unparseable falls back to `default_wet` from the manifest.
pub fn resolve_wet_amount(reverb_send: &str, default_wet: f32) -> f32 {
    let trimmed = reverb_send.trim();
    if trimmed.is_empty() {
        return default_wet.clamp(0.0, 1.0);
    }
    trimmed
        .parse::<f32>()
        .map(|w| w.clamp(0.0, 1.0))
        .unwrap_or(default_wet)
}

fn first_sofa_in_dir(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut sofa_files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("sofa"))
                    .unwrap_or(false)
        })
        .collect();
    sofa_files.sort();
    sofa_files.into_iter().next()
}

/// Number of trajectory segments to render. Bigger = smoother motion but a
/// larger ffmpeg filter graph. 32 is enough for typical motion at clip
/// lengths up to ~10 s (≈ 300 ms per segment).
const MAX_SEGMENTS: usize = 32;

/// Minimum samples per segment at 48 kHz to avoid pathological tiny chunks
/// when a clip is short. 4800 samples = 100 ms.
const MIN_SEGMENT_MS: f32 = 100.0;

/// Decide how many segments to render for a given duration.
fn segment_count(duration_sec: f32) -> usize {
    if duration_sec <= 0.0 {
        return 1;
    }
    let by_min = (duration_sec * 1000.0 / MIN_SEGMENT_MS).floor() as usize;
    by_min.clamp(1, MAX_SEGMENTS)
}

/// Sample the trajectory at `t_frac`, returning interpolated `(az, el)`.
/// Handles azimuth wraparound: interpolates along the *shorter* arc, so
/// e.g. 350° → 10° goes via 0° (20° span), not the long way around.
pub fn sample_trajectory(
    waypoints: &[Waypoint],
    fallback_az: f32,
    fallback_el: f32,
    t_frac: f32,
) -> (f32, f32) {
    if waypoints.is_empty() {
        return (fallback_az, fallback_el);
    }
    if t_frac <= waypoints[0].t_frac {
        return (waypoints[0].az, waypoints[0].el);
    }
    if t_frac >= waypoints.last().unwrap().t_frac {
        let last = waypoints.last().unwrap();
        return (last.az, last.el);
    }
    for i in 0..waypoints.len() - 1 {
        let a = &waypoints[i];
        let b = &waypoints[i + 1];
        if t_frac >= a.t_frac && t_frac <= b.t_frac {
            let span = b.t_frac - a.t_frac;
            let f = if span < 1e-6 { 0.0 } else { (t_frac - a.t_frac) / span };

            // Shortest-arc azimuth interpolation.
            let mut delta = b.az - a.az;
            if delta > 180.0 {
                delta -= 360.0;
            } else if delta < -180.0 {
                delta += 360.0;
            }
            let az = (a.az + delta * f).rem_euclid(360.0);
            let el = a.el + (b.el - a.el) * f;
            return (az, el);
        }
    }
    (fallback_az, fallback_el)
}

/// Build the ffmpeg filter-graph fragment that takes a labelled mono input
/// and produces a labelled binaural-stereo output for a *single* fixed
/// `(az, el)` position. Used by both the static prerender and each segment
/// of the trajectory prerender.
///
/// `in_label`/`out_label` are ffmpeg stream labels without the brackets,
/// e.g. `"s0"`. `sofa_path` selects the HRTF engine: when `Some`, we use
/// `sofalizer`; when `None`, the ITD+ILD+HF approximation.
fn spatial_segment(
    in_label: &str,
    out_label: &str,
    az: f32,
    el: f32,
    sofa_path: Option<&Path>,
) -> String {
    if let Some(sofa) = sofa_path {
        // Real HRTF binaural via sofalizer. Input must be mono.
        // Note: ffmpeg's sofalizer ignores filter-graph quoting if the path
        // contains a colon — sofa files almost never have weird filenames,
        // but escape the colon anyway for safety on Windows.
        let path_str = sofa.to_string_lossy().replace(':', "\\:");
        return format!(
            "[{}]sofalizer=sofa={}:type=freq:radius=1:azimuth={:.2}:elevation={:.2}[{}]",
            in_label, path_str, az, el, out_label
        );
    }

    // ITD + ILD + HF-rolloff approximation. Public-headphone-friendly defaults:
    //   ITD: max 640 µs (32 samples @ 48 kHz) between ears.
    //   ILD: ±3 dB max (about 6 dB stereo width at az=90°), tapering by sin.
    //   Rear-hemisphere lowpass: 6 kHz cutoff weighted by how rear-facing.
    let az_rad = az.to_radians();
    let sin_az = az_rad.sin();
    let cos_az = az_rad.cos();

    // Positive sin_az = right-side source. Left ear is the far ear → delayed.
    let itd_samples = (32.0_f32 * sin_az).round();
    let (left_delay_s, right_delay_s) = if itd_samples >= 0.0 {
        (itd_samples as i32, 0)
    } else {
        (0, -itd_samples as i32)
    };

    // Per-side gain in dB. Left louder when source is on the left (sin_az < 0).
    let ild_db_right = 3.0 * sin_az;
    let ild_db_left = -3.0 * sin_az;
    let lg = 10f32.powf(ild_db_left / 20.0);
    let rg = 10f32.powf(ild_db_right / 20.0);

    // Elevation cue: very modest HF shelving — drop highs slightly for sources
    // below the ear plane, lift them slightly for sources above. Without HRTF
    // this is a placebo cue at best, but it does *something* on headphones.
    let el_norm = el / 90.0; // -1..+1
    let hf_gain_db = 1.5 * el_norm; // ±1.5 dB tilt at the extremes

    // Rear-hemisphere darkening: scales 0..1 with how directly behind the
    // source is. `cos_az` is +1 at front, -1 at back.
    let rear_weight = (-cos_az).max(0.0); // 0 in front, 1 directly behind
    // Lowpass cutoff swept from 18 kHz (no effect) down to 4 kHz (full rear).
    let lp_cutoff = 18000.0 - 14000.0 * rear_weight;

    let lp_filter = if rear_weight > 0.05 {
        format!(",lowpass=f={:.0}", lp_cutoff)
    } else {
        String::new()
    };
    let el_filter = if hf_gain_db.abs() > 0.1 {
        format!(",treble=g={:.2}:f=6000", hf_gain_db)
    } else {
        String::new()
    };

    // The chain:
    //   1. Force mono so ILD is well defined for already-stereo inputs
    //   2. Per-channel gain (ILD) → stereo
    //   3. Split, apply ITD per channel, rejoin
    //   4. Optional rear lowpass + elevation HF tilt
    format!(
        "[{in_label}]aformat=channel_layouts=mono,asplit=2[lpre][rpre];\
         [lpre]volume={lg:.4},adelay={ld}S:all=1,aformat=channel_layouts=mono[L];\
         [rpre]volume={rg:.4},adelay={rd}S:all=1,aformat=channel_layouts=mono[R];\
         [L][R]join=inputs=2:channel_layout=stereo{lp}{eltil}[{out_label}]",
        in_label = in_label,
        out_label = out_label,
        lg = lg,
        rg = rg,
        ld = left_delay_s,
        rd = right_delay_s,
        lp = lp_filter,
        eltil = el_filter,
    )
}

/// Prerender a single clip with binaural placement and/or room reverb.
///
/// Pipeline:
///   1. *Binaural stage* — sofalizer with the HRTF SOFA, or the ITD/ILD
///      approximation when no SOFA is installed. Trajectories segment the
///      input into ≤32 chunks rendered at interpolated (az, el) and
///      concatted. When no spatial position is set this stage is a
///      passthrough that just normalizes to 48 kHz stereo.
///   2. *Space stage* — `afir` convolution against the chosen room IR,
///      mixed wet/dry by `wet`. Skipped when `space_ir` is `None`.
///
/// At least one stage must be active — the caller checks `row_needs_prerender`
/// before invoking. Writes 48 kHz / 24-bit / stereo PCM to `output_path`.
pub fn prerender_spatialized_clip(
    input_path: &Path,
    output_path: &Path,
    spatial_azimuth: &str,
    spatial_elevation: &str,
    spatial_path: &str,
    space_ir: Option<&Path>,
    wet: f32,
) -> Result<()> {
    let az_static = spatial_azimuth
        .trim()
        .parse::<f32>()
        .unwrap_or(0.0)
        .rem_euclid(360.0);
    let el_static = spatial_elevation
        .trim()
        .parse::<f32>()
        .unwrap_or(0.0)
        .clamp(-90.0, 90.0);

    let waypoints = parse_waypoints(spatial_path);
    let sofa = find_sofa_file();
    let sofa_ref = sofa.as_deref();

    // Duration is needed for trajectory segmentation. Pull it from the WAV
    // header — if that fails for any reason, treat the clip as static.
    let duration_sec = wav_duration_seconds(input_path).unwrap_or(0.0);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Other(format!("create spatial temp dir {}: {}", parent.display(), e))
        })?;
    }

    let has_spatial = row_needs_spatial(spatial_azimuth, spatial_path);

    // ── Stage 1: binaural → produces label [bin] ──────────────────────────
    let binaural_graph: String = if !has_spatial {
        // No HRTF: just normalize to 48 kHz stereo. Used for space-only rows.
        "[0:a]aresample=48000,aformat=channel_layouts=stereo[bin]".to_string()
    } else if waypoints.is_empty() || duration_sec <= 0.0 {
        // Static HRTF: single sofalizer (or approximation) at the fixed position.
        let chain = spatial_segment("s0", "bin", az_static, el_static, sofa_ref);
        format!("[0:a]aresample=48000[s0];{}", chain)
    } else {
        // Trajectory: split into N chunks, spatialize each at the interpolated
        // (az, el), concat. Output label is [bin] for stage-2 chaining.
        let n = segment_count(duration_sec);
        let seg_len = duration_sec / n as f32;
        let mut parts: Vec<String> = Vec::new();

        let split_labels: Vec<String> = (0..n).map(|i| format!("seg{}", i)).collect();
        let split_targets = split_labels
            .iter()
            .map(|l| format!("[{}]", l))
            .collect::<String>();
        parts.push(format!(
            "[0:a]aresample=48000,asplit={}{}",
            n, split_targets
        ));

        let mut concat_inputs = String::new();
        for i in 0..n {
            let t0 = i as f32 * seg_len;
            let t1 = if i == n - 1 { duration_sec } else { (i + 1) as f32 * seg_len };
            let t_mid = (t0 + t1) * 0.5 / duration_sec;
            let (az, el) = sample_trajectory(&waypoints, az_static, el_static, t_mid);
            let trim_label = format!("t{}", i);
            let chunk_label = format!("c{}", i);
            parts.push(format!(
                "[{src}]atrim={t0:.4}:{t1:.4},asetpts=PTS-STARTPTS,aformat=channel_layouts=mono[{tl}]",
                src = split_labels[i],
                t0 = t0,
                t1 = t1,
                tl = trim_label,
            ));
            parts.push(spatial_segment(&trim_label, &chunk_label, az, el, sofa_ref));
            concat_inputs.push_str(&format!("[{}]", chunk_label));
        }
        parts.push(format!(
            "{}concat=n={}:v=0:a=1[bin]",
            concat_inputs, n
        ));
        parts.join(";")
    };

    // ── Stage 2: space (afir convolution) → produces label [out] ──────────
    //
    // When a space IR is supplied, we mix wet/dry with `wet` controlling the
    // reverb amount. The IR rides in as ffmpeg's second input (`[1:a]`).
    // `gtype=peak:irgain=1` peak-normalizes the IR so different presets sit
    // at roughly comparable wet levels.
    let space_graph: String = if space_ir.is_some() {
        let wet_clamped = wet.clamp(0.0, 1.0);
        let dry = (1.0 - wet_clamped).max(0.05); // keep a hint of direct signal at full wet
        format!(
            "[bin][1:a]afir=dry={dry:.3}:wet={wet:.3}:gtype=peak:irgain=1[out]",
            dry = dry,
            wet = wet_clamped,
        )
    } else {
        // No space: pass [bin] straight through to [out].
        "[bin]anull[out]".to_string()
    };

    let filter_graph = format!("{};{}", binaural_graph, space_graph);

    let input_str = input_path.to_string_lossy().to_string();
    let output_str = output_path.to_string_lossy().to_string();

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input_str,
    ];
    if let Some(ir) = space_ir {
        args.push("-i".into());
        args.push(ir.to_string_lossy().to_string());
    }
    args.extend([
        "-filter_complex".into(),
        filter_graph,
        "-map".into(),
        "[out]".into(),
        // 48 kHz, 24-bit PCM stereo matches the main renderer's working format.
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-c:a".into(),
        "pcm_s24le".into(),
        output_str,
    ]);

    let out = std::process::Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| Error::Other(format!("ffmpeg not found (install ffmpeg): {}", e)))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Other(format!(
            "spatial prerender failed:\n{}",
            &stderr[..stderr.len().min(1500)]
        )));
    }
    Ok(())
}

fn wav_duration_seconds(path: &Path) -> Result<f32> {
    let reader = hound::WavReader::open(path)
        .map_err(|e| Error::Other(format!("open wav {}: {}", path.display(), e)))?;
    let spec = reader.spec();
    let frames = reader.duration() as f32;
    let sr = spec.sample_rate.max(1) as f32;
    Ok(frames / sr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_path_as_no_waypoints() {
        assert!(parse_waypoints("").is_empty());
        assert!(parse_waypoints("   ").is_empty());
    }

    #[test]
    fn parses_waypoints_and_clamps() {
        let wps = parse_waypoints(
            r#"[{"t_frac":0,"az":0,"el":0},{"t_frac":1,"az":720,"el":120}]"#,
        );
        assert_eq!(wps.len(), 2);
        assert_eq!(wps[1].az, 0.0);   // 720 mod 360
        assert_eq!(wps[1].el, 90.0);  // clamped
    }

    #[test]
    fn parses_garbage_to_empty() {
        assert!(parse_waypoints("not json").is_empty());
        assert!(parse_waypoints("[{}]").is_empty()); // missing fields
    }

    #[test]
    fn sample_trajectory_picks_shortest_arc() {
        // 350° → 10° at t=0.5 should land near 0°, not 180°.
        let wps = vec![
            Waypoint { t_frac: 0.0, az: 350.0, el: 0.0 },
            Waypoint { t_frac: 1.0, az: 10.0,  el: 0.0 },
        ];
        let (az, _el) = sample_trajectory(&wps, 0.0, 0.0, 0.5);
        // Should be very close to 0° (i.e. 360°)
        assert!(az < 5.0 || az > 355.0, "az was {}", az);
    }

    #[test]
    fn row_needs_spatial_picks_up_either_field() {
        assert!(!row_needs_spatial("", ""));
        assert!(!row_needs_spatial("  ", ""));
        assert!(row_needs_spatial("90", ""));
        assert!(row_needs_spatial("", "[{\"t_frac\":0,\"az\":0,\"el\":0}]"));
    }

    #[test]
    fn segment_count_clamps_to_max() {
        assert_eq!(segment_count(0.0), 1);
        assert_eq!(segment_count(0.05), 1);  // 50ms → 1 segment
        assert_eq!(segment_count(0.5), 5);   // 500ms → 5 segments
        assert_eq!(segment_count(60.0), 32); // capped at MAX_SEGMENTS
    }
}
