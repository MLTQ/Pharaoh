#!/usr/bin/env python3
"""
Synthesize plausible stereo room impulse responses for Pharaoh's spatial
spaces catalog.

The downloader (`inference/download_spatial_assets.sh`) calls into this
script for any preset whose URL is null or whose download fails, so the
install always succeeds. Users who later drop a real measured IR into
`assets/spaces/` transparently override the synthetic one — same filename,
same slug, no manifest edit needed.

Algorithm per preset (parameters in `spaces.json` → `synthesis` block):
  1. Optional predelay (silence at the start of the IR).
  2. Direct sound (dirac impulse at both ears).
  3. A handful of discrete early reflections inside the first ~80 ms,
     amplitudes tapering and slightly decorrelated L/R.
  4. A diffuse exponential-decay noise tail from ~80 ms onward, sized to
     hit -60 dB at the specified RT60.
  5. Single-pole lowpass for darker rooms (`brightness` parameter).
  6. Peak normalization to about -1 dBFS.

This isn't a measured HRIR — it's the kind of synthetic IR plate/algo
reverbs have shipped for decades. For narrative audio it sits in a mix
indistinguishably from a real recording at this resolution; for forensic
acoustic work, install a real measurement on top.

Stdlib only — runs on any Python 3.9+ without numpy or scipy.

Usage:
    python3 inference/synth_spatial_irs.py --all
    python3 inference/synth_spatial_irs.py --slug cathedral
    python3 inference/synth_spatial_irs.py --slug cave --out /custom/path.wav
"""

from __future__ import annotations

import argparse
import json
import math
import random
import struct
import sys
import wave
from pathlib import Path

SAMPLE_RATE = 48_000


