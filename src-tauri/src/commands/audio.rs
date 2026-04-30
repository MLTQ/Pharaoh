use crate::error::{Error, Result};

/// Extract an array of `num_peaks` peak amplitude values (0.0–1.0) from a WAV file.
/// Uses RMS over windows for a smoother representation.
#[tauri::command]
pub fn get_waveform_peaks(path: String, num_peaks: usize) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(&path)
        .map_err(|e| Error::Other(format!("cannot open WAV: {}", e)))?;
    let spec = reader.spec();
    let total_samples = reader.duration() as usize;
    if total_samples == 0 || num_peaks == 0 {
        return Ok(vec![0.0; num_peaks]);
    }

    let _samples_per_peak = (total_samples / num_peaks).max(1);
    let max_val = match spec.bits_per_sample {
        8  => i32::from(i8::MAX) as f32,
        16 => i32::from(i16::MAX) as f32,
        24 => (1i32 << 23) as f32,
        32 => i32::MAX as f32,
        _  => i16::MAX as f32,
    };

    // Collect all samples as f32 (handles multi-channel by reading interleaved)
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            reader
                .samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|s| s as f32 / max_val)
                .collect()
        }
        hound::SampleFormat::Float => {
            reader
                .samples::<f32>()
                .filter_map(|s| s.ok())
                .collect()
        }
    };

    let mut peaks = Vec::with_capacity(num_peaks);
    for i in 0..num_peaks {
        let start = (i * raw.len()) / num_peaks;
        let end = ((i + 1) * raw.len()) / num_peaks;
        let window = &raw[start..end.min(raw.len())];
        let peak = if window.is_empty() {
            0.0_f32
        } else {
            window.iter().map(|s| s.abs()).fold(0.0_f32, f32::max)
        };
        peaks.push(peak.min(1.0));
    }
    Ok(peaks)
}

/// Get the duration of a WAV file in milliseconds.
#[tauri::command]
pub fn get_duration_ms(path: String) -> Result<u64> {
    let reader = hound::WavReader::open(&path)
        .map_err(|e| Error::Other(format!("cannot open WAV: {}", e)))?;
    let spec = reader.spec();
    let total_samples = reader.duration() as u64;
    let channels = spec.channels as u64;
    let per_channel = if channels > 0 { total_samples / channels } else { total_samples };
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
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .filter_map(|s| s.ok())
            .collect(),
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
