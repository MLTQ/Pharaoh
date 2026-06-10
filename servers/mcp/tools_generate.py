"""
MCP tools: audio generation for script rows (TTS, Chatterbox, SFX, music).

Each tool validates the target script row, then proxies the request to the
matching inference server via remote._post (which handles remote upload/
download path remapping). Importing this module registers the tools against
the shared FastMCP instance from server.py.
"""
import json
from pathlib import Path

from config import log
from projectfs import _project_json, _resolve_voice_path, _script_rows
from remote import _auto_unload_others, _post
from server import mcp


def _row_range_error(project_id: str, scene_slug: str, rows: list, row_index: int) -> str | None:
    """Shared row-index validation message for the generate_* tools.

    Returns an error string when the row index is invalid, else None.
    """
    if not rows:
        return (
            f"scene '{scene_slug}' in project {project_id} has no script rows "
            f"(script.csv missing or empty) — populate it with write_script first"
        )
    if row_index < 0 or row_index >= len(rows):
        return (
            f"row_index {row_index} out of range (0–{len(rows)-1}) "
            f"for scene '{scene_slug}' in project {project_id}"
        )
    return None


@mcp.tool()
def generate_tts(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    speaker: str = "Vivian",
    instruct: str = "",
    voice_description: str = "",
    seed: int = 0,
    temperature: float = 0.7,
    top_p: float = 0.9,
    max_new_tokens: int = 2048,
) -> str:
    """
    Submit a TTS/dialogue generation job for a DIALOGUE script row.
    Returns a job_id immediately. Poll job_status to wait for completion.
    The prompt is read from the row's 'prompt' field; instruct overrides the row's 'instruct' field if provided.
    output_path should be the absolute path where the .wav should be saved.

    Voice modes (in priority order):
      1. Chatterbox (automatic): if the character's voice_assignment.model == "Chatterbox" and the
         row has a non-empty 'emotion' field, automatically resolves the palette reference and routes
         to the Chatterbox server. No extra parameters needed.
      2. voice_description: pass a rich natural-language description of the desired voice.
         Routes to Qwen3-TTS /generate/voice_design.
      3. speaker + instruct: preset speaker with optional style instruction.
         Supported speakers: aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian.
    """
    rows = _script_rows(project_id, scene_slug)
    err = _row_range_error(project_id, scene_slug, rows, row_index)
    if err:
        return json.dumps({"error": err})
    row = rows[row_index]
    if row.get("type", "").upper() != "DIALOGUE":
        return json.dumps({"error": (
            f"generate_tts only applies to DIALOGUE rows — row {row_index} of "
            f"scene '{scene_slug}' is type '{row.get('type', '')}'"
        )})

    # ── Single model mode: unload other heavy servers before generation ──────────
    _auto_unload_others("tts")

    # ── Chatterbox routing (auto, based on character voice_assignment) ──────────
    char_id = row.get("character", "")
    if char_id:
        try:
            project = _project_json(project_id)
            character = next(
                (c for c in project.get("characters", [])
                 if c["id"] == char_id or c.get("name", "").upper() == char_id.upper()),
                None,
            )
            if character:
                va = character.get("voice_assignment", {})
                if va.get("model") == "Chatterbox":
                    emotion_key = row.get("emotion", "").strip() or "neutral"
                    palette = va.get("emotional_palette", [])
                    entry = next(
                        (e for e in palette if e["emotion"] == emotion_key),
                        palette[0] if palette else None,
                    )
                    if entry and entry.get("ref_audio_path"):
                        # Resolve relative paths (Pharaoh-1qp) against the
                        # character's bundle dir before uploading.
                        resolved_ref = _resolve_voice_path(
                            project_id, character["id"], entry["ref_audio_path"]
                        )
                        result = _post("chatterbox", "/generate/clone", {
                            "text": row["prompt"],
                            "ref_audio_path": resolved_ref,
                            "ref_transcript": entry.get("ref_transcript") or "",
                            "seed": seed,
                            "output_path": output_path,
                        }, upload_fields=("ref_audio_path",))
                        return json.dumps(result)
        except Exception as exc:
            log.warning(f"Chatterbox auto-routing failed, falling back to Qwen3: {exc}")

    if voice_description:
        # Voice Design mode: synthesise voice from natural-language description
        result = _post("tts", "/generate/voice_design", {
            "text": row["prompt"],
            "voice_description": voice_description,
            "seed": seed,
            "temperature": temperature,
            "top_p": top_p,
            "max_new_tokens": max_new_tokens,
            "output_path": output_path,
        })
    else:
        # Base model mode: preset speaker + optional style instruction
        effective_instruct = instruct or row.get("instruct", "")
        result = _post("tts", "/generate/custom_voice", {
            "text": row["prompt"],
            "speaker": speaker,
            "instruct": effective_instruct or None,
            "seed": seed,
            "temperature": temperature,
            "top_p": top_p,
            "max_new_tokens": max_new_tokens,
            "output_path": output_path,
        })
    return json.dumps(result)


@mcp.tool()
def generate_sfx(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    duration_seconds: float = 3.0,
    steps: int = 4,
    seed: int = 0,
) -> str:
    """
    Submit an SFX generation job for an SFX or BED script row.
    Uses Woosh-DFlow (fast, 4-step). Returns job_id immediately.
    The prompt is read from the row's 'prompt' field.
    output_path should be the absolute path where the .wav should be saved.
    """
    rows = _script_rows(project_id, scene_slug)
    err = _row_range_error(project_id, scene_slug, rows, row_index)
    if err:
        return json.dumps({"error": err})
    row = rows[row_index]
    row_type = row.get("type", "").upper()
    if row_type not in ("SFX", "BED"):
        return json.dumps({"error": (
            f"generate_sfx only applies to SFX or BED rows — row {row_index} of "
            f"scene '{scene_slug}' is type '{row.get('type', '')}'"
        )})
    result = _post("sfx", "/generate/t2a", {
        "prompt": row["prompt"],
        "duration_seconds": duration_seconds,
        "model_variant": "Woosh-DFlow",
        "steps": steps,
        "seed": seed,
        "output_path": output_path,
    })
    return json.dumps(result)


