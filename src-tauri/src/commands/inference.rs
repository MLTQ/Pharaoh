use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use crate::error::{Error, Result};

// ── Hardware detection ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct HardwareProfile {
    pub os: String,      // "macos" | "linux" | "windows"
    pub arch: String,    // "aarch64" | "x86_64" | other
    pub gpu: String,     // "cuda" | "mps" | "cpu"
    pub gpu_name: String, // e.g. "NVIDIA GeForce RTX 4090" or ""
}

#[tauri::command]
pub async fn detect_hardware() -> HardwareProfile {
    let os = if cfg!(target_os = "macos") { "macos" }
             else if cfg!(target_os = "linux") { "linux" }
             else { "windows" }.to_string();

    let arch = if cfg!(target_arch = "aarch64") { "aarch64" }
               else { "x86_64" }.to_string();

    // Apple Silicon → MPS
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return HardwareProfile { os, arch, gpu: "mps".into(), gpu_name: "Apple Silicon".into() };
    }

    // Try nvidia-smi for CUDA
    if let Ok(out) = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
    {
        if out.status.success() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            return HardwareProfile { os, arch, gpu: "cuda".into(), gpu_name: name };
        }
    }

    HardwareProfile { os, arch, gpu: "cpu".into(), gpu_name: String::new() }
}
use crate::models::{
    AppState, JobCompleteEvent, JobFailedEvent, JobProgressEvent, JobStatus,
    MusicText2MusicRequest, ServerHealth, SfxT2ARequest, SidecarMeta,
    TtsCustomVoiceRequest, TtsVoiceCloneRequest, TtsVoiceDesignRequest,
};
use chrono::Utc;

// ── Health check ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_server_health(
    app: AppHandle,
    model: String,
) -> Result<ServerHealth> {
    let state = app.state::<AppState>();
    let url = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        match model.as_str() {
            "tts"   => format!("{}/health", cfg.tts_url),
            "sfx"   => format!("{}/health", cfg.sfx_url),
            "music" => format!("{}/health", cfg.music_url),
            other   => return Err(Error::Other(format!("unknown model: {}", other))),
        }
    };
    let resp = state.http
        .get(&url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| Error::Other(format!("server unreachable: {}", e)))?;
    let health: ServerHealth = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("bad health response: {}", e)))?;
    Ok(health)
}

#[tauri::command]
pub async fn update_server_config(
    app: AppHandle,
    tts_url: Option<String>,
    sfx_url: Option<String>,
    music_url: Option<String>,
) -> Result<()> {
    let state = app.state::<AppState>();
    let mut cfg = state.server_config.write().map_err(|_| Error::Other("lock poisoned".into()))?;
    if let Some(u) = tts_url   { cfg.tts_url = u; }
    if let Some(u) = sfx_url   { cfg.sfx_url = u; }
    if let Some(u) = music_url { cfg.music_url = u; }
    Ok(())
}


// ── Model load / unload ──────────────────────────────────────────────────

#[tauri::command]
pub async fn load_model(
    app: AppHandle,
    model: String,
    variant: Option<String>,
) -> Result<()> {
    let state = app.state::<AppState>();
    let url = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        match model.as_str() {
            "tts"   => format!("{}/load", cfg.tts_url),
            "sfx"   => format!("{}/load", cfg.sfx_url),
            "music" => format!("{}/load", cfg.music_url),
            other   => return Err(Error::Other(format!("unknown model: {}", other))),
        }
    };
    let mut req = state.http.post(&url);
    if let Some(v) = variant {
        req = req.json(&serde_json::json!({ "variant": v }));
    }
    // Model loading can take 30-120 s on first call (weights → VRAM)
    let resp = req.timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| Error::Other(format!("load request failed: {}", e)))?;

    let body: serde_json::Value = resp.json().await
        .map_err(|e| Error::Other(format!("load response parse error: {}", e)))?;

    if body.get("status").and_then(|v| v.as_str()) == Some("error") {
        let msg = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(Error::Other(format!("model load failed: {}", msg)));
    }

    Ok(())
}

#[tauri::command]
pub async fn unload_model(
    app: AppHandle,
    model: String,
) -> Result<()> {
    let state = app.state::<AppState>();
    let url = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        match model.as_str() {
            "tts"   => format!("{}/unload", cfg.tts_url),
            "sfx"   => format!("{}/unload", cfg.sfx_url),
            "music" => format!("{}/unload", cfg.music_url),
            other   => return Err(Error::Other(format!("unknown model: {}", other))),
        }
    };
    state.http.post(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("unload request failed: {}", e)))?;
    Ok(())
}

// ── Background polling ───────────────────────────────────────────────────

