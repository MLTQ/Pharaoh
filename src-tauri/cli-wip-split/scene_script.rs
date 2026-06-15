//! `pharaoh scene ...` and `pharaoh script ...` commands: storyboard scene
//! CRUD plus script.csv / script.fountain authoring, row patching, spatial
//! placement, and whole-screenplay Fountain import.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::json;
use uuid::Uuid;

use super::helpers::{
    find_scene, find_scene_mut, flag_opt, flag_parse, flag_string, load_project, load_storyboard,
    parse_flags, print_json, scene_not_found, update_project_timestamp,
};
use crate::app_support::{
    project_dir, read_json, read_script_rows, scene_dir, script_path, update_script_row_fields,
    write_json, write_script_rows,
};
use crate::error::{Error, Result};
use crate::models::{Scene, SceneStatus, ScriptRow, Storyboard, VoiceAssignment};

pub(super) async fn scene_list(config: &crate::models::AppConfig, project_id: &str) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = project_dir(&projects_dir, project_id).join("storyboard.json");
    let storyboard: Storyboard = if path.exists() {
        read_json(&path)?
    } else {
        Storyboard { scenes: vec![] }
    };
    print_json(&storyboard.scenes)
}

pub(super) async fn scene_get(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_ref: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let storyboard = load_storyboard(&projects_dir, project_id)?;
    let scene =
        find_scene(&storyboard, scene_ref).ok_or_else(|| scene_not_found(scene_ref, project_id))?;
    print_json(scene)
}

pub(super) async fn scene_create(
    config: &crate::models::AppConfig,
    project_id: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let title = flag_opt(&flags, "title").ok_or_else(|| Error::Other("missing --title".into()))?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project_root = project_dir(&projects_dir, project_id);
    let storyboard_path = project_root.join("storyboard.json");
    let mut storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };
    let index = flags
        .get("index")
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| Error::Other("invalid --index".into()))
        })
        .transpose()?
        .unwrap_or(storyboard.scenes.len() as u32);
    let slug = flag_opt(&flags, "slug").unwrap_or_else(|| {
        format!(
            "{:02}_{}",
            index,
            title
                .to_lowercase()
                .replace(' ', "_")
                .replace(|c: char| !c.is_alphanumeric() && c != '_', "")
        )
    });
    let scene = Scene {
        id: Uuid::new_v4().to_string(),
        index,
        slug: slug.clone(),
        title,
        description: flag_string(&flags, "description", ""),
        location: flag_string(&flags, "location", ""),
        characters: flag_opt(&flags, "characters")
            .map(|value| {
                value
                    .split(',')
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        notes: flag_string(&flags, "notes", ""),
        connects_from: flag_opt(&flags, "connects_from"),
        connects_to: flag_opt(&flags, "connects_to"),
        status: SceneStatus::Draft,
    };
    let scene_root = scene_dir(&projects_dir, project_id, &slug);
    std::fs::create_dir_all(scene_root.join("assets"))?;
    std::fs::create_dir_all(scene_root.join("render"))?;
    write_script_rows(&scene_root.join("script.csv"), &[])?;
    storyboard.scenes.push(scene.clone());
    storyboard.scenes.sort_by_key(|scene| scene.index);
    write_json(&storyboard_path, &storyboard)?;
    update_project_timestamp(config, project_id)?;
    print_json(&scene)
}

pub(super) async fn scene_update(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_ref: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let storyboard_path = project_dir(&projects_dir, project_id).join("storyboard.json");
    let mut storyboard = load_storyboard(&projects_dir, project_id)?;
    let scene = find_scene_mut(&mut storyboard, scene_ref)
        .ok_or_else(|| scene_not_found(scene_ref, project_id))?;
    if let Some(value) = flag_opt(&flags, "title") {
        scene.title = value;
    }
    if let Some(value) = flag_opt(&flags, "description") {
        scene.description = value;
    }
    if let Some(value) = flag_opt(&flags, "location") {
        scene.location = value;
    }
    if let Some(value) = flag_opt(&flags, "notes") {
        scene.notes = value;
    }
    if let Some(value) = flag_opt(&flags, "characters") {
        scene.characters = value
            .split(',')
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect();
    }
    if let Some(value) = flag_opt(&flags, "status") {
        scene.status = match value.as_str() {
            "draft" => SceneStatus::Draft,
            "generating" => SceneStatus::Generating,
            "assets_ready" => SceneStatus::AssetsReady,
            "composed" => SceneStatus::Composed,
            "rendered" => SceneStatus::Rendered,
            _ => return Err(Error::Other("invalid --status".into())),
        };
    }
    let updated = scene.clone();
    storyboard.scenes.sort_by_key(|scene| scene.index);
    write_json(&storyboard_path, &storyboard)?;
    update_project_timestamp(config, project_id)?;
    print_json(&updated)
}

pub(super) async fn script_read(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let rows = read_script_rows(&script_path(&projects_dir, project_id, scene_slug))?;
    print_json(&rows)
}

pub(super) async fn script_write(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    input_path: &str,
) -> Result<()> {
    let data = std::fs::read_to_string(input_path)
        .map_err(|e| Error::Other(format!("cannot read script input {}: {}", input_path, e)))?;
    let rows: Vec<ScriptRow> = if input_path.ends_with(".json") {
        serde_json::from_str(&data)?
    } else {
        let mut reader = csv::Reader::from_reader(data.as_bytes());
        let mut rows = vec![];
        for row in reader.deserialize() {
            rows.push(row?);
        }
        rows
    };
    let projects_dir = PathBuf::from(&config.projects_dir);
    write_script_rows(&script_path(&projects_dir, project_id, scene_slug), &rows)?;
    print_json(&json!({ "project_id": project_id, "scene_slug": scene_slug, "rows": rows.len() }))
}

pub(super) fn fountain_path(projects_dir: &Path, project_id: &str, scene_slug: &str) -> PathBuf {
    scene_dir(projects_dir, project_id, scene_slug).join("script.fountain")
}

fn read_text_input(input_path: &str) -> Result<String> {
    if input_path == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        return Ok(text);
    }
    std::fs::read_to_string(input_path)
        .map_err(|e| Error::Other(format!("cannot read {}: {}", input_path, e)))
}