@mcp.tool()
def generate_music(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    duration_seconds: float = 30.0,
    seed: int = 0,
    batch_size: int = 1,
    diffusion_steps: int = 60,
    lm_model_size: str = "1.7B",
) -> str:
    """
    Submit a music generation job for a MUSIC script row.
    batch_size > 1 generates multiple takes with different seeds for comparison (gacha workflow).
    Returns job_id (or list of job_ids if batch_size > 1). Poll job_status for each.
    The caption/prompt is read from the row's 'prompt' field.
    """
    rows = _script_rows(project_id, scene_slug)
    err = _row_range_error(project_id, scene_slug, rows, row_index)
    if err:
        return json.dumps({"error": err})
    row = rows[row_index]
    if row.get("type", "").upper() != "MUSIC":
        return json.dumps({"error": (
            f"generate_music only applies to MUSIC rows — row {row_index} of "
            f"scene '{scene_slug}' is type '{row.get('type', '')}'"
        )})

    _auto_unload_others("music")

    if batch_size <= 1:
        result = _post("music", "/generate/text2music", {
            "caption": row["prompt"],
            "lyrics": "",
            "duration_seconds": duration_seconds,
            "seed": seed,
            "diffusion_steps": diffusion_steps,
            "lm_model_size": lm_model_size,
            "batch_size": 1,
            "output_path": output_path,
        })
        return json.dumps(result)
    else:
        # Fan out N seeds, derive output paths from base output_path
        base = Path(output_path)
        stem = base.stem
        jobs = []
        for i in range(batch_size):
            take_path = str(base.parent / f"{stem}_take{i+1}{base.suffix}")
            result = _post("music", "/generate/text2music", {
                "caption": row["prompt"],
                "lyrics": "",
                "duration_seconds": duration_seconds,
                "seed": seed + i,
                "diffusion_steps": diffusion_steps,
                "lm_model_size": lm_model_size,
                "batch_size": 1,
                "output_path": take_path,
            })
            jobs.append({"take": i + 1, "seed": seed + i, "output_path": take_path, **result})
        return json.dumps({"batch": True, "jobs": jobs})


@mcp.tool()
def generate_chatterbox(
    project_id: str,
    scene_slug: str,
    row_index: int,
    output_path: str,
    ref_audio_path: str = "",
    emotion: str = "",
    exaggeration: float = 0.5,
    cfg_weight: float = 0.5,
    seed: int = 0,
) -> str:
    """
    Submit a Chatterbox Turbo 0-shot voice clone job for a DIALOGUE script row.

    Chatterbox Turbo clones the vocal identity from ref_audio_path and renders
    the row's prompt text. Inline paralinguistic tags in the prompt text are
    honoured (e.g. '[sigh] I knew it.' or 'That's funny. [chuckle]').

    ref_audio_path: if empty, auto-resolves from the character's emotional palette
                    using the row's 'emotion' field (falls back to first palette entry).
    emotion:        override the emotion key (ignores row's 'emotion' field).
    exaggeration:   0–1, how strongly to colour the vocal performance.
    cfg_weight:     classifier-free guidance strength.
    """
    rows = _script_rows(project_id, scene_slug)
    err = _row_range_error(project_id, scene_slug, rows, row_index)
    if err:
        return json.dumps({"error": err})
    row = rows[row_index]
    if row.get("type", "").upper() != "DIALOGUE":
        return json.dumps({"error": (
            f"generate_chatterbox only applies to DIALOGUE rows — row {row_index} of "
            f"scene '{scene_slug}' is type '{row.get('type', '')}'"
        )})

    _auto_unload_others("chatterbox")

    resolved_ref = ref_audio_path
    if not resolved_ref:
        char_id = row.get("character", "")
        emotion_key = emotion or row.get("emotion", "").strip() or "neutral"
        try:
            project = _project_json(project_id)
            character = next(
                (c for c in project.get("characters", [])
                 if c["id"] == char_id or c.get("name", "").upper() == char_id.upper()),
                None,
            )
            if character:
                palette = character.get("voice_assignment", {}).get("emotional_palette", [])
                entry = next(
                    (e for e in palette if e["emotion"] == emotion_key),
                    palette[0] if palette else None,
                )
                if entry and entry.get("ref_audio_path"):
                    # Resolve relative paths (Pharaoh-1qp) against the bundle dir.
                    resolved_ref = _resolve_voice_path(
                        project_id, character["id"], entry["ref_audio_path"]
                    )
        except Exception as exc:
            return json.dumps({"error": (
                f"palette resolution failed for character '{char_id}' "
                f"(emotion '{emotion_key}') in project {project_id}: {exc}"
            )})

    if not resolved_ref:
        return json.dumps({"error": (
            "ref_audio_path not supplied and no approved palette entry found. "
            "Generate and approve a palette take first."
        )})

    result = _post("chatterbox", "/generate/clone", {
        "text": row["prompt"],
        "ref_audio_path": resolved_ref,
        "exaggeration": exaggeration,
        "cfg_weight": cfg_weight,
        "seed": seed,
        "output_path": output_path,
    }, upload_fields=("ref_audio_path",))
    return json.dumps(result)
