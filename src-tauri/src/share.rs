//! Gruve share server — makes Pharaoh mesh-discoverable and multiplayer.
//!
//! The Tauri webview is not an HTTP server, and `invoke()` does not exist for
//! remote viewers (see gruve/DESIGN-FOR-GRUVE.md). This module gives Pharaoh
//! the "one process, one port" shape the Gruve contract wants:
//!
//!   GET  /                 → the built frontend (embedded assets or dist/)
//!   POST /invoke/{cmd}     → HTTP mirror of the Tauri command surface
//!   GET  /file?path=…      → audio streaming (Range-aware), projects-dir only
//!   GET  /health           → liveness
//!
//! It binds 127.0.0.1 only — mesh friends reach it exclusively through the
//! local Gruve agent's proxy (`/peer/<node>/apps/pharaoh/…`), which owns
//! transport and identity. A background task announces to the agent at
//! `http://127.0.0.1:8088/gruve/announce` and quietly retries forever, so the
//! app works fine without Gruve and pops into the lobby the moment it starts.
//!
//! Security model: the mesh is invited friends. Reads are always allowed;
//! mutations are gated behind the `share_collab` config flag and an explicit
//! allowlist (no config writes, no host-filesystem imports, no recording).

use std::path::PathBuf;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path as UrlPath, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands;
use crate::error::Error;
use crate::models::AppState;

const GRUVE_AGENT: &str = "http://127.0.0.1:8088";

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
}

/// Entry point, called once from lib.rs setup. Reads config and, when
/// share_enabled, starts the HTTP server + the announce heartbeat.
pub fn spawn(app: AppHandle) {
    let (enabled, port) = {
        let state = app.state::<AppState>();
        let cfg = state.app_config.read().expect("config lock poisoned");
        (cfg.share_enabled, cfg.share_port)
    };
    if !enabled {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/health", get(health))
            .route("/invoke/{cmd}", post(invoke_http))
            .route("/file", get(file_stream))
            .fallback(get(static_assets))
            .layer(middleware::from_fn(cors))
            .with_state(Ctx { app });

        let addr = format!("127.0.0.1:{port}");
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[share] could not bind {addr}: {e} — sharing disabled");
                return;
            }
        };
        println!("[share] Gruve share server on http://{addr}");

        // Announce only after the port is actually listening — the agent
        // refuses announces for dead ports.
        tauri::async_runtime::spawn(announce_loop(port));

        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[share] server error: {e}");
        }
    });
}

/// Re-announce to the local Gruve agent every ttl/3. Failures are silent:
/// no agent running is the normal standalone case.
async fn announce_loop(port: u16) {
    let client = reqwest::Client::new();
    let body = json!({
        "id": "pharaoh",
        "name": "Pharaoh",
        "port": port,
        "ttl": 60,
        "hue": 45, // gold — it's a pharaoh
        "icon": "whiteboard",
        "blurb": "AI audio drama studio — write, voice, score, mix together",
        "upstreams": { "api": port },
    });
    loop {
        let _ = client
            .post(format!("{GRUVE_AGENT}/gruve/announce"))
            .json(&body)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok", "app": "pharaoh" }))
}

/// Permissive CORS. Served through a Gruve agent everything is same-origin and
/// this never matters; it exists for the standalone-browser case (vite dev /
/// vite preview against the share server on another port). The server binds
/// loopback only, so "*" exposes nothing the local user can't already read.
async fn cors(req: Request, next: Next) -> Response {
    let preflight = req.method() == Method::OPTIONS;
    let mut res = if preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, range"),
    );
    res
}

// ── Static frontend ───────────────────────────────────────────────────────────

