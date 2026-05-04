// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args();
    let _program = args.next();
    let remaining: Vec<String> = args.collect();

    if remaining.is_empty() {
        pharaoh_lib::run();
        return;
    }

    if let Err(error) = pharaoh_lib::run_cli(remaining) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