async fn poll_until_done(
    app: AppHandle,
    http: reqwest::Client,
    jobs_url: String,
    job_id: String,
    model: String,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    sidecar_meta: SidecarMeta,
) {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;

        let result = http
            .get(format!("{}/{}", jobs_url, job_id))
            .timeout(Duration::from_secs(5))
            .send()
            .await;

        let status: JobStatus = match result {
            Ok(r) => match r.json().await {
                Ok(s) => s,
                Err(e) => {
                    let _ = app.emit("job-failed", &JobFailedEvent {
                        job_id: job_id.clone(),
                        model: model.clone(),
                        error: format!("parse error: {}", e),
                    });
                    return;
                }
            },
            Err(e) => {
                let _ = app.emit("job-failed", &JobFailedEvent {
                    job_id: job_id.clone(),
                    model: model.clone(),
                    error: format!("poll error: {}", e),
                });
                return;
            }
        };

        let _ = app.emit("job-progress", &JobProgressEvent {
            job_id: job_id.clone(),
            model: model.clone(),
            status: status.status.clone(),
            progress: status.progress,
        });

        match status.status.as_str() {
            "complete" => {
                let output_path = status.output_path.unwrap_or_default();
                // Write sidecar adjacent to the audio file
                let audio_path = std::path::Path::new(&output_path);
                let meta_path = audio_path.with_extension("wav.meta.json");
                let mut meta = sidecar_meta.clone();
                // Fill actual duration from WAV if readable
                if let Ok(reader) = hound::WavReader::open(audio_path) {
                    let spec = reader.spec();
                    let total_samples = reader.duration();
                    meta.duration_actual_ms = Some(
                        (total_samples as u64 * 1000) / spec.sample_rate as u64
                    );
                    meta.sample_rate = spec.sample_rate;
                }
                if let Ok(json) = serde_json::to_string_pretty(&meta) {
                    let _ = std::fs::write(&meta_path, json);
                }
                let _ = app.emit("job-complete", &JobCompleteEvent {
                    job_id: job_id.clone(),
                    model: model.clone(),
                    output_path,
                    project_id,
                    scene_slug,
                    row_index,
                });
                return;
            }
            "failed" => {
                let _ = app.emit("job-failed", &JobFailedEvent {
                    job_id: job_id.clone(),
                    model: model.clone(),
                    error: status.error.unwrap_or_else(|| "unknown error".into()),
                });
                return;
            }
            _ => {} // pending | running — keep polling
        }
    }
}


// ── TTS commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn submit_tts_custom_voice(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    params: TtsCustomVoiceRequest,
) -> Result<String> {
    let state = app.state::<AppState>();
    let (base_url, http) = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        (cfg.tts_url.clone(), state.http.clone())
    };

    let resp: serde_json::Value = http
        .post(format!("{}/generate/custom_voice", base_url))
        .json(&params)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("TTS server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("TTS response error: {}", e)))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id in response".into()))?
        .to_string();

    let meta = SidecarMeta {
        model: "qwen3-tts-customvoice".into(),
        model_variant: Some("1.7B".into()),
        prompt: params.text.clone(),
        instruct: if params.instruct.is_empty() { None } else { Some(params.instruct.clone()) },
        speaker: Some(params.speaker.clone()),
        language: Some(params.language.clone()),
        seed: params.seed,
        temperature: Some(params.temperature),
        top_p: Some(params.top_p),
        duration_target_ms: None,
        duration_actual_ms: None,
        sample_rate: 24000,
        generated_at: Utc::now(),
        parent: None,
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };

    tokio::spawn(poll_until_done(
        app.clone(),
        http,
        format!("{}/jobs", base_url),
        job_id.clone(),
        "tts".into(),
        project_id,
        scene_slug,
        row_index,
        meta,
    ));

    Ok(job_id)
}

#[tauri::command]
pub async fn submit_tts_voice_design(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    params: TtsVoiceDesignRequest,
) -> Result<String> {
    let state = app.state::<AppState>();
    let (base_url, http) = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        (cfg.tts_url.clone(), state.http.clone())
    };

    let resp: serde_json::Value = http
        .post(format!("{}/generate/voice_design", base_url))
        .json(&params)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("TTS server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("TTS response error: {}", e)))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id".into()))?
        .to_string();

    let meta = SidecarMeta {
        model: "qwen3-tts-voicedesign".into(),
        model_variant: Some("1.7B".into()),
        prompt: params.text.clone(),
        instruct: Some(params.voice_description.clone()),
        speaker: None,
        language: Some(params.language.clone()),
        seed: params.seed,
        temperature: Some(params.temperature),
        top_p: Some(params.top_p),
        duration_target_ms: None,
        duration_actual_ms: None,
        sample_rate: 24000,
        generated_at: Utc::now(),
        parent: None,
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };

    tokio::spawn(poll_until_done(
        app.clone(), http,
        format!("{}/jobs", base_url), job_id.clone(),
        "tts".into(), project_id, scene_slug, row_index, meta,
    ));
    Ok(job_id)
}