/// Serve the built frontend. Packaged builds use Tauri's embedded assets;
/// dev builds fall back to dist/ on disk (run `npm run build` once to share
/// while developing — the vite dev server can't be served under a sub-path).
async fn static_assets(State(ctx): State<Ctx>, uri: Uri) -> Response {
    let rel = uri.path().trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    if let Some(asset) = ctx.app.asset_resolver().get(format!("/{rel}")) {
        return ([(header::CONTENT_TYPE, asset.mime_type)], asset.bytes).into_response();
    }

    for base in dist_candidates() {
        let p = base.join(rel);
        if p.is_file() {
            if let Ok(bytes) = std::fs::read(&p) {
                return ([(header::CONTENT_TYPE, mime_for(rel))], bytes).into_response();
            }
        }
    }

    // SPA fallback: unknown non-asset paths get index.html.
    if !rel.contains('.') {
        if let Some(asset) = ctx.app.asset_resolver().get("/index.html".into()) {
            return ([(header::CONTENT_TYPE, asset.mime_type)], asset.bytes).into_response();
        }
        for base in dist_candidates() {
            let p = base.join("index.html");
            if let Ok(bytes) = std::fs::read(&p) {
                return ([(header::CONTENT_TYPE, "text/html".to_string())], bytes).into_response();
            }
        }
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn dist_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        v.push(cwd.join("dist"));        // launched from repo root
        v.push(cwd.join("../dist"));     // launched from src-tauri (tauri dev)
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.join("../../../dist")); // target/debug/pharaoh in dev
        }
    }
    v
}

fn mime_for(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wasm" => "application/wasm",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ── Audio file streaming ──────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct FileQuery {
    path: String,
}

/// Stream a file from inside the projects dir (project assets, palette takes,
/// renders, the character library). Anything outside it is refused — this is
/// the boundary that keeps "friends can hear the takes" from becoming
/// "friends can read ~/.ssh". Range requests are honoured so <audio> seeking
/// works in WebKit, which refuses to seek non-ranged media.
async fn file_stream(
    State(ctx): State<Ctx>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Response {
    let projects_dir = {
        let state = ctx.app.state::<AppState>();
        let cfg = state.app_config.read().expect("config lock poisoned");
        PathBuf::from(cfg.projects_dir.clone())
    };
    let Ok(projects_dir) = projects_dir.canonicalize() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "projects dir missing").into_response();
    };
    let Ok(path) = PathBuf::from(&q.path).canonicalize() else {
        return (StatusCode::NOT_FOUND, "no such file").into_response();
    };
    if !path.starts_with(&projects_dir) {
        return (StatusCode::FORBIDDEN, "outside projects dir").into_response();
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return (StatusCode::NOT_FOUND, "unreadable").into_response();
    };
    let mime = mime_for(&q.path);
    let total = bytes.len();

    if let Some((start, end)) = parse_range(&headers, total) {
        let slice = bytes[start..=end].to_vec();
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            )
            .body(Body::from(slice))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .body(Body::from(bytes))
        .unwrap()
}

/// Parse `Range: bytes=a-b` / `bytes=a-`. Returns inclusive (start, end).
fn parse_range(headers: &HeaderMap, total: usize) -> Option<(usize, usize)> {
    if total == 0 {
        return None;
    }
    let raw = headers.get(header::RANGE)?.to_str().ok()?;
    let spec = raw.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let start: usize = a.parse().ok()?;
    let end: usize = match b {
        "" => total - 1,
        s => s.parse().ok()?,
    };
    if start > end || end >= total {
        return None;
    }
    Some((start, end))
}

// ── Command dispatch ──────────────────────────────────────────────────────────

/// JSON arg helpers — the frontend sends the same camelCase keys it gives
/// `invoke()`, so extraction mirrors Tauri's own camelCase→snake_case mapping.
fn s(v: &Value, k: &str) -> Result<String, String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing string arg '{k}'"))
}
fn opt_s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}
fn u(v: &Value, k: &str) -> Result<u64, String> {
    v.get(k)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing integer arg '{k}'"))
}
fn de<T: serde::de::DeserializeOwned>(v: &Value, k: &str) -> Result<T, String> {
    let inner = v.get(k).ok_or_else(|| format!("missing arg '{k}'"))?;
    serde_json::from_value(inner.clone()).map_err(|e| format!("bad '{k}': {e}"))
}

