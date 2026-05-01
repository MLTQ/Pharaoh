use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use crate::error::{Error, Result};

// ── Event payload ─────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct SetupProgress {
    pub step: usize,
    pub total_steps: usize,
    pub label: String,
    pub bytes_done: u64,
    pub bytes_total: u64,  // 0 = indeterminate
    pub done: bool,
    pub error: Option<String>,
}

// ── Required checkpoints ──────────────────────────────────────────────────────

const REPO_URL: &str = "https://github.com/SonyResearch/Woosh.git";
const RELEASE_BASE: &str = "https://github.com/SonyResearch/Woosh/releases/download/v1.0.0";

struct Checkpoint {
    name: &'static str,
    zip: &'static str,
    /// Directory created inside woosh_dir/checkpoints/ after extraction
    check_dir: &'static str,
}

const CHECKPOINTS: &[Checkpoint] = &[
    Checkpoint { name: "Woosh-AE",         zip: "Woosh-AE.zip",          check_dir: "Woosh-AE"         },
    Checkpoint { name: "TextConditionerA", zip: "TextConditionerA.zip",  check_dir: "TextConditionerA" },
    Checkpoint { name: "Woosh-DFlow",      zip: "Woosh-DFlow.zip",       check_dir: "Woosh-DFlow"      },
];

// Each checkpoint = 1 download step + 1 extract step + 1 clone step = 7 total
const TOTAL_STEPS: usize = 1 + CHECKPOINTS.len() * 2;

// ── Helper: expand ~ in paths ─────────────────────────────────────────────────

fn expand_home(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(format!("{}/{}", home, &path[2..]))
    } else {
        PathBuf::from(path)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn emit(app: &AppHandle, step: usize, label: &str, bytes_done: u64, bytes_total: u64, done: bool, error: Option<String>) {
    let _ = app.emit("woosh_setup", SetupProgress {
        step, total_steps: TOTAL_STEPS,
        label: label.to_string(),
        bytes_done, bytes_total,
        done, error,
    });
}

async fn run_git_clone(dest: &PathBuf) -> std::result::Result<(), String> {
    let parent = dest.parent().unwrap_or(dest);
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let out = tokio::process::Command::new("git")
        .args(["clone", "--depth=1", REPO_URL, dest.to_str().unwrap_or("")])
        .output()
        .await
        .map_err(|e| format!("git not found — install Xcode Command Line Tools or Homebrew git: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

async fn download_file(app: &AppHandle, step: usize, label: &str, url: &str, dest: &PathBuf) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| Error::Other(e.to_string()))?;

    let resp = client.get(url).send().await
        .map_err(|e| Error::Other(format!("download failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(Error::Other(format!("HTTP {} for {url}", resp.status())));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await
        .map_err(|e| Error::Other(format!("cannot create {}: {e}", dest.display())))?;

    let mut bytes_done = 0u64;
    let mut response = resp;
    while let Some(chunk) = response.chunk().await.map_err(|e| Error::Other(e.to_string()))? {
        file.write_all(&chunk).await?;
        bytes_done += chunk.len() as u64;
        emit(app, step, label, bytes_done, total, false, None);
    }
    file.flush().await?;
    Ok(())
}

fn extract_zip(zip_path: &PathBuf, dest_dir: &PathBuf) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| Error::Other(format!("bad zip: {e}")))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| Error::Other(e.to_string()))?;
        let out_path = match entry.enclosed_name() {
            Some(p) => dest_dir.join(p),
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out_file = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out_file)?;
        }
    }
    Ok(())
}

// ── Command ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn setup_woosh(app: AppHandle, dest_dir: String) -> Result<()> {
    let dest = expand_home(&dest_dir);
    let mut step = 0usize;

    // ── Step 1: clone (skip if .git already present) ─────────────────────────
    step += 1;
    let git_dir = dest.join(".git");
    if git_dir.exists() {
        emit(&app, step, "Repository already cloned — skipping", 0, 0, false, None);
    } else {
        emit(&app, step, "Cloning SonyResearch/Woosh…", 0, 0, false, None);
        if let Err(e) = run_git_clone(&dest).await {
            emit(&app, step, "Clone failed", 0, 0, false, Some(e.clone()));
            return Err(Error::Other(e));
        }
        emit(&app, step, "Repository cloned", 0, 0, false, None);
    }

    // ── Steps 2–7: download + extract each checkpoint ────────────────────────
    for cp in CHECKPOINTS {
        let ckpt_dir = dest.join("checkpoints").join(cp.check_dir);

        // Download
        step += 1;
        let zip_path = dest.join(cp.zip);
        if ckpt_dir.exists() {
            emit(&app, step, &format!("{} already present — skipping", cp.name), 0, 0, false, None);
        } else {
            let url = format!("{}/{}", RELEASE_BASE, cp.zip);
            let label = format!("Downloading {} ({})", cp.name,
                match cp.zip {
                    "Woosh-AE.zip"          => "0.8 GB",
                    "TextConditionerA.zip"  => "1.2 GB",
                    _                       => "1.2 GB",
                }
            );
            emit(&app, step, &label, 0, 0, false, None);
            if let Err(e) = download_file(&app, step, &label, &url, &zip_path).await {
                let msg = e.to_string();
                emit(&app, step, &format!("Download failed: {}", cp.name), 0, 0, false, Some(msg.clone()));
                return Err(e);
            }
        }

        // Extract
        step += 1;
        if ckpt_dir.exists() {
            emit(&app, step, &format!("{} already extracted — skipping", cp.name), 0, 0, false, None);
        } else {
            emit(&app, step, &format!("Extracting {}…", cp.name), 0, 0, false, None);
            let zip_path2 = zip_path.clone();
            let dest2 = dest.clone();
            let result = tokio::task::spawn_blocking(move || extract_zip(&zip_path2, &dest2))
                .await
                .map_err(|e| Error::Other(e.to_string()))?;

            if let Err(e) = result {
                let msg = e.to_string();
                emit(&app, step, &format!("Extract failed: {}", cp.name), 0, 0, false, Some(msg.clone()));
                return Err(Error::Other(msg));
            }
            // Remove zip to save disk space
            let _ = tokio::fs::remove_file(&zip_path).await;
            emit(&app, step, &format!("{} extracted", cp.name), 0, 0, false, None);
        }
    }

    // ── Done ─────────────────────────────────────────────────────────────────
    emit(&app, TOTAL_STEPS, "Setup complete", 0, 0, true, None);
    Ok(())
}
