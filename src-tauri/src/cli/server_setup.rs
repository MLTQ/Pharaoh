//! `pharaoh server ...`, `pharaoh model ...`, and `pharaoh setup ...`
//! commands: inference-server health/config, model load/unload, and local
//! setup/hardware inspection.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::helpers::{flag_opt, parse_flags, print_json};
use crate::app_support::write_json;
use crate::commands::inference::detect_hardware;
use crate::error::{Error, Result};

pub(super) async fn server_health(
    config: &crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let model = rest.first().map(String::as_str).unwrap_or("all");
    let http = reqwest::Client::new();
    let fetch = |kind: &str, url: String| {
        let http = http.clone();
        let kind = kind.to_string();
        async move {
            let result = http
                .get(format!("{}/health", url))
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await;
            match result {
                Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
                Err(_) => None,
            }
            .map(|health| json!({ "status": "online", "health": health }))
            .unwrap_or_else(|| json!({ "status": "offline", "health": null, "kind": kind }))
        }
    };
    let value = match model {
        "tts" => fetch("tts", config.tts_url.clone()).await,
        "sfx" => fetch("sfx", config.sfx_url.clone()).await,
        "music" => fetch("music", config.music_url.clone()).await,
        "post" | "audiosr" => fetch("post", config.post_url.clone()).await,
        "all" => json!({
            "tts": fetch("tts", config.tts_url.clone()).await,
            "sfx": fetch("sfx", config.sfx_url.clone()).await,
            "music": fetch("music", config.music_url.clone()).await,
            "post": fetch("post", config.post_url.clone()).await,
        }),
        other => {
            return Err(Error::Other(format!(
                "unknown server kind: {} — expected tts, sfx, music, post, or all",
                other
            )))
        }
    };
    print_json(&value)
}

pub(super) async fn server_config_get(config: &crate::models::AppConfig) -> Result<()> {
    print_json(&json!({
        "tts_url": config.tts_url,
        "sfx_url": config.sfx_url,
        "music_url": config.music_url,
        "post_url": config.post_url,
        "projects_dir": config.projects_dir,
        "models_dir": config.models_dir,
        "woosh_dir": config.woosh_dir,
    }))
}

pub(super) async fn server_config_set(
    config_path: &Path,
    mut config: crate::models::AppConfig,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    if let Some(value) = flag_opt(&flags, "tts_url") {
        config.tts_url = value;
    }
    if let Some(value) = flag_opt(&flags, "sfx_url") {
        config.sfx_url = value;
    }
    if let Some(value) = flag_opt(&flags, "music_url") {
        config.music_url = value;
    }
    if let Some(value) = flag_opt(&flags, "post_url") {
        config.post_url = value;
    }
    if let Some(value) = flag_opt(&flags, "projects_dir") {
        config.projects_dir = value;
    }
    if let Some(value) = flag_opt(&flags, "models_dir") {
        config.models_dir = value;
    }
    if let Some(value) = flag_opt(&flags, "woosh_dir") {
        config.woosh_dir = value;
    }
    write_json(config_path, &config)?;
    print_json(&config)
}

pub(super) async fn model_load(
    config: &crate::models::AppConfig,
    model: &str,
    rest: &[String],
) -> Result<()> {
    let flags = parse_flags(rest)?;
    let url = server_base_url(config, model)?;
    let http = reqwest::Client::new();
    let mut req = http.post(format!("{}/load", url));
    if let Some(variant) = flag_opt(&flags, "variant") {
        req = req.json(&json!({ "variant": variant }));
    }
    let body: serde_json::Value = req
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "load request to {}/load failed for {} server: {} — check `pharaoh server health {}`",
                url, model, e, model
            ))
        })?
        .json()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "load response from {}/load was not valid JSON: {}",
                url, e
            ))
        })?;
    print_json(&body)
}

pub(super) async fn model_unload(config: &crate::models::AppConfig, model: &str) -> Result<()> {
    let url = server_base_url(config, model)?;
    let body: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/unload", url))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "unload request to {}/unload failed for {} server: {} — check `pharaoh server health {}`",
                url, model, e, model
            ))
        })?
        .json()
        .await
        .unwrap_or_else(|_| json!({ "status": "ok" }));
    print_json(&body)
}

fn server_base_url(config: &crate::models::AppConfig, model: &str) -> Result<String> {
    match model {
        "tts" => Ok(config.tts_url.clone()),
        "sfx" => Ok(config.sfx_url.clone()),
        "music" => Ok(config.music_url.clone()),
        "post" | "audiosr" => Ok(config.post_url.clone()),
        other => Err(Error::Other(format!(
            "unknown server kind: {} — expected tts, sfx, music, or post",
            other
        ))),
    }
}

pub(super) async fn setup_status(config: &crate::models::AppConfig) -> Result<()> {
    let models_dir = PathBuf::from(&config.models_dir);
    let projects_dir = PathBuf::from(&config.projects_dir);
    let woosh_dir = PathBuf::from(&config.woosh_dir);
    let audioldm_cache_dir = std::env::var("PHARAOH_AUDIOLDM_CACHE_DIR")
        .or_else(|_| std::env::var("AUDIOLDM_CACHE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| models_dir.join("sfx/audioldm"));
    let inference_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../inference");
    let status = json!({
        "config": {
            "projects_dir": config.projects_dir,
            "models_dir": config.models_dir,
            "woosh_dir": config.woosh_dir,
            "tts_url": config.tts_url,
            "sfx_url": config.sfx_url,
            "music_url": config.music_url,
            "post_url": config.post_url,
        },
        "paths": {
            "projects_dir_exists": projects_dir.exists(),
            "models_dir_exists": models_dir.exists(),
            "woosh_dir_exists": woosh_dir.exists(),
            "woosh_venv_exists": woosh_dir.join(".venv/bin/python3").exists(),
            "tts_venv_exists": inference_dir.join(".venv-tts/bin/python3").exists(),
            "music_venv_exists": inference_dir.join(".venv-music/bin/python3").exists(),
            "audioldm_venv_exists": inference_dir.join(".venv-audioldm/bin/python3").exists(),
            "audiosr_venv_exists": inference_dir.join(".venv-audiosr/bin/python3").exists(),
            "tts_base_model_exists": models_dir.join("tts/base").exists(),
            "tts_voice_design_model_exists": models_dir.join("tts/voice_design").exists(),
            "tts_custom_voice_model_exists": models_dir.join("tts/custom_voice").exists(),
            "music_model_exists": models_dir.join("music").exists(),
            "audioldm_cache_dir": audioldm_cache_dir.to_string_lossy(),
            "audioldm_cache_exists": audioldm_cache_dir.exists(),
            "audiosr_cache_exists": models_dir.join("audiosr").exists(),
        }
    });
    print_json(&status)
}

pub(super) async fn setup_hardware() -> Result<()> {
    let profile = detect_hardware().await;
    print_json(&profile)
}
