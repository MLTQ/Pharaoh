"""
MCP tools: asset QA and take management.

Everything here works off the .meta.json sidecars written next to generated
WAVs: listing scene assets, approving/rejecting them, enumerating takes, and
re-submitting a generation with the exact original parameters. Importing this
module registers the tools against the shared FastMCP instance from server.py.
"""
import json
from pathlib import Path

from projectfs import _list_assets, _meta_path, _read_meta, _write_meta
from remote import _post
from server import mcp


def _no_sidecar_error(audio_path: str) -> str:
    """Shared error text for a missing .meta.json sidecar."""
    return (
        f"no .meta.json sidecar found for {audio_path} "
        f"(expected {_meta_path(audio_path)}) — only assets produced by the "
        f"generate_*/import_audio tools carry sidecars"
    )


@mcp.tool()
def list_assets(project_id: str, scene_slug: str, qa_status: str = "") -> str:
    """
    List all generated audio assets for a scene.
    qa_status filter: "unreviewed" | "approved" | "rejected" | "" (all)
    Returns path, model, prompt, QA status, duration, and take index for each asset.
    """
    assets = _list_assets(project_id, scene_slug)
    if qa_status:
        assets = [a for a in assets if a["qa_status"] == qa_status]
    return json.dumps(assets, indent=2)


@mcp.tool()
def qa_approve(audio_path: str, notes: str = "") -> str:
    """
    Approve a generated asset, marking it ready for composition.
    Writes qa_status='approved' to the asset's .meta.json sidecar.
    """
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": _no_sidecar_error(audio_path)})
    meta["qa_status"] = "approved"
    meta["qa_notes"] = notes
    _write_meta(audio_path, meta)
    return json.dumps({"ok": True, "audio_path": audio_path, "qa_status": "approved"})


@mcp.tool()
def qa_reject(audio_path: str, notes: str) -> str:
    """
    Reject a generated asset with notes explaining what was wrong.
    Writes qa_status='rejected' to the asset's .meta.json sidecar.
    notes should describe the problem clearly (e.g. "too bright, character sounds wrong").
    """
    if not notes:
        return json.dumps({"error": "notes are required when rejecting an asset"})
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": _no_sidecar_error(audio_path)})
    meta["qa_status"] = "rejected"
    meta["qa_notes"] = notes
    _write_meta(audio_path, meta)
    return json.dumps({"ok": True, "audio_path": audio_path, "qa_status": "rejected", "notes": notes})


@mcp.tool()
def regenerate_asset(audio_path: str, output_path: str = "") -> str:
    """
    Re-submit a generation job using the exact parameters from an asset's sidecar.
    Reads the .meta.json sidecar to reconstruct the original request.
    output_path defaults to a new take path derived from the original filename.
    """
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": _no_sidecar_error(audio_path)})

    p = Path(audio_path)
    take_idx = meta.get("take_index", 1) + 1
    if not output_path:
        output_path = str(p.parent / f"{p.stem}_take{take_idx}{p.suffix}")

    model = meta.get("model", "")
    lowered = model.lower()

    # Route by model family, and refuse anything this tool cannot regenerate.
    # The old chain fell through to the SFX branch for everything unmatched, so
    # chatterbox, rvc, audiosr and clip-studio assets were re-submitted to Woosh
    # — and a "tts-reference-import" asset (from import_audio) matched the "tts"
    # substring and got re-synthesised as speech over the writer's own audio.
    _UNSUPPORTED = {
        "tts-reference-import": (
            "this asset was imported, not generated — there are no generation "
            "parameters to re-run. Use import_audio again with a new source file."
        ),
        "clip-studio": (
            "this asset was produced by Clip Studio edits. Re-run process_clip "
            "on the source asset instead."
        ),
        "audiosr": (
            "this asset is an upscale of another take. Re-run upscale_audio on "
            "the source asset instead."
        ),
        "rvc": (
            "this asset is an RVC conversion. Re-run rvc_convert on the source "
            "Chatterbox take instead."
        ),
        "chatterbox": (
            "regenerating a Chatterbox take needs its palette reference. Use "
            "generate_chatterbox with the character and emotion instead."
        ),
    }
    for marker, reason in _UNSUPPORTED.items():
        if marker in lowered:
            return json.dumps({
                "error": f"cannot regenerate asset with model '{model}': {reason}"
            })

    if "qwen" in lowered or "tts" in lowered:
        return json.dumps(_post("tts", "/generate/custom_voice", {
            "text": meta.get("prompt", ""),
            "speaker": meta.get("speaker") or "Vivian",
            "instruct": meta.get("instruct") or None,
            "seed": meta.get("seed", 0),
            "temperature": meta.get("temperature", 0.7),
            "top_p": meta.get("top_p", 0.9),
            "max_new_tokens": meta.get("max_new_tokens", 2048),
            "output_path": output_path,
        }))
    elif "ace" in lowered or "music" in lowered:
        return json.dumps(_post("music", "/generate/text2music", {
            "caption": meta.get("prompt", ""),
            "lyrics": "",
            "duration_seconds": (meta.get("duration_actual_ms") or 30000) / 1000,
            "seed": meta.get("seed", 0),
            "diffusion_steps": 60,
            "lm_model_size": "1.7B",
            "batch_size": 1,
            "output_path": output_path,
        }))
    elif "woosh" in lowered or "sfx" in lowered or "audioldm" in lowered:
        return json.dumps(_post("sfx", "/generate/t2a", {
            "prompt": meta.get("prompt", ""),
            "duration_seconds": (meta.get("duration_actual_ms") or 3000) / 1000,
            "model_variant": "Woosh-DFlow",
            "steps": 4,
            "seed": meta.get("seed", 0),
            "output_path": output_path,
        }))
    else:
        return json.dumps({
            "error": (
                f"unrecognised model '{model}' — regenerate_asset does not know "
                f"which server produced this asset. Known families: qwen/tts, "
                f"ace/music, woosh/sfx/audioldm."
            )
        })


# ── Asset metadata & take management ─────────────────────────────────────────

@mcp.tool()
def read_asset_meta(audio_path: str) -> str:
    """
    Read the .meta.json sidecar for a generated audio file.
    Returns model, prompt, seed, qa_status, duration_actual_ms, take_index,
    parent, generated_at, and other generation parameters.
    Returns {"error": "..."} if no sidecar exists.
    """
    meta = _read_meta(audio_path)
    if meta is None:
        return json.dumps({"error": _no_sidecar_error(audio_path)})
    return json.dumps(meta, indent=2)


@mcp.tool()
def list_asset_takes(audio_path: str) -> str:
    """
    Enumerate all take files for a given base audio path.
    Scans the parent directory for files matching the stem (e.g. all takes of
    "mira_line_01.wav" that share the same stem prefix).
    Returns takes sorted by take_index with paths, qa_status, and metadata.
    """
    p = Path(audio_path)
    stem = p.stem
    takes = []
    for meta_file in sorted(p.parent.glob(f"{stem}*.wav.meta.json")):
        wav = meta_file.parent / meta_file.name.removesuffix(".meta.json")
        if not wav.exists():
            continue
        try:
            meta = json.loads(meta_file.read_text())
        except Exception:
            continue
        takes.append({
            "audio_path": str(wav),
            "take_index": meta.get("take_index", 0),
            "model": meta.get("model", ""),
            "qa_status": meta.get("qa_status", "unreviewed"),
            "duration_ms": meta.get("duration_actual_ms"),
            "generated_at": meta.get("generated_at", ""),
            "seed": meta.get("seed"),
        })
    takes.sort(key=lambda t: t["take_index"])
    return json.dumps(takes, indent=2)