pub(super) fn write_scene_fountain(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    text: &str,
) -> Result<PathBuf> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = fountain_path(&projects_dir, project_id, scene_slug);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("fountain.tmp");
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|e| Error::Other(format!("write {}: {}", tmp.display(), e)))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        Error::Other(format!(
            "rename {} to {}: {}",
            tmp.display(),
            path.display(),
            e
        ))
    })?;
    Ok(path)
}

pub(super) fn compile_fountain_for_scene(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    text: &str,
) -> Result<usize> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let project = load_project(config, project_id)?;
    let storyboard = load_storyboard(&projects_dir, project_id)?;
    let scene =
        find_scene(&storyboard, scene_slug).ok_or_else(|| scene_not_found(scene_slug, project_id))?;
    let doc = crate::fountain::parse_document(text);
    if doc.scenes.len() > 1 {
        return Err(Error::Other(
            "fountain-write targets one existing scene; use script import for multi-scene files"
                .into(),
        ));
    }
    let scene_no = format!("S{:02}", scene.index + 1);
    let cast_by_name: HashMap<String, String> = project
        .characters
        .iter()
        .map(|c| (c.name.to_ascii_uppercase(), c.id.clone()))
        .collect();
    let rows = doc
        .scenes
        .first()
        .map(|parsed_scene| {
            crate::fountain::blocks_to_rows(&parsed_scene.blocks, &scene_no, |name| {
                cast_by_name.get(&name.to_ascii_uppercase()).cloned()
            })
        })
        .unwrap_or_default();
    let row_count = rows.len();
    write_script_rows(&script_path(&projects_dir, project_id, scene_slug), &rows)?;
    update_project_timestamp(config, project_id)?;
    Ok(row_count)
}

pub(super) async fn script_fountain_read(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
) -> Result<()> {
    let projects_dir = PathBuf::from(&config.projects_dir);
    let path = fountain_path(&projects_dir, project_id, scene_slug);
    let text = if path.exists() {
        Some(
            std::fs::read_to_string(&path)
                .map_err(|e| Error::Other(format!("read {}: {}", path.display(), e)))?,
        )
    } else {
        None
    };
    print_json(&json!({
        "project_id": project_id,
        "scene_slug": scene_slug,
        "path": path,
        "fountain": text,
    }))
}

