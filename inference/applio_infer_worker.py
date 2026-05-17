#!/usr/bin/env python3
"""
Thin CLI wrapper around Applio's inference pipeline.

Called by rvc_server.py via subprocess using the .venv-applio Python
interpreter — ensures the same architecture (768-dim contentvec, v2) used
during training is used at inference time.

Usage:
    python3 applio_infer_worker.py <params.json>

params.json fields:
    applio_dir    str   absolute path to the cloned Applio repo
    input_path    str   absolute path to source WAV
    output_path   str   absolute path for converted WAV output
    pth_path      str   absolute path to .pth model file
    index_path    str   absolute path to .index FAISS file (or "")
    pitch_shift   int   semitone shift (default 0)
    index_rate    float 0–1 strength of index retrieval (default 0.5)
    f0_method     str   "rmvpe" | "pm" | "crepe" | "fcpe" (default "rmvpe")
    filter_radius int   median filter on F0, 0–7 (default 3)
    rms_mix_rate  float 0–1 envelope blend (default 0.25)
    protect       float 0–0.5 consonant protection (default 0.33)

Exit code 0 on success, 1 on failure.
"""
import json
import os
import sys
from pathlib import Path

# Fix: PyTorch and faiss-cpu each bundle their own libomp, causing a duplicate
# OpenMP runtime conflict on macOS that produces a SIGSEGV during FAISS search.
# KMP_DUPLICATE_LIB_OK=TRUE + single-threaded OMP is the standard workaround.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: applio_infer_worker.py <params.json>", file=sys.stderr)
        sys.exit(1)

    params_path = Path(sys.argv[1])
    if not params_path.is_file():
        print(f"params file not found: {params_path}", file=sys.stderr)
        sys.exit(1)

    params = json.loads(params_path.read_text())

    applio_dir   = params["applio_dir"]
    input_path   = params["input_path"]
    output_path  = params["output_path"]
    pth_path     = params["pth_path"]
    index_path   = params.get("index_path", "")
    pitch_shift  = int(params.get("pitch_shift", 0))
    index_rate   = float(params.get("index_rate", 0.5))
    f0_method    = params.get("f0_method", "rmvpe")
    filter_radius = int(params.get("filter_radius", 3))
    rms_mix_rate = float(params.get("rms_mix_rate", 0.25))
    protect      = float(params.get("protect", 0.33))

    sys.path.insert(0, applio_dir)
    os.chdir(applio_dir)

    # Ensure single-threaded FAISS at runtime (belt-and-suspenders alongside env vars)
    try:
        import faiss  # type: ignore
        faiss.omp_set_num_threads(1)
    except Exception:
        pass

    try:
        from core import run_infer_script  # type: ignore
    except ImportError as exc:
        print(f"Cannot import Applio core: {exc}", file=sys.stderr)
        sys.exit(1)

    # Ensure output directory exists
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    result = run_infer_script(
        pitch=pitch_shift,
        index_rate=index_rate,
        volume_envelope=rms_mix_rate,   # renamed from rms_mix_rate in Applio HEAD
        protect=protect,
        f0_method=f0_method,
        input_path=input_path,
        output_path=output_path,
        pth_path=pth_path,
        index_path=index_path,
        split_audio=False,
        f0_autotune=False,
        f0_autotune_strength=1.0,
        proposed_pitch=False,
        proposed_pitch_threshold=155.0,
        clean_audio=False,
        clean_strength=0.7,
        export_format="WAV",
        embedder_model="contentvec",
        formant_shifting=False,
    )

    print(f"[applio] Inference result: {result}", flush=True)

    if not Path(output_path).is_file():
        print(f"Output not found at {output_path}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
