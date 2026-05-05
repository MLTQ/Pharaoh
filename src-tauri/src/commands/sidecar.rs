use crate::app_support::app_projects_dir;
use crate::error::{Error, Result};
use crate::models::{GeneratedAudioAsset, SidecarMeta};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

fn meta_path(audio_path: &str) -> PathBuf {
    let p = PathBuf::from(audio_path);
    // e.g. mira_line_01.wav → mira_line_01.wav.meta.json
    let ext = format!(
        "{}.meta.json",
        p.extension().unwrap_or_default().to_string_lossy()
    );
    p.with_extension(ext)
}

fn audio_path_from_meta(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let audio_name = name.strip_suffix(".meta.json")?;
    Some(path.with_file_name(audio_name))
}

fn kind_from_model(model: &str) -> &'static str {
    let model = model.to_lowercase();
    if model.contains("qwen") || model.contains("tts") {
        "tts"
    } else if model.contains("ace") || model.contains("music") {
        "music"
    } else {
        "sfx"
    }
}

fn collect_generated_assets(
    root: &Path,
    scene_slug: &str,
    out: &mut Vec<GeneratedAudioAsset>,
) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_generated_assets(&path, scene_slug, out)?;
            continue;
        }

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if !name.ends_with(".wav.meta.json") {
            continue;
        }

        let data = std::fs::read_to_string(&path)?;
        let meta: SidecarMeta = serde_json::from_str(&data)?;
        let Some(audio_path) = audio_path_from_meta(&path) else {
            continue;
        };
        if !audio_path.exists() {
            continue;
        }

        let kind_model = if meta.model == "audiosr" {
            meta.parent
                .as_ref()
                .and_then(|parent| read_sidecar(parent.clone()).ok().flatten())
                .map(|parent_meta| parent_meta.model)
                .unwrap_or_else(|| meta.model.clone())
        } else {
            meta.model.clone()
        };

        out.push(GeneratedAudioAsset {
            audio_path: audio_path.to_string_lossy().into_owned(),
            meta_path: path.to_string_lossy().into_owned(),
            scene_slug: scene_slug.to_string(),
            kind: kind_from_model(&kind_model).to_string(),
            name: audio_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            duration_ms: meta.duration_actual_ms,
            sample_rate: meta.sample_rate,
            model: meta.model,
            model_variant: meta.model_variant,
            prompt: meta.prompt,
            generated_at: meta.generated_at,
            parent: meta.parent,
            qa_status: meta.qa_status,
        });
    }

    Ok(())
}

#[tauri::command]
pub fn write_sidecar(audio_path: String, meta: SidecarMeta) -> Result<()> {
    let path = meta_path(&audio_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&meta)?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub fn read_sidecar(audio_path: String) -> Result<Option<SidecarMeta>> {
    let path = meta_path(&audio_path);
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path)?;
    let meta: SidecarMeta = serde_json::from_str(&data)?;
    Ok(Some(meta))
}

#[tauri::command]
pub fn list_generated_audio_assets(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<GeneratedAudioAsset>> {
    let project_root = app_projects_dir(&app)?.join(project_id);
    let scenes_root = project_root.join("scenes");
    let mut assets = Vec::new();

    if scenes_root.exists() {
        for entry in std::fs::read_dir(&scenes_root)? {
            let entry = entry?;
            let scene_path = entry.path();
            if !scene_path.is_dir() {
                continue;
            }
            let scene_slug = scene_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            collect_generated_assets(&scene_path.join("assets"), &scene_slug, &mut assets)?;
        }
    }

    assets.sort_by(|a, b| b.generated_at.cmp(&a.generated_at));
    Ok(assets)
}

#[tauri::command]
pub fn get_takes(base_audio_path: String) -> Result<Vec<SidecarMeta>> {
    let base = PathBuf::from(&base_audio_path);
    let stem = base
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = base
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dir = base
        .parent()
        .ok_or_else(|| Error::Other("no parent dir".into()))?;

    let mut takes: Vec<SidecarMeta> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with(&stem) && name.ends_with(&format!(".{}.meta.json", ext))
        })
        .filter_map(|e| {
            let meta_path = e.path();
            std::fs::read_to_string(&meta_path)
                .ok()
                .and_then(|data| serde_json::from_str::<SidecarMeta>(&data).ok())
        })
        .collect();

    takes.sort_by_key(|t| t.take_index);
    Ok(takes)
}

#[tauri::command]
pub fn update_sidecar_qa(audio_path: String, qa_status: String, qa_notes: String) -> Result<()> {
    let path = meta_path(&audio_path);
    if !path.exists() {
        return Err(Error::Other(format!("no sidecar for {}", audio_path)));
    }
    let data = std::fs::read_to_string(&path)?;
    let mut meta: SidecarMeta = serde_json::from_str(&data)?;
    meta.qa_status = qa_status;
    meta.qa_notes = qa_notes;
    write_sidecar(audio_path, meta)
}