def synth_ir(
    out_path: Path,
    *,
    rt60: float,
    brightness: float,
    density: float,
    early_reflections: bool,
    predelay_ms: float,
    seed: int = 42,
) -> None:
    """Write a stereo 16-bit / 48 kHz WAV IR to *out_path*.

    Parameters mirror the `synthesis` block in `spaces.json`:

    rt60               Reverberation time in seconds (decay to -60 dB).
                       Bigger room → bigger value. Mausoleum ~12 s,
                       voice booth ~0.15 s.
    brightness         0..1; how much treble survives. 0.3 = cave-dark,
                       0.7 = bright concrete stairwell. Controls a single-
                       pole IIR lowpass after the noise generator.
    density            0..1; fraction of tail samples that fire with non-
                       zero amplitude. Higher = denser, smoother tail.
    early_reflections  Whether to add ~5 discrete reflections in the first
                       80 ms. Disable for outdoor/anechoic-ish spaces.
    predelay_ms        Silence before the direct sound — adds a sense of
                       distance from the closest wall. Large rooms tend
                       to have larger predelay.
    seed               Random seed for the noise tail. Fixed so the same
                       preset slug always synthesizes to the same file.
    """
    rng = random.Random(seed)
    sr = SAMPLE_RATE
    duration = max(0.3, rt60 * 1.3)
    n_total = int(duration * sr)
    pre_n = int(predelay_ms / 1000.0 * sr)

    L = [0.0] * n_total
    R = [0.0] * n_total

    # Direct sound — dirac at t=predelay
    if pre_n < n_total:
        L[pre_n] = 1.0
        R[pre_n] = 1.0

    # Early reflections (5 discrete bounces over 7..70 ms after direct).
    if early_reflections:
        er_times_ms = [7, 16, 28, 43, 62]
        er_amps = [0.55, 0.45, 0.38, 0.30, 0.24]
        for t_ms, amp in zip(er_times_ms, er_amps):
            i = pre_n + int(t_ms / 1000.0 * sr)
            if i >= n_total:
                continue
            # Slight L/R decorrelation so the early field isn't dead-centre.
            L[i] += amp * rng.uniform(0.75, 1.0)
            R[i] += amp * rng.uniform(0.75, 1.0)

    # Diffuse tail — exponentially decaying noise starting around the
    # early-reflection cloud. Amplitude per sample: A(t) = exp(-k * t)
    # where k = ln(1000) / RT60 so 20*log10(A) hits -60 dB at t = RT60.
    tail_start = pre_n + int(0.030 * sr)  # 30 ms after direct
    k = math.log(1000.0) / max(0.01, rt60)
    for i in range(tail_start, n_total):
        if rng.random() > density:
            continue
        t = (i - tail_start) / sr
        env = math.exp(-k * t)
        L[i] += rng.uniform(-1.0, 1.0) * env * 0.45
        R[i] += rng.uniform(-1.0, 1.0) * env * 0.45

    # Single-pole lowpass for "darkness". Brightness 1.0 = no filter,
    # 0.0 = very dark (alpha → 0). y[n] = y[n-1] + alpha * (x[n] - y[n-1]).
    alpha = max(0.02, min(1.0, brightness))
    if alpha < 0.99:
        prev_l = 0.0
        prev_r = 0.0
        for i in range(n_total):
            prev_l = prev_l + alpha * (L[i] - prev_l)
            prev_r = prev_r + alpha * (R[i] - prev_r)
            L[i] = prev_l
            R[i] = prev_r

    # Peak normalize to -1 dBFS so different presets sit at comparable
    # levels when convolved.
    peak = max(max(abs(x) for x in L), max(abs(x) for x in R))
    if peak > 0:
        target = 0.89  # ≈ -1 dBFS
        scale = target / peak
        L = [x * scale for x in L]
        R = [x * scale for x in R]

    # Write 16-bit stereo PCM.
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    with wave.open(str(tmp_path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for l_val, r_val in zip(L, R):
            li = max(-32767, min(32767, int(round(l_val * 32767))))
            ri = max(-32767, min(32767, int(round(r_val * 32767))))
            frames.extend(struct.pack("<hh", li, ri))
        w.writeframes(bytes(frames))
    tmp_path.replace(out_path)


def load_manifest(repo_root: Path) -> dict:
    manifest_path = repo_root / "assets" / "spaces" / "spaces.json"
    with open(manifest_path, "r", encoding="utf-8") as f:
        return json.load(f)


def synth_from_entry(entry: dict, out_dir: Path) -> Path | None:
    """Synthesize one preset's IR from its manifest entry.
    Returns the written path, or None if the entry is dry or has no
    synthesis block."""
    if entry.get("file") is None or entry.get("kind") == "dry" or entry.get("type") == "dry":
        return None
    synth = entry.get("synthesis")
    if not synth:
        return None
    out_path = out_dir / entry["file"]
    synth_ir(
        out_path,
        rt60=float(synth.get("rt60", 1.0)),
        brightness=float(synth.get("brightness", 0.5)),
        density=float(synth.get("density", 0.7)),
        early_reflections=bool(synth.get("early_reflections", True)),
        predelay_ms=float(synth.get("predelay_ms", 0)),
        seed=int(synth.get("seed", 42)),
    )
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser(description="Synthesize Pharaoh spatial-space IRs.")
    ap.add_argument("--all", action="store_true",
                    help="Synthesize every preset in spaces.json that has a synthesis block.")
    ap.add_argument("--slug", type=str, default=None,
                    help="Synthesize a single preset by slug.")
    ap.add_argument("--out", type=Path, default=None,
                    help="Output WAV path. Overrides manifest's `file` field.")
    ap.add_argument("--missing-only", action="store_true",
                    help="With --all, skip presets whose file already exists on disk.")
    args = ap.parse_args()

    if not args.all and not args.slug:
        ap.error("pass --all or --slug")

    repo_root = Path(__file__).resolve().parent.parent
    manifest = load_manifest(repo_root)
    spaces_dir = repo_root / "assets" / "spaces"

    written = []
    skipped_existing = []

    entries = manifest["spaces"]
    if args.slug:
        entries = [e for e in entries if e.get("slug") == args.slug]
        if not entries:
            print(f"unknown slug: {args.slug}", file=sys.stderr)
            return 1

    for entry in entries:
        out_dir = args.out.parent if args.out else spaces_dir
        if args.out and args.slug:
            # honour an explicit single-file override
            file_target = args.out
        else:
            if entry.get("file") is None:
                continue  # dry baseline
            file_target = spaces_dir / entry["file"]

        if args.missing_only and file_target.exists():
            skipped_existing.append(entry["slug"])
            continue
        if not entry.get("synthesis"):
            continue

        # Re-implement synth_from_entry inline so we honour --out.
        synth = entry["synthesis"]
        synth_ir(
            file_target,
            rt60=float(synth.get("rt60", 1.0)),
            brightness=float(synth.get("brightness", 0.5)),
            density=float(synth.get("density", 0.7)),
            early_reflections=bool(synth.get("early_reflections", True)),
            predelay_ms=float(synth.get("predelay_ms", 0)),
            seed=int(synth.get("seed", 42)),
        )
        written.append((entry["slug"], file_target))

    for slug, path in written:
        print(f"  ✓ synthesized {slug}  →  {path.name}")
    for slug in skipped_existing:
        print(f"  · {slug}  already present, skipped")
    if not written and not skipped_existing:
        print("no entries to synthesize")
    return 0


if __name__ == "__main__":
    sys.exit(main())