#[tauri::command]
pub async fn submit_tts_voice_clone(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    params: TtsVoiceCloneRequest,
) -> Result<String> {
    let state = app.state::<AppState>();
    let (base_url, http) = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        (cfg.tts_url.clone(), state.http.clone())
    };

    let resp: serde_json::Value = http
        .post(format!("{}/generate/voice_clone", base_url))
        .json(&params)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("TTS server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("TTS response error: {}", e)))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id".into()))?
        .to_string();

    let meta = SidecarMeta {
        model: "qwen3-tts-clone".into(),
        model_variant: Some("1.7B".into()),
        prompt: params.text.clone(),
        instruct: None,
        speaker: None,
        language: Some(params.language.clone()),
        seed: params.seed,
        temperature: Some(params.temperature),
        top_p: Some(params.top_p),
        duration_target_ms: None,
        duration_actual_ms: None,
        sample_rate: 24000,
        generated_at: Utc::now(),
        parent: Some(params.ref_audio_path.clone()),
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };

    tokio::spawn(poll_until_done(
        app.clone(), http,
        format!("{}/jobs", base_url), job_id.clone(),
        "tts".into(), project_id, scene_slug, row_index, meta,
    ));
    Ok(job_id)
}


// ── SFX commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn submit_sfx_t2a(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    params: SfxT2ARequest,
) -> Result<String> {
    let state = app.state::<AppState>();
    let (base_url, http) = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        (cfg.sfx_url.clone(), state.http.clone())
    };

    let resp: serde_json::Value = http
        .post(format!("{}/generate/t2a", base_url))
        .json(&params)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("SFX server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("SFX response error: {}", e)))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id".into()))?
        .to_string();

    let meta = SidecarMeta {
        model: format!("woosh-{}", params.model_variant.to_lowercase()),
        model_variant: Some(params.model_variant.clone()),
        prompt: params.prompt.clone(),
        instruct: None,
        speaker: None,
        language: None,
        seed: params.seed,
        temperature: None,
        top_p: None,
        duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
        duration_actual_ms: None,
        sample_rate: 48000,
        generated_at: Utc::now(),
        parent: None,
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };

    tokio::spawn(poll_until_done(
        app.clone(), http,
        format!("{}/jobs", base_url), job_id.clone(),
        "sfx".into(), project_id, scene_slug, row_index, meta,
    ));
    Ok(job_id)
}


// ── Music commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn submit_music_text2music(
    app: AppHandle,
    project_id: String,
    scene_slug: String,
    row_index: usize,
    params: MusicText2MusicRequest,
) -> Result<String> {
    let state = app.state::<AppState>();
    let (base_url, http) = {
        let cfg = state.server_config.read().map_err(|_| Error::Other("lock poisoned".into()))?;
        (cfg.music_url.clone(), state.http.clone())
    };

    let resp: serde_json::Value = http
        .post(format!("{}/generate/text2music", base_url))
        .json(&params)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("Music server error: {}", e)))?
        .json()
        .await
        .map_err(|e| Error::Other(format!("Music response error: {}", e)))?;

    let job_id = resp["job_id"]
        .as_str()
        .ok_or_else(|| Error::Other("missing job_id".into()))?
        .to_string();

    let meta = SidecarMeta {
        model: "ace-step-1.5".into(),
        model_variant: Some(params.lm_model_size.clone()),
        prompt: params.caption.clone(),
        instruct: if params.lyrics.is_empty() { None } else { Some(params.lyrics.clone()) },
        speaker: None,
        language: Some(params.language.clone()),
        seed: params.seed,
        temperature: None,
        top_p: None,
        duration_target_ms: Some((params.duration_seconds * 1000.0) as u64),
        duration_actual_ms: None,
        sample_rate: 44100,
        generated_at: Utc::now(),
        parent: if params.reference_audio_path.is_empty() { None } else { Some(params.reference_audio_path.clone()) },
        take_index: 1,
        qa_status: "unreviewed".into(),
        qa_notes: String::new(),
    };

    tokio::spawn(poll_until_done(
        app.clone(), http,
        format!("{}/jobs", base_url), job_id.clone(),
        "music".into(), project_id, scene_slug, row_index, meta,
    ));
    Ok(job_id)
}
