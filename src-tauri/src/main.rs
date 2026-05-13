// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args();
    let _program = args.next();
    let remaining: Vec<String> = args.collect();

    if remaining.is_empty() {
        #[cfg(target_os = "linux")]
        ensure_linux_gui_environment();

        pharaoh_lib::run();
        return;
    }

    if let Err(error) = pharaoh_lib::run_cli(remaining) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn ensure_linux_gui_environment() {
    let has_wayland = has_non_empty_env("WAYLAND_DISPLAY");
    let has_x11 = has_non_empty_env("DISPLAY");

    if has_wayland || has_x11 {
        return;
    }

    eprintln!(
        "Pharaoh GUI needs a Linux desktop session, but neither WAYLAND_DISPLAY nor DISPLAY is set."
    );
    eprintln!("Launch the AppImage from your desktop session, or pass a CLI command instead:");
    eprintln!("  ./pharaoh-linux-x64-appimage.AppImage setup hardware");
    eprintln!("  ./pharaoh-linux-x64-appimage.AppImage setup status");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
fn has_non_empty_env(name: &str) -> bool {
    std::env::var_os(name)
        .map(|value| !value.to_string_lossy().is_empty())
        .unwrap_or(false)
}
