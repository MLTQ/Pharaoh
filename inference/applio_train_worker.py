#!/usr/bin/env python3
"""
Thin CLI wrapper around Applio's core.py training pipeline.

Called by rvc_server.py via subprocess using the .venv-applio Python interpreter
so that Applio's heavier dependency tree (torch, faiss, etc.) stays isolated.

Usage:
    python3 applio_train_worker.py <params.json>

params.json fields:
    applio_dir     str   absolute path to the cloned Applio repo
    dataset_path   str   absolute path to the directory of corpus WAVs
    model_name     str   short name, no spaces (used as Applio model key)
    sample_rate    int   40000 or 48000
    epochs         int   training epochs (100 is a good default)
    batch_size     int   4 on CPU/MPS, 8+ on GPU
    f0_method      str   "rmvpe" (default), "harvest", "crepe", "pm"
    gpu            str   "0" for first GPU, "-" for CPU

Stdout (last line): JSON object with:
    pth_path       str | null   path to the exported .pth checkpoint
    index_path     str | null   path to the exported .index FAISS file
"""
import json
import os
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: applio_train_worker.py <params.json>", file=sys.stderr)
        sys.exit(1)

    params_path = Path(sys.argv[1])
    if not params_path.is_file():
        print(f"params file not found: {params_path}", file=sys.stderr)
        sys.exit(1)

    params = json.loads(params_path.read_text())

    applio_dir   = params["applio_dir"]
    dataset_path = params["dataset_path"]
    model_name   = params["model_name"]
    sample_rate  = int(params.get("sample_rate", 48000))
    epochs       = int(params.get("epochs", 100))
    batch_size   = int(params.get("batch_size", 4))
    f0_method    = params.get("f0_method", "rmvpe")
    gpu          = params.get("gpu", "0")

    # Add Applio to the import path and set cwd so its internal relative
    # imports (assets/, logs/, etc.) resolve correctly.
    sys.path.insert(0, applio_dir)
    os.chdir(applio_dir)

    try:
        from core import run_extract_script, run_preprocess_script, run_prerequisites_script, run_train_script  # type: ignore
    except ImportError as exc:
        print(f"Cannot import Applio core: {exc}", file=sys.stderr)
        print(f"  applio_dir={applio_dir}", file=sys.stderr)
        sys.exit(1)

    cpu_cores = min(os.cpu_count() or 2, 8)

    # Applio's extract.py only understands "cuda:N" or "-" (CPU).
    # It has NO MPS support. train.py does handle MPS natively, so we only
    # override the extraction gpu to "-" when CUDA is unavailable.
    import torch
    if torch.cuda.is_available():
        extract_gpu = gpu          # "0", "0-1", etc.
    else:
        extract_gpu = "-"          # force CPU extraction on macOS / MPS
        print("[applio] No CUDA detected — using CPU for feature extraction (MPS handled in training).", flush=True)

    # ── Step 0: Prerequisites (rmvpe.pt, pretrained G/D, contentvec) ─────────
    # Downloads are skipped if the files already exist — idempotent.
    print("PROGRESS:0.03:Checking prerequisites (rmvpe.pt, pretrained G/D)…", flush=True)
    run_prerequisites_script(
        pretraineds_hifigan=True,   # pretrained generator/discriminator for VITS init
        models=True,                # rmvpe.pt + fcpe.pt for pitch extraction
        exe=False,                  # skip Windows executables
    )

    # ── Step 1: Preprocess ────────────────────────────────────────────────────
    print("PROGRESS:0.10:Preprocessing corpus audio…", flush=True)
    run_preprocess_script(
        model_name=model_name,
        dataset_path=dataset_path,
        sample_rate=sample_rate,
        cpu_cores=cpu_cores,
        cut_preprocess="Automatic",
        process_effects=False,
        noise_reduction=False,
        clean_strength=0.7,
        chunk_len=3.0,
        overlap_len=0.3,
    )
    print("PROGRESS:0.22:Preprocessing complete", flush=True)

    # ── Step 2: Feature extraction ────────────────────────────────────────────
    print(f"PROGRESS:0.25:Extracting pitch + embeddings (CPU)…", flush=True)
    run_extract_script(
        model_name=model_name,
        f0_method=f0_method,
        cpu_cores=cpu_cores,
        gpu=extract_gpu,   # "-" on Mac/CPU, "0" on CUDA
        sample_rate=sample_rate,
        embedder_model="contentvec",
    )
    print("PROGRESS:0.45:Features extracted — starting VITS training", flush=True)

    # ── Step 3: Training ──────────────────────────────────────────────────────
    print(f"PROGRESS:0.47:Training {epochs} epochs (batch={batch_size})…", flush=True)
    run_train_script(
        model_name=model_name,
        save_every_epoch=max(10, epochs // 10),
        save_only_latest=True,
        save_every_weights=False,
        total_epoch=epochs,
        sample_rate=sample_rate,
        batch_size=batch_size,
        gpu=0,
        overtraining_detector=False,
        overtraining_threshold=50,
        pretrained=True,
        cleanup=False,
    )
    print("PROGRESS:0.95:Building FAISS index…", flush=True)

    # ── Locate outputs ────────────────────────────────────────────────────────
    logs_dir = Path(applio_dir) / "logs" / model_name

    pth_files = sorted(
        logs_dir.glob("*.pth"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    index_files = sorted(
        logs_dir.glob("added_*.index"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    # Fall back to any .index if the canonical "added_" prefix isn't used
    if not index_files:
        index_files = sorted(
            logs_dir.glob("*.index"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )

    result = {
        "pth_path":   str(pth_files[0])   if pth_files   else None,
        "index_path": str(index_files[0]) if index_files else None,
    }
    # rvc_server.py reads the last line of stdout as JSON
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
