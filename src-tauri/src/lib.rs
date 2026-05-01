mod commands;
mod error;
mod models;

use tauri::Manager;
use models::{AppConfig, AppState};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Resolve config path: ~/Library/Application Support/ai.aureum.pharaoh/config.json
            let config_dir = app
                .path()
                .app_config_dir()
                .expect("could not resolve app config dir");
            let config_path = config_dir.join("config.json");

            // Load or build default AppConfig
            let home = app.path().home_dir().expect("could not resolve home dir");
            let app_config: AppConfig = if config_path.exists() {
                std::fs::read_to_string(&config_path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_else(|| AppConfig::with_home(&home))
            } else {
                AppConfig::with_home(&home)
            };

            // Ensure projects and models directories exist
            let projects_dir = std::path::PathBuf::from(&app_config.projects_dir);
            if !projects_dir.exists() {
                std::fs::create_dir_all(&projects_dir)?;
            }
            let models_dir = std::path::PathBuf::from(&app_config.models_dir);
            if !models_dir.exists() {
                std::fs::create_dir_all(&models_dir)?;
            }

            app.manage(AppState::new(config_path, app_config));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Project CRUD
            commands::project::create_project,
            commands::project::open_project,
            commands::project::list_projects,
            commands::project::get_project,
            commands::project::update_project,
            commands::project::create_scene,
            commands::project::update_scene,
            commands::project::get_scene,
            commands::project::list_scenes,
            commands::project::get_projects_dir,
            // Script CSV
            commands::script::read_script,
            commands::script::write_script,
            commands::script::update_script_row,
            // Inference / job submission
            commands::inference::check_server_health,
            commands::inference::update_server_config,
            commands::inference::load_model,
            commands::inference::unload_model,
            commands::inference::submit_tts_custom_voice,
            commands::inference::submit_tts_voice_design,
            commands::inference::submit_tts_voice_clone,
            commands::inference::submit_sfx_t2a,
            commands::inference::submit_music_text2music,
            // Settings / config
            commands::settings::get_app_config,
            commands::settings::save_app_config,
            commands::settings::get_server_health_all,
            // Sidecar
            commands::sidecar::write_sidecar,
            commands::sidecar::read_sidecar,
            commands::sidecar::get_takes,
            commands::sidecar::update_sidecar_qa,
            // Audio utilities
            commands::audio::get_waveform_peaks,
            commands::audio::get_duration_ms,
            commands::audio::find_zero_crossings,
            // Audio engine (ffmpeg)
            commands::audio_engine::normalize_clip,
            commands::audio_engine::resample_to_48k,
            commands::audio_engine::render_scene,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
