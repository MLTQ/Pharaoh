#!/usr/bin/env python3
"""Read-only FFmpeg capability probe. Exit 0: present, 1: absent, 2: probe error.
Filter presence is necessary for the SOFA path, not proof a full render works.
"""
import argparse
import json
import os
import shutil
import subprocess


def probe(executable):
    ffmpeg = shutil.which(executable)
    if not ffmpeg:
        return 2, {"status": "no_ffmpeg", "detail": "Configured FFmpeg not found."}
    try:
        result = subprocess.run([ffmpeg, "-hide_banner", "-filters"],
                                capture_output=True, text=True, timeout=30)
        if result.returncode:
            return 2, {"status": "probe_failed", "ffmpeg": ffmpeg,
                       "detail": result.stderr.strip()[-2000:]}
        names = {line.split()[1] for line in result.stdout.splitlines()
                 if len(line.split()) >= 3 and "->" in line.split()[2]}
        version = subprocess.run([ffmpeg, "-version"], capture_output=True,
                                 text=True, timeout=30)
        lines = version.stdout.splitlines()
        present = "sofalizer" in names
        return (0 if present else 1), {
            "status": "ok" if present else "missing_sofalizer",
            "ffmpeg": ffmpeg, "version": lines[0] if lines else "",
            "sofalizer": present,
            "siblings": {n: n in names for n in
                         ("adelay", "apad", "stereotools", "haas", "pan")},
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 2, {"status": "probe_failed", "detail": str(exc)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"),
                        help="Same FFmpeg executable used by Pharaoh")
    args = parser.parse_args()
    code, report = probe(args.ffmpeg)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for key, value in report.items():
            print(f"{key}: {value}")
        if code == 1:
            print("The SOFA/HRTF path needs an FFmpeg build with sofalizer.")
            print("A non-SOFA approximation may be available in your Pharaoh version.")
            print("Do not change the intended treatment without producer approval.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
