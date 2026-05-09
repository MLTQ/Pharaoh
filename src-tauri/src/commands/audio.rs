use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

/// Extract `num_peaks` amplitude peaks (0.0–1.0) from a WAV file.
///
/// Peaks are computed once per (file, resolution) pair and cached to
/// `<wav_path>.peaks.<num_peaks>.json` next to the audio file. Subsequent
/// calls with the same arguments read the cache directly instead of re-
/// streaming millions of samples through hound. The cache is invalidated
/// when the WAV's mtime is newer than the cache's mtime, which covers the
/// rare case of an asset being overwritten in place.
///
/// Cost profile:
///   first call (cold):  ~30–100ms per second of audio (hound stream)
///   later calls (warm): sub-millisecond JSON read
#[tauri::command]
pub fn get_waveform_peaks(path: String, num_peaks: usize) -> Result<Vec<f32>> {
    if num_peaks == 0 {
        return Ok(vec![]);
    }
    let cache_path = peaks_cache_path(&path, num_peaks);
    if let Some(cached) = read_cached_peaks(&cache_path, &path) {
        return Ok(cached);
    }
    let peaks = compute_waveform_peaks(&path, num_peaks)?;
    // Best-effort cache write — failures are non-fatal (e.g. read-only fs)
    let _ = write_cached_peaks(&cache_path, &peaks);
    Ok(peaks)
}

fn peaks_cache_path(audio_path: &str, num_peaks: usize) -> PathBuf {
    PathBuf::from(format!("{}.peaks.{}.json", audio_path, num_peaks))
}

fn read_cached_peaks(cache_path: &Path, audio_path: &str) -> Option<Vec<f32>> {
    let cache_meta = std::fs::metadata(cache_path).ok()?;
    let audio_meta = std::fs::metadata(audio_path).ok()?;
    let cache_mtime = cache_meta.modified().ok()?;
    let audio_mtime = audio_meta.modified().ok()?;
    if cache_mtime < audio_mtime {
        return None; // stale — WAV was modified after cache was written
    }
    let bytes = std::fs::read(cache_path).ok()?;
    serde_json::from_slice::<Vec<f32>>(&bytes).ok()
}

fn write_cached_peaks(cache_path: &Path, peaks: &[f32]) -> Result<()> {
    let bytes = serde_json::to_vec(peaks)?;
    std::fs::write(cache_path, bytes).map_err(Error::Io)
}

fn compute_waveform_peaks(path: &str, num_peaks: usize) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| Error::Other(format!("cannot open WAV: {}", e)))?;
    let spec = reader.spec();
    let total_samples = reader.duration() as usize;
    if total_samples == 0 {
        return Ok(vec![0.0; num_peaks]);
    }

    let samples_per_peak = (total_samples / num_peaks).max(1);
    let max_val = match spec.bits_per_sample {
        8  => i32::from(i8::MAX) as f32,
        16 => i32::from(i16::MAX) as f32,
        24 => (1i32 << 23) as f32,
        32 => i32::MAX as f32,
        _  => i16::MAX as f32,
    };

    let mut peaks = vec![0.0_f32; num_peaks];
    match spec.sample_format {
        hound::SampleFormat::Int => {
            for (i, sample) in reader.samples::<i32>().filter_map(|s| s.ok()).enumerate() {
                let peak_index = (i / samples_per_peak).min(num_peaks - 1);
                peaks[peak_index] = peaks[peak_index].max((sample as f32 / max_val).abs());
            }
        }
        hound::SampleFormat::Float => {
            for (i, sample) in reader.samples::<f32>().filter_map(|s| s.ok()).enumerate() {
                let peak_index = (i / samples_per_peak).min(num_peaks - 1);
                peaks[peak_index] = peaks[peak_index].max(sample.abs());
            }
        }
    }
    for peak in &mut peaks {
        *peak = peak.min(1.0);
    }
    Ok(peaks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_test_wav(path: &Path, seconds: u32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        let total = (spec.sample_rate * seconds) as usize;
        for i in 0..total {
            // Simple ramp so peaks vary over time
            let v = ((i as f32 / total as f32) * (i16::MAX as f32 * 0.5)) as i16;
            writer.write_sample(v).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn cache_roundtrip() {
        let dir = std::env::temp_dir().join(format!("pharaoh_peaks_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("clip.wav");
        write_test_wav(&wav, 2);

        // Cold call: cache should be missing, computes from WAV, writes cache
        let p1 = get_waveform_peaks(wav.to_string_lossy().to_string(), 60).unwrap();
        let cache = peaks_cache_path(&wav.to_string_lossy(), 60);
        assert!(cache.exists(), "cache file should exist after first call");
        assert_eq!(p1.len(), 60);

        // Warm call: should read cache and produce identical peaks
        let p2 = get_waveform_peaks(wav.to_string_lossy().to_string(), 60).unwrap();
        assert_eq!(p1, p2, "warm read should return identical peaks");

        // Different num_peaks → separate cache file
        let _p3 = get_waveform_peaks(wav.to_string_lossy().to_string(), 120).unwrap();
        let cache_120 = peaks_cache_path(&wav.to_string_lossy(), 120);
        assert!(cache_120.exists() && cache.exists(), "different resolutions cache separately");

        // Stale cache: bump WAV mtime and verify cache is rebuilt
        // (re-write cache with bogus content so we can detect a refresh)
        let mut f = std::fs::File::create(&cache).unwrap();
        f.write_all(b"[0.0, 0.0, 0.0]").unwrap();
        drop(f);
        // Touch the WAV so its mtime > cache's mtime
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // Re-write the WAV to force a newer mtime
        write_test_wav(&wav, 2);
        let p4 = get_waveform_peaks(wav.to_string_lossy().to_string(), 60).unwrap();
        assert_eq!(p4.len(), 60, "stale cache must be rebuilt at requested resolution");
        assert_ne!(p4, vec![0.0, 0.0, 0.0], "stale cache should be ignored");

        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Get the duration of a WAV file in milliseconds.
#[tauri::command]
pub fn get_duration_ms(path: String) -> Result<u64> {
    let reader = hound::WavReader::open(&path)
        .map_err(|e| Error::Other(format!("cannot open WAV: {}", e)))?;
    let spec = reader.spec();
    let total_samples = reader.duration() as u64;
    let channels = spec.channels as u64;
    let per_channel = if channels > 0 {
        total_samples / channels
    } else {
        total_samples
    };
    Ok((per_channel * 1000) / spec.sample_rate as u64)
}

/// Find the nearest zero-crossing in a WAV file, searching ±200ms around `near_ms`.
#[tauri::command]
pub fn find_zero_crossings(path: String, near_ms: u64) -> Result<Vec<u64>> {
    let mut reader = hound::WavReader::open(&path)
        .map_err(|e| Error::Other(format!("cannot open WAV: {}", e)))?;
    let spec = reader.spec();
    let sr = spec.sample_rate as u64;
    let near_sample = (near_ms * sr / 1000) as usize;
    let window = (200 * sr / 1000) as usize; // ±200ms
    let start = near_sample.saturating_sub(window);
    let end = near_sample + window;

    let all_samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i32>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32)
            .collect(),
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(|s| s.ok()).collect(),
    };

    let mut crossings = vec![];
    let end = end.min(all_samples.len().saturating_sub(1));
    for i in start..end {
        if i + 1 < all_samples.len() && all_samples[i] * all_samples[i + 1] <= 0.0 {
            crossings.push((i as u64 * 1000) / sr);
        }
    }
    Ok(crossings)
}
