// Startup-time setup integrity check.
//
// Surfaces missing external tools (ffmpeg required, sox optional but used by
// Qwen3-TTS clone preprocessing) so the frontend can render a persistent
// banner with a one-line install hint instead of letting the user discover
// a tool is missing only when a render fails 30 seconds in.

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct ToolStatus {
    pub ok: bool,
    /// First line of `<tool> -version` stdout (e.g. "ffmpeg version 7.1.1").
    pub version: Option<String>,
    /// User-facing description of how to fix this on the current platform.
    pub hint: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SetupReport {
    pub ffmpeg: ToolStatus,
    pub sox: ToolStatus,
    /// True if the user can render at all (ffmpeg present).
    pub render_ready: bool,
}

fn check_tool(cmd: &str, version_args: &[&str], hint: &str) -> ToolStatus {
    match std::process::Command::new(cmd).args(version_args).output() {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let first_line = stdout.lines().next().map(|s| s.trim().to_string());
            ToolStatus { ok: true, version: first_line, hint: hint.to_string() }
        }
        _ => ToolStatus { ok: false, version: None, hint: hint.to_string() },
    }
}

fn ffmpeg_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Install with `brew install ffmpeg`"
    } else if cfg!(target_os = "linux") {
        "Install with `apt install ffmpeg` or your distro's equivalent"
    } else {
        "Download from https://www.gyan.dev/ffmpeg/builds/ and add to PATH"
    }
}

fn sox_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Optional — for voice clone preprocessing. `brew install sox`"
    } else if cfg!(target_os = "linux") {
        "Optional — for voice clone preprocessing. `apt install sox`"
    } else {
        "Optional — download from https://sourceforge.net/projects/sox/"
    }
}

#[tauri::command]
pub async fn check_setup() -> SetupReport {
    // ffmpeg uses `-version` (not `--version`)
    let ffmpeg = check_tool("ffmpeg", &["-version"], ffmpeg_install_hint());
    let sox = check_tool("sox", &["--version"], sox_install_hint());
    SetupReport {
        render_ready: ffmpeg.ok,
        ffmpeg,
        sox,
    }
}
