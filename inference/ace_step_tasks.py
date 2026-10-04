"""
ACE-Step v1 task calls shared by music_server.py (ACE-Step as the music engine)
and ace_step_worker.py (repaint/cover for the YuE2 music server).

Imports nothing heavy at module level so both the server and the one-shot
worker can import it before the pipeline exists.
"""
import os
from pathlib import Path

MUSIC_MODEL_DIR = Path(os.environ.get("PHARAOH_MUSIC_MODEL_DIR", "~/pharaoh-models/music")).expanduser()
REQUIRED_DIRS = ["ace_step_transformer", "music_dcae_f8c8", "music_vocoder", "umt5-base"]
SAMPLE_RATE = 44100


def model_dir_status() -> dict:
    if not MUSIC_MODEL_DIR.is_dir():
        return {"ok": False, "reason": f"PHARAOH_MUSIC_MODEL_DIR not found: {MUSIC_MODEL_DIR}"}
    missing = [d for d in REQUIRED_DIRS if not (MUSIC_MODEL_DIR / d).is_dir()]
    if missing:
        return {"ok": False, "reason": (
            f"Missing checkpoint subdirs in {MUSIC_MODEL_DIR}: {', '.join(missing)}. "
            f"Download with: hf download ACE-Step/ACE-Step-v1-3.5B --local-dir {MUSIC_MODEL_DIR}"
        )}
    return {"ok": True, "reason": ""}


def load_pipeline():
    """Construct ACEStepPipeline and load its weights eagerly."""
    from acestep.pipeline_ace_step import ACEStepPipeline

    pipe = ACEStepPipeline(checkpoint_dir=str(MUSIC_MODEL_DIR), dtype="bfloat16")
    # Construction is lazy — force the weight load so errors surface here.
    pipe.load_checkpoint(str(MUSIC_MODEL_DIR))
    return pipe


def run_task(pipeline, endpoint: str, params: dict, out_path: str) -> None:
    """Run one ACE-Step task; the pipeline writes the .wav to out_path itself."""
    seed = int(params.get("seed", 0)) or None
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    duration = float(params.get("duration_seconds", 30.0))
    if endpoint in ("repaint", "cover"):
        # Edits keep the source's length, whatever the caller sent.
        import soundfile as sf
        duration = sf.info(params["source_audio_path"]).duration
    common_kwargs = dict(
        format="wav",
        audio_duration=duration,
        infer_step=int(params.get("diffusion_steps", 60)),
        manual_seeds=[seed] if seed else None,
        save_path=out_path,
        batch_size=int(params.get("batch_size", 1)),
    )

    # ACEStepPipeline.__call__ does `len(lyrics) > 0` etc. without None-checks,
    # so empty-string is required for unset text fields, not None.
    if endpoint == "text2music":
        ref = params.get("reference_audio_path", "") or ""
        pipeline(
            task="text2music",
            prompt=params.get("caption", "") or "",
            lyrics=params.get("lyrics", "") or "",
            audio2audio_enable=bool(ref),
            ref_audio_input=ref,
            ref_audio_strength=0.5,
            **common_kwargs,
        )
    elif endpoint == "cover":
        pipeline(
            task="audio2audio",
            prompt=params.get("caption", "") or "",
            lyrics="",
            audio2audio_enable=True,
            ref_audio_input=params["source_audio_path"],
            ref_audio_strength=float(params.get("cover_strength", 0.5)),
            **common_kwargs,
        )
    elif endpoint == "repaint":
        pipeline(
            task="repaint",
            prompt=params.get("caption", "") or "",
            lyrics="",
            src_audio_path=params["source_audio_path"],
            # ACE-Step takes the window in seconds; Pharaoh's API is in ms.
            repaint_start=int(params.get("start_ms", 0)) / 1000,
            repaint_end=int(params.get("end_ms", 10000)) / 1000,
            **common_kwargs,
        )
    else:
        raise ValueError(f"Unsupported music endpoint: {endpoint}")