pub(super) async fn script_fountain_write(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    input_path: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let should_compile: bool = flag_parse(&flags, "compile", true)?;
    let text = read_text_input(input_path)?;
    let path = write_scene_fountain(config, project_id, scene_slug, &text)?;
    let compiled_rows = if should_compile {
        Some(compile_fountain_for_scene(
            config, project_id, scene_slug, &text,
        )?)
    } else {
        update_project_timestamp(config, project_id)?;
        None
    };
    print_json(&json!({
        "project_id": project_id,
        "scene_slug": scene_slug,
        "path": path,
        "compiled_rows": compiled_rows,
    }))
}

pub(super) async fn script_update_row(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    rest: &[String],
) -> Result<()> {
    let fields = parse_flags(rest)?;
    let projects_dir = PathBuf::from(&config.projects_dir);
    let row = update_script_row_fields(
        &script_path(&projects_dir, project_id, scene_slug),
        row_index,
        fields,
    )?;
    print_json(&row)
}

/// Set or clear spatial placement on a script row.
///
/// Usage:
///   pharaoh script spatialize <project> <scene> <row> \
///     [--azimuth 90] [--elevation 0] \
///     [--path '[{"t_frac":0,"az":270,"el":0},{"t_frac":1,"az":90,"el":0}]'] \
///     [--clear]
///
/// `--clear` blanks all three spatial columns (reverts to legacy `pan`).
/// Otherwise unspecified flags are left untouched on the row.
pub(super) async fn script_spatialize(
    config: &crate::models::AppConfig,
    project_id: &str,
    scene_slug: &str,
    row_index: usize,
    rest: &[String],
) -> Result<()> {
    let clear = rest.iter().any(|a| a == "--clear");
    let filtered: Vec<String> = rest.iter().filter(|a| a.as_str() != "--clear").cloned().collect();
    let raw_flags = parse_flags(&filtered)?;

    // Map ergonomic flag names → ScriptRow columns.
    let mut fields: HashMap<String, String> = HashMap::new();
    if clear {
        fields.insert("spatial_azimuth".into(), String::new());
        fields.insert("spatial_elevation".into(), String::new());
        fields.insert("spatial_path".into(), String::new());
        fields.insert("spatial_space".into(), String::new());
        fields.insert("reverb_send".into(), String::new());
    }
    for (k, v) in raw_flags {
        match k.as_str() {
            "azimuth"   | "az" | "spatial_azimuth"   => { fields.insert("spatial_azimuth".into(), v); }
            "elevation" | "el" | "spatial_elevation" => { fields.insert("spatial_elevation".into(), v); }
            "path"      | "spatial_path"             => { fields.insert("spatial_path".into(), v); }
            "space"     | "spatial_space"            => {
                // Validate against the manifest so a typo doesn't silently disable reverb.
                let known: Vec<String> = crate::commands::audio_spatial::load_spaces_with_availability()
                    .into_iter()
                    .map(|s| s.slug)
                    .collect();
                if !v.is_empty() && !known.iter().any(|s| s == &v) {
                    return Err(Error::Other(format!(
                        "unknown space '{}'; valid slugs: {}",
                        v, known.join(", ")
                    )));
                }
                fields.insert("spatial_space".into(), v);
            }
            "wet"       | "reverb_send"              => {
                let parsed: f32 = v.parse().map_err(|_| Error::Other(format!(
                    "--wet must be a number in [0,1], got '{}'", v
                )))?;
                if !(0.0..=1.0).contains(&parsed) {
                    return Err(Error::Other(format!("--wet out of range [0,1]: {}", parsed)));
                }
                fields.insert("reverb_send".into(), format!("{:.3}", parsed));
            }
            other => return Err(Error::Other(format!(
                "unknown flag --{}; expected --azimuth, --elevation, --path, --space, --wet, or --clear",
                other
            ))),
        }
    }
    if fields.is_empty() {
        return Err(Error::Other(
            "no spatial flags given; pass --azimuth, --elevation, --path, --space, --wet, or --clear".into(),
        ));
    }

    let projects_dir = PathBuf::from(&config.projects_dir);
    let row = update_script_row_fields(
        &script_path(&projects_dir, project_id, scene_slug),
        row_index,
        fields,
    )?;
    print_json(&row)
}