fn ok<T: serde::Serialize>(r: Result<T, Error>) -> Result<Value, String> {
    r.map_err(|e| e.to_string())
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}
fn ok_plain<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

async fn invoke_http(
    State(ctx): State<Ctx>,
    UrlPath(cmd): UrlPath<String>,
    Json(args): Json<Value>,
) -> Response {
    let collab = {
        let state = ctx.app.state::<AppState>();
        let cfg = state.app_config.read().expect("config lock poisoned");
        cfg.share_collab
    };
    match dispatch(ctx.app.clone(), &cmd, &args, collab).await {
        Ok(value) => Json(value).into_response(),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

/// The HTTP mirror of the Tauri command surface. Read commands are always
/// available; mutating commands require share_collab. Commands not listed
/// here are host-only by construction (settings writes, fs imports/exports,
/// recording, library deletion).
async fn dispatch(
    app: AppHandle,
    cmd: &str,
    a: &Value,
    collab: bool,
) -> Result<Value, (StatusCode, String)> {
    use commands::*;

    let bad = |m: String| (StatusCode::BAD_REQUEST, m);

    // Mutations: everything below READ_ONLY_END is gated here.
    const COLLAB_CMDS: &[&str] = &[
        "update_project",
        "create_scene",
        "update_scene",
        "write_script",
        "update_script_row",
        "write_fountain",
        "update_sidecar_qa",
        "submit_tts_custom_voice",
        "submit_tts_voice_design",
        "submit_tts_voice_clone",
        "submit_sfx_t2a",
        "submit_music_text2music",
        "render_scene",
        "render_episode",
        "draft_scene",
    ];
    if COLLAB_CMDS.contains(&cmd) && !collab {
        return Err((
            StatusCode::FORBIDDEN,
            "collaborative editing is disabled on the host (Settings → Sharing)".into(),
        ));
    }

    let out: Result<Value, String> = match cmd {
        // ── Reads ───────────────────────────────────────────────────────
        "get_projects_dir" => ok_plain(project::get_projects_dir(app)),
        "list_projects" => ok(project::list_projects(app)),
        "get_project" => ok(project::get_project(app, s(a, "projectId").map_err(bad)?)),
        "open_project" => ok(project::open_project(app, s(a, "projectId").map_err(bad)?)),
        "list_scenes" => ok(project::list_scenes(app, s(a, "projectId").map_err(bad)?)),
        "get_scene" => ok(project::get_scene(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneId").map_err(bad)?,
        )),
        "read_script" => ok(script::read_script(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
        )),
        "read_fountain" => ok(script::read_fountain(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
        )),
        "get_app_config" => ok(settings::get_app_config(app).await),
        "get_server_health_all" => ok(settings::get_server_health_all(app).await),
        "detect_hardware" => ok_plain(inference::detect_hardware().await),
        "check_setup" => ok_plain(setup_check::check_setup().await),
        "read_sidecar" => ok(sidecar::read_sidecar(s(a, "audioPath").map_err(bad)?)),
        "get_takes" => ok(sidecar::get_takes(s(a, "baseAudioPath").map_err(bad)?)),
        "list_palette_takes" => ok(sidecar::list_palette_takes(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "characterId").map_err(bad)?,
            s(a, "emotion").map_err(bad)?,
        )),
        "list_generated_audio_assets" => ok(sidecar::list_generated_audio_assets(
            app,
            s(a, "projectId").map_err(bad)?,
        )),
        "get_waveform_peaks" => ok(audio::get_waveform_peaks(
            s(a, "path").map_err(bad)?,
            u(a, "numPeaks").map_err(bad)? as usize,
        )),
        "get_window_peaks" => ok(audio::get_window_peaks(
            s(a, "path").map_err(bad)?,
            u(a, "startMs").map_err(bad)? as f64,
            u(a, "endMs").map_err(bad)? as f64,
            u(a, "numPeaks").map_err(bad)? as usize,
        )),
        "get_duration_ms" => ok(audio::get_duration_ms(s(a, "path").map_err(bad)?)),
        "find_zero_crossings" => ok(audio::find_zero_crossings(
            s(a, "path").map_err(bad)?,
            u(a, "nearMs").map_err(bad)?,
        )),
        "read_render_meta" => ok(audio_engine::read_render_meta(s(a, "renderPath").map_err(bad)?).await),
        "list_spatial_spaces" => ok_plain(audio_spatial::list_spatial_spaces()),
        "list_library_characters" => ok(character::list_library_characters(app)),
        "get_library_character" => ok(character::get_library_character(
            app,
            s(a, "libraryId").map_err(bad)?,
        )),
        "list_rvc_models" => ok(rvc::list_rvc_models(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "characterId").map_err(bad)?,
        )
        .await),
        "get_corpus_status" => ok(rvc::get_corpus_status(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "characterId").map_err(bad)?,
        )
        .await),

        // ── Collab mutations (gated above) ──────────────────────────────
        "update_project" => ok(project::update_project(app, de(a, "project").map_err(bad)?)),
        "create_scene" => ok(project::create_scene(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "title").map_err(bad)?,
            opt_s(a, "description"),
            opt_s(a, "location"),
            u(a, "index").map_err(bad)? as u32,
        )),
        "update_scene" => ok(project::update_scene(
            app,
            s(a, "projectId").map_err(bad)?,
            de(a, "scene").map_err(bad)?,
        )),
        "write_script" => ok(script::write_script(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            de(a, "rows").map_err(bad)?,
        )),
        "update_script_row" => ok(script::update_script_row(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            u(a, "rowIndex").map_err(bad)? as usize,
            de(a, "fields").map_err(bad)?,
        )),
        "write_fountain" => ok(script::write_fountain(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            s(a, "text").map_err(bad)?,
        )),
        "update_sidecar_qa" => ok(sidecar::update_sidecar_qa(
            s(a, "audioPath").map_err(bad)?,
            s(a, "qaStatus").map_err(bad)?,
            s(a, "qaNotes").map_err(bad)?,
        )),
        "submit_tts_custom_voice" => ok(inference::submit_tts_custom_voice(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            u(a, "rowIndex").map_err(bad)? as usize,
            de(a, "params").map_err(bad)?,
        )
        .await),
        "submit_tts_voice_design" => ok(inference::submit_tts_voice_design(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            u(a, "rowIndex").map_err(bad)? as usize,
            de(a, "params").map_err(bad)?,
        )
        .await),
        "submit_tts_voice_clone" => ok(inference::submit_tts_voice_clone(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            u(a, "rowIndex").map_err(bad)? as usize,
            de(a, "params").map_err(bad)?,
        )
        .await),
        "submit_sfx_t2a" => ok(inference::submit_sfx_t2a(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            u(a, "rowIndex").map_err(bad)? as usize,
            de(a, "params").map_err(bad)?,
        )
        .await),
        "submit_music_text2music" => ok(inference::submit_music_text2music(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            u(a, "rowIndex").map_err(bad)? as usize,
            de(a, "params").map_err(bad)?,
        )
        .await),
        "render_scene" => ok(audio_engine::render_scene(
            app,
            s(a, "projectId").map_err(bad)?,
            s(a, "sceneSlug").map_err(bad)?,
            a.get("targetLufs").and_then(Value::as_f64).map(|f| f as f32),
        )
        .await),
        "render_episode" => ok(audio_engine::render_episode(
            app,
            s(a, "projectId").map_err(bad)?,
            u(a, "crossfadeMs").map_err(bad)?,
            a.get("targetLufs").and_then(Value::as_f64).map(|f| f as f32),
            a.get("sceneSlugs")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()
                .map_err(|e| bad(format!("bad sceneSlugs: {e}")))?,
        )
        .await),
        "draft_scene" => ok(llm::draft_scene(de(a, "args").map_err(bad)?).await),

        _ => {
            return Err((
                StatusCode::FORBIDDEN,
                format!("'{cmd}' is host-only — it is not available to mesh viewers"),
            ))
        }
    };

    out.map_err(|m| (StatusCode::BAD_REQUEST, m))
}
