mod commands;
mod error;
mod models;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let projects_dir = app
                .path()
                .home_dir()
                .expect("could not resolve home dir")
                .join("pharaoh-projects");
            if !projects_dir.exists() {
                std::fs::create_dir_all(&projects_dir)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::script::read_script,
            commands::script::write_script,
            commands::script::update_script_row,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
