use std::path::PathBuf;
use crate::error::{Error, Result};
use crate::models::SidecarMeta;

fn meta_path(audio_path: &str) -> PathBuf {
    let p = PathBuf::from(audio_path);
    // e.g. mira_line_01.wav → mira_line_01.wav.meta.json
    let ext = format!("{}.meta.json", p.extension().unwrap_or_default().to_string_lossy());
    p.with_extension(ext)
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
pub fn get_takes(base_audio_path: String) -> Result<Vec<SidecarMeta>> {
    let base = PathBuf::from(&base_audio_path);
    let stem = base.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = base.extension().unwrap_or_default().to_string_lossy().to_string();
    let dir = base.parent().ok_or_else(|| Error::Other("no parent dir".into()))?;

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
pub fn update_sidecar_qa(
    audio_path: String,
    qa_status: String,
    qa_notes: String,
) -> Result<()> {
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