/// Import a Fountain (.fountain or plain text) file into an existing project.
/// Splits on scene headings (INT./EXT./EST./forced .HEADING), creates one Scene
/// per heading, writes a per-scene script.csv compiled from blocks, and adds
/// any new characters discovered in DIALOGUE cues.
///
/// Idempotency: characters with the same name (case-insensitive) are not
/// duplicated. Scene slugs include `--prefix` (default empty) so re-importing
/// the same file twice produces distinct scenes — by design, since we don't
/// know whether the user intends to revise or append.
pub(super) async fn script_import(
    config: &crate::models::AppConfig,
    project_id: &str,
    fountain_path: &str,
    rest: &[String],
) -> Result<()> {
    // `--dry-run` is bare; strip it before the standard flag parser so we
    // don't have to type `--dry-run true`.
    let dry_run = rest.iter().any(|a| a == "--dry-run" || a == "--dry_run");
    let filtered: Vec<String> = rest
        .iter()
        .filter(|a| a.as_str() != "--dry-run" && a.as_str() != "--dry_run")
        .cloned()
        .collect();
    let flags = parse_flags(&filtered)?;
    let prefix = flag_string(&flags, "prefix", "");
    let character_prefix = flag_string(&flags, "character_prefix", "CHAR");

    let path = Path::new(fountain_path);
    let text = std::fs::read_to_string(path)
        .map_err(|e| Error::Other(format!("cannot read {}: {}", fountain_path, e)))?;

    let doc = crate::fountain::parse_document(&text);

    if doc.scenes.is_empty() {
        return Err(Error::Other(
            "no scene headings (INT./EXT./EST.) found — Fountain import requires at least one scene heading".into(),
        ));
    }

    let projects_dir = PathBuf::from(&config.projects_dir);
    let project_root = project_dir(&projects_dir, project_id);
    if !project_root.exists() {
        return Err(Error::Other(format!(
            "project {} not found at {} — run `pharaoh project list` to see available project ids",
            project_id,
            project_root.display()
        )));
    }

    // ── Resolve characters: keep existing, append new ────────────────────
    let mut project = load_project(config, project_id)?;
    let mut name_to_id: HashMap<String, String> = project
        .characters
        .iter()
        .map(|c| (c.name.to_ascii_uppercase(), c.id.clone()))
        .collect();

    let mut new_characters: Vec<crate::models::Character> = Vec::new();
    for name in &doc.characters {
        let key = name.to_ascii_uppercase();
        if name_to_id.contains_key(&key) {
            continue;
        }
        let short = Uuid::new_v4().simple().to_string();
        let id = format!("{}_{}", character_prefix, short[..6].to_ascii_uppercase());
        name_to_id.insert(key.clone(), id.clone());
        new_characters.push(crate::models::Character {
            id: id.clone(),
            name: name.clone(),
            description: String::new(),
            voice_assignment: VoiceAssignment {
                model: "VoiceDesign".to_string(),
                speaker: None,
                instruct_default: None,
                ref_audio_path: None,
                ref_audio_sources: vec![],
                ref_transcript: None,
                base_voice_description: String::new(),
                emotional_palette: vec![],
                production_pipeline: "chatterbox".to_string(),
                rvc: None,
                rvc_model_path: None,
                rvc_index_path: None,
                rvc_pitch_shift: 0,
                rvc_index_rate: 0.5,
                rvc_protect: 0.33,
                rvc_enabled: false,
            },
            schema_version: crate::models::CURRENT_CHARACTER_SCHEMA,
            library_id: None,
            library_version: None,
        });
    }

    // ── Resolve scenes: load existing storyboard and append ──────────────
    let storyboard_path = project_root.join("storyboard.json");
    let mut storyboard: Storyboard = if storyboard_path.exists() {
        read_json(&storyboard_path)?
    } else {
        Storyboard { scenes: vec![] }
    };
    let start_index: u32 = flag_parse(&flags, "start_index", storyboard.scenes.len() as u32)?;

    // Build the planned scene + row payloads first; only commit if !dry_run
    let mut planned: Vec<(Scene, Vec<ScriptRow>)> = Vec::new();
    for (i, parsed_scene) in doc.scenes.iter().enumerate() {
        let index = start_index + i as u32;
        let title = if !parsed_scene.title.is_empty() {
            parsed_scene.title.clone()
        } else if !parsed_scene.heading.is_empty() {
            parsed_scene.heading.clone()
        } else {
            format!("Scene {}", index + 1)
        };
        let slug_base = sanitize_slug(&title);
        let slug = if prefix.is_empty() {
            format!("{:02}_{}", index, slug_base)
        } else {
            format!("{}_{:02}_{}", prefix, index, slug_base)
        };
        // scene_no follows the existing convention used by App.tsx
        let scene_no = format!("S{:02}", index + 1);
        let rows = crate::fountain::blocks_to_rows(&parsed_scene.blocks, &scene_no, |name| {
            name_to_id.get(&name.to_ascii_uppercase()).cloned()
        });
        // Scene `characters` field: list of character IDs that speak in this scene
        let mut chars_in_scene: Vec<String> = Vec::new();
        for b in &parsed_scene.blocks {
            if matches!(b.block_type, crate::fountain::BlockType::Dialogue) {
                if let Some(id) = name_to_id.get(&b.character.to_ascii_uppercase()) {
                    if !chars_in_scene.contains(id) {
                        chars_in_scene.push(id.clone());
                    }
                }
            }
        }
        let scene = Scene {
            id: Uuid::new_v4().to_string(),
            index,
            slug,
            title,
            description: parsed_scene.heading.clone(),
            location: parsed_scene.location.clone(),
            characters: chars_in_scene,
            notes: String::new(),
            connects_from: None,
            connects_to: None,
            status: SceneStatus::Draft,
        };
        planned.push((scene, rows));
    }

    if dry_run {
        let summary = json!({
            "dry_run": true,
            "fountain_file": fountain_path,
            "project_id": project_id,
            "title_from_fountain": doc.title,
            "author_from_fountain": doc.author,
            "characters": {
                "existing": project.characters.iter().map(|c| &c.name).collect::<Vec<_>>(),
                "new": new_characters.iter().map(|c| &c.name).collect::<Vec<_>>(),
            },
            "scenes": planned.iter().map(|(s, rows)| json!({
                "slug": s.slug,
                "title": s.title,
                "location": s.location,
                "speakers": s.characters,
                "rows": rows.len(),
                "by_type": count_by_type(rows),
            })).collect::<Vec<_>>(),
        });
        return print_json(&summary);
    }

    // ── Commit: characters → project, scenes → storyboard, rows → script.csv
    project.characters.extend(new_characters.clone());
    super::helpers::save_project(config, project)?;

    for (scene, rows) in &planned {
        let scene_root = scene_dir(&projects_dir, project_id, &scene.slug);
        std::fs::create_dir_all(scene_root.join("assets"))?;
        std::fs::create_dir_all(scene_root.join("render"))?;
        write_script_rows(&scene_root.join("script.csv"), rows)?;
        storyboard.scenes.push(scene.clone());
    }
    storyboard.scenes.sort_by_key(|scene| scene.index);
    write_json(&storyboard_path, &storyboard)?;
    update_project_timestamp(config, project_id)?;

    let summary = json!({
        "imported": true,
        "fountain_file": fountain_path,
        "project_id": project_id,
        "characters_added": new_characters.iter().map(|c| json!({"id": c.id, "name": c.name})).collect::<Vec<_>>(),
        "scenes_added": planned.iter().map(|(s, rows)| json!({
            "id": s.id, "slug": s.slug, "title": s.title, "rows": rows.len(),
            "by_type": count_by_type(rows),
        })).collect::<Vec<_>>(),
    });
    print_json(&summary)
}

fn sanitize_slug(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .replace("__", "_")
}

fn count_by_type(rows: &[ScriptRow]) -> serde_json::Value {
    let mut counts: HashMap<String, u64> = HashMap::new();
    for r in rows {
        *counts.entry(r.track_type.clone()).or_insert(0) += 1;
    }
    serde_json::to_value(counts).unwrap_or(serde_json::Value::Null)
}
