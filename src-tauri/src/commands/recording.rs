//! Audio recording via CPAL (CoreAudio on macOS).
//!
//! Exposes three Tauri commands:
//!   list_audio_inputs  — enumerate available input devices
//!   start_recording    — open a CPAL stream, write f32 WAV, emit peak events
//!   stop_recording     — finalize WAV, return path + duration
//!
//! The live level meter is pushed to the frontend via `recording:peak` events
//! (~30 Hz) so the UI can show a real-time bar without polling.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::io::BufWriter;
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::error::{Error, Result};

// ── Public managed state ──────────────────────────────────────────────────────

struct ActiveRecording {
    /// Kept alive to maintain the CPAL stream; dropped in stop_recording.
    _stream: cpal::Stream,
    /// Closing this sender signals the writer thread to flush and exit.
    sample_tx: mpsc::SyncSender<Vec<f32>>,
    output_path: String,
    sample_rate: u32,
    channels: u16,
    /// Joined in stop_recording to get total samples written.
    writer_handle: std::thread::JoinHandle<u64>,
}

// SAFETY: cpal::Stream is Send on macOS (CoreAudio) and Windows (WASAPI).
// The stream callback runs on a dedicated audio thread; we only touch the
// stream handle here to keep it alive and to drop it on stop.
unsafe impl Send for ActiveRecording {}

pub struct RecordingState(pub Arc<Mutex<Option<ActiveRecording>>>);

impl RecordingState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

