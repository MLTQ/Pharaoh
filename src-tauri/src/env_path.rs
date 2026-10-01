//! Give the app the user's real PATH.
//!
//! An app launched from Finder / the Dock on macOS (or from a desktop entry on
//! Linux) does not inherit the shell's PATH — it starts with roughly
//! `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew's `/opt/homebrew/bin` is missing,
//! so every `Command::new("ffmpeg")` failed and the setup banner reported
//! ffmpeg/sox as not installed although they were.
//!
//! `augment()` runs once at startup, before any threads exist, and rebuilds
//! PATH as: the login shell's PATH (the user's own order), then any entries the
//! process already had, then well-known tool directories that exist. Child
//! processes (ffmpeg, ffprobe, sox, setup.sh, git) inherit it.

use std::ffi::OsString;
use std::path::PathBuf;
#[cfg(unix)]
use std::time::{Duration, Instant};

/// Directories package managers install CLI tools into.
const WELL_KNOWN: &[&str] = &[
    "/opt/homebrew/bin",  // Homebrew, Apple Silicon
    "/opt/homebrew/sbin",
    "/usr/local/bin",     // Homebrew, Intel; manual installs
    "/opt/local/bin",     // MacPorts
    "~/.local/bin",       // pipx / uv
    "~/.cargo/bin",
];

pub fn augment() {
    #[cfg(unix)]
    {
        let current = std::env::var_os("PATH").unwrap_or_default();
        // A terminal or agent launch already has a full PATH; only pay for the
        // login shell (~0.6 s of rc files) when ffmpeg isn't findable — the
        // Finder/Dock case this exists for.
        let login = if on_path(&current, "ffmpeg") { None } else { login_shell_path() };
        let extras: Vec<PathBuf> = WELL_KNOWN.iter().map(|d| expand_home(d)).filter(|p| p.is_dir()).collect();
        let merged = merge(login.as_deref(), &current, &extras);
        if merged != current {
            std::env::set_var("PATH", merged);
        }
    }
}

/// Raise the soft open-file limit toward the hard limit (macOS caps the
/// request at OPEN_MAX = 10240). A Dock-launched app starts at 256, and
/// `render_scene` opens one ffmpeg input per placed row — a rebuilt chapter
/// can have hundreds. Child processes (ffmpeg) inherit the raised limit.
pub fn raise_fd_limit() {
    #[cfg(unix)]
    unsafe {
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            return;
        }
        let want: libc::rlim_t = 10_240;
        let target = if lim.rlim_max == libc::RLIM_INFINITY { want } else { lim.rlim_max.min(want) };
        if lim.rlim_cur < target {
            lim.rlim_cur = target;
            let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
        }
    }
}

/// Login shell PATH first, then the process's own entries, then existing
/// well-known directories — each directory once, first occurrence wins.
pub fn merge(login: Option<&std::ffi::OsStr>, current: &std::ffi::OsStr, extras: &[PathBuf]) -> OsString {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !p.as_os_str().is_empty() && seen.insert(p.clone()) {
            out.push(p);
        }
    };
    if let Some(l) = login {
        std::env::split_paths(l).for_each(&mut push);
    }
    std::env::split_paths(current).for_each(&mut push);
    extras.iter().cloned().for_each(&mut push);
    std::env::join_paths(out).unwrap_or_else(|_| current.to_os_string())
}

/// Whether an executable `cmd` exists in one of `path`'s directories.
pub fn on_path(path: &std::ffi::OsStr, cmd: &str) -> bool {
    std::env::split_paths(path).any(|d| {
        let f = d.join(cmd);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            f.is_file() || f.with_extension("exe").is_file()
        }
    })
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

/// PATH as the user's interactive login shell sets it, or None. Bounded to
/// 3 s and fed no stdin, so a slow or chatty shell config can't hang startup;
/// a marker separates the value from anything the rc files print.
#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    use std::os::unix::ffi::OsStringExt;
    use std::process::{Command, Stdio};

    if std::env::var_os("PHARAOH_SKIP_SHELL_PATH").is_some() {
        return None;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-ilc", "printf '\\n__PHARAOH_PATH__%s__END__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let start = text.rfind("__PHARAOH_PATH__")? + "__PHARAOH_PATH__".len();
    let end = text[start..].find("__END__")? + start;
    let value = text[start..end].trim();
    (!value.is_empty()).then(|| OsString::from_vec(value.as_bytes().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn login_order_first_then_current_then_extras_without_duplicates() {
        let gui = OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin");
        let login = OsStr::new("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
        let merged = merge(Some(login), gui, &[PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/opt/local/bin")]);
        assert_eq!(
            merged,
            OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/local/bin")
        );
    }

    #[test]
    fn without_a_login_shell_the_well_known_dirs_still_get_appended() {
        let merged = merge(None, OsStr::new("/usr/bin:/bin"), &[PathBuf::from("/opt/homebrew/bin")]);
        assert_eq!(merged, OsString::from("/usr/bin:/bin:/opt/homebrew/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn on_path_finds_executables_only() {
        assert!(on_path(OsStr::new("/bin:/usr/bin"), "sh"));
        assert!(!on_path(OsStr::new("/bin:/usr/bin"), "definitely-not-a-tool-xyz"));
        assert!(!on_path(OsStr::new("/etc"), "hosts"), "a non-executable file is not a tool");
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_login_shell_path() {
        // Whatever the developer's shell is, its PATH must parse and be non-empty.
        let p = login_shell_path().expect("login shell PATH");
        assert!(std::env::split_paths(&p).count() > 1);
    }
}
