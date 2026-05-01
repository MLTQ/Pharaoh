use std::time::Duration;
use tauri::{AppHandle, Manager};
use crate::error::{Error, Result};
use crate::models::{AppConfig, AllServerHealth, AppState, ServerHealth};

#[tauri::command]
pub async fn get_app_config(app: AppHandle) -> Result<AppConfig> {
    let state = app.state::<AppState>();
    let cfg = state.app_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn save_app_config(app: AppHandle, config: AppConfig) -> Result<()> {
    let state = app.state::<AppState>();

    // Sync the in-memory server config so live requests use new URLs immediately
    {
        let mut scfg = state.server_config.write().map_err(|_| Error::Other("lock poisoned".into()))?;
        scfg.tts_url   = config.tts_url.clone();
        scfg.sfx_url   = config.sfx_url.clone();
        scfg.music_url = config.music_url.clone();
    }

    // Ensure projects_dir exists when changed
    let projects_dir = std::path::PathBuf::from(&config.projects_dir);
    if !projects_dir.exists() {
        std::fs::create_dir_all(&projects_dir)?;
    }
    let models_dir = std::path::PathBuf::from(&config.models_dir);
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir)?;
    }

    // Persist to disk
    let json = serde_json::to_string_pretty(&config)?;
    if let Some(parent) = state.config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&state.config_path, &json)?;

    // Update in-memory config
    {
        let mut acfg = state.app_config.write().map_err(|_| Error::Other("lock poisoned".into()))?;
        *acfg = config;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_server_health_all(app: AppHandle) -> Result<AllServerHealth> {
    let state = app.state::<AppState>();
    let (tts_url, sfx_url, music_url) = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        (cfg.tts_url.clone(), cfg.sfx_url.clone(), cfg.music_url.clone())
    };
    let http = state.http.clone();

    async fn try_health(http: reqwest::Client, base_url: String) -> Option<ServerHealth> {
        http.get(format!("{}/health", base_url))
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .ok()?
            .json::<ServerHealth>()
            .await
            .ok()
    }

    let (tts, sfx, music) = tokio::join!(
        try_health(http.clone(), tts_url),
        try_health(http.clone(), sfx_url),
        try_health(http, music_url),
    );

    Ok(AllServerHealth { tts, sfx, music })
}