// ── Data types returned to the frontend ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    /// Display name as reported by the OS driver (e.g. "Apollo Twin USB").
    pub name: String,
    /// Maximum number of input channels the device supports.
    pub channels: u16,
    /// Discrete sample rates supported by the device (intersection with our
    /// preferred set: 44100, 48000, 88200, 96000).
    pub sample_rates: Vec<u32>,
    /// Whether this is the system default input device.
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
pub struct RecordingResult {
    pub path: String,
    pub duration_ms: u64,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Return all available audio input devices with their capabilities.
#[tauri::command]
pub fn list_audio_inputs() -> Result<Vec<AudioDevice>> {
    let host = cpal::default_host();

    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let devices = host
        .input_devices()
        .map_err(|e| Error::Other(format!("CPAL host error: {}", e)))?;

    let preferred_rates: &[u32] = &[44100, 48000, 88200, 96000];
    let mut result: Vec<AudioDevice> = Vec::new();

    for device in devices {
        let name = match device.name() {
            Ok(n) => n,
            Err(_) => continue,
        };

        let configs: Vec<_> = match device.supported_input_configs() {
            Ok(c) => c.collect(),
            Err(_) => continue,
        };
        if configs.is_empty() {
            continue;
        }

        let channels = configs.iter().map(|c| c.channels()).max().unwrap_or(2);

        let mut sample_rates: Vec<u32> = preferred_rates
            .iter()
            .copied()
            .filter(|&r| {
                configs.iter().any(|c| {
                    r >= c.min_sample_rate().0
                        && r <= c.max_sample_rate().0
                        && c.channels() >= 1
                })
            })
            .collect();
        sample_rates.sort_unstable();
        sample_rates.dedup();

        if sample_rates.is_empty() {
            continue;
        }

        result.push(AudioDevice {
            is_default: name == default_name,
            name,
            channels,
            sample_rates,
        });
    }

    // Put the default device first.
    result.sort_by(|a, b| b.is_default.cmp(&a.is_default));

    Ok(result)
}

/// Open a CPAL input stream on `device_name` and start writing samples to a
/// 32-bit float WAV at `output_path`.  Emits `recording:peak` events with
/// `{ peak_db, rms_db }` ~30 times per second for the level meter.
///
/// Returns immediately after the stream is started; call `stop_recording` to
/// finalize the file.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, RecordingState>,
    device_name: String,
    output_path: String,
    mono: bool,
    sample_rate: u32,
) -> Result<()> {
    {
        let guard = state
            .0
            .lock()
            .map_err(|e| Error::Other(e.to_string()))?;
        if guard.is_some() {
            return Err(Error::Other(
                "A recording is already in progress".into(),
            ));
        }
    }

    // ── Locate the requested device ───────────────────────────────────────
    let host = cpal::default_host();
    let device = host
        .input_devices()
        .map_err(|e| Error::Other(format!("CPAL host error: {}", e)))?
        .find(|d| d.name().ok().as_deref() == Some(device_name.as_str()))
        .ok_or_else(|| Error::Other(format!("audio device '{}' not found", device_name)))?;

    let target_channels: u16 = if mono { 1 } else { 2 };

    // Find a supported config that covers target_channels and sample_rate.
    // We prefer exact channel match; fall back to a higher channel count and
    // downmix in the callback.
    let stream_config = device
        .supported_input_configs()
        .map_err(|e| Error::Other(e.to_string()))?
        .filter(|c| {
            c.channels() >= target_channels
                && c.min_sample_rate().0 <= sample_rate
                && c.max_sample_rate().0 >= sample_rate
        })
        .min_by_key(|c| c.channels()) // prefer fewest channels ≥ target
        .ok_or_else(|| {
            Error::Other(format!(
                "'{}' does not support {}Hz / {}ch — check UA Console sample rate",
                device_name,
                sample_rate,
                target_channels
            ))
        })?
        .with_sample_rate(cpal::SampleRate(sample_rate));

    let stream_channels = stream_config.channels() as usize;

    // ── Writer thread ─────────────────────────────────────────────────────
    // Receives f32 chunks from the CPAL callback, writes them to a hound
    // WavWriter.  The channel closes when we drop the sender in stop_recording,
    // causing recv() to return Err and the thread to flush+finalize.
    let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<f32>>(128);

    let output_path_clone = output_path.clone();
    let writer_handle: std::thread::JoinHandle<u64> = {
        let spec = hound::WavSpec {
            channels: target_channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        std::thread::spawn(move || {
            let file = match std::fs::File::create(&output_path_clone) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("recording: cannot create {}: {}", output_path_clone, e);
                    return 0u64;
                }
            };
            let mut writer =
                match hound::WavWriter::new(BufWriter::new(file), spec) {
                    Ok(w) => w,
                    Err(e) => {
                        eprintln!("recording: hound error: {}", e);
                        return 0u64;
                    }
                };
            let mut total = 0u64;
            while let Ok(chunk) = sample_rx.recv() {
                for s in &chunk {
                    let _ = writer.write_sample(*s);
                }
                total += chunk.len() as u64;
            }
            let _ = writer.flush();
            let _ = writer.finalize();
            total
        })
    };

    // ── CPAL stream ───────────────────────────────────────────────────────
    let tx = sample_tx.clone();
    let target_ch = target_channels as usize;

    // Throttle peak events: emit at most once every ~33 ms.
    let last_emit = Arc::new(Mutex::new(std::time::Instant::now()));
    let last_emit_cb = Arc::clone(&last_emit);

    let stream = device
        .build_input_stream(
            &stream_config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Downmix to target_channels if the device opened with more.
                let chunk: Vec<f32> = if stream_channels == target_ch {
                    data.to_vec()
                } else {
                    data.chunks(stream_channels)
                        .flat_map(|frame| frame.iter().take(target_ch).copied())
                        .collect()
                };

                // Level meter — emit ~30 Hz.
                let now = std::time::Instant::now();
                let emit_now = {
                    let mut last = last_emit_cb.lock().unwrap();
                    if now.duration_since(*last).as_millis() >= 33 {
                        *last = now;
                        true
                    } else {
                        false
                    }
                };
                if emit_now && !chunk.is_empty() {
                    let peak = chunk
                        .iter()
                        .copied()
                        .fold(0.0f32, |a, s| a.max(s.abs()));
                    let rms = (chunk.iter().map(|s| s * s).sum::<f32>()
                        / chunk.len() as f32)
                        .sqrt();
                    let to_db = |v: f32| {
                        if v > 0.0 {
                            (20.0 * v.log10()).max(-96.0)
                        } else {
                            -96.0
                        }
                    };
                    let _ = app.emit(
                        "recording:peak",
                        serde_json::json!({
                            "peak_db": to_db(peak),
                            "rms_db":  to_db(rms),
                        }),
                    );
                }

                // Forward to writer (non-blocking; drop chunks if writer falls behind).
                let _ = tx.try_send(chunk);
            },
            |err| eprintln!("CPAL stream error: {}", err),
            None,
        )
        .map_err(|e| Error::Other(format!("CPAL build_input_stream: {}", e)))?;

    stream
        .play()
        .map_err(|e| Error::Other(format!("CPAL play: {}", e)))?;

    // ── Persist active recording ──────────────────────────────────────────
    let mut guard = state
        .0
        .lock()
        .map_err(|e| Error::Other(e.to_string()))?;
    *guard = Some(ActiveRecording {
        _stream: stream,
        sample_tx,
        output_path,
        sample_rate,
        channels: target_channels,
        writer_handle,
    });

    Ok(())
}

/// Stop the current recording, finalize the WAV, and return its path and
/// duration.  Safe to call even if no recording is in progress (returns an
/// error in that case).
#[tauri::command]
pub async fn stop_recording(state: State<'_, RecordingState>) -> Result<RecordingResult> {
    // Take the ActiveRecording out of managed state while holding the lock for
    // the minimum time.  We must not hold the lock while joining the writer
    // thread — that would deadlock if the callback tried to lock it.
    let rec = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| Error::Other(e.to_string()))?;
        guard
            .take()
            .ok_or_else(|| Error::Other("No recording in progress".into()))?
    };

    // Dropping the stream stops the CPAL callback.
    // Dropping sample_tx closes the channel → writer thread exits.
    drop(rec._stream);
    drop(rec.sample_tx);

    let total_samples = rec
        .writer_handle
        .join()
        .map_err(|_| Error::Other("Recording writer thread panicked".into()))?;

    // total_samples counts individual f32 values (interleaved channels).
    let total_frames = total_samples / rec.channels as u64;
    let duration_ms =
        (total_frames as f64 / rec.sample_rate as f64 * 1000.0).round() as u64;

    Ok(RecordingResult {
        path: rec.output_path,
        duration_ms,
    })
}
