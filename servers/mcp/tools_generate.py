"""
MCP tools: audio generation for script rows (TTS, SFX, music).

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
      1. Cloned voice (automatic): a character with a gold reference clip is
         cloned on the TTS port. The row's 'emotion' picks a palette entry: its
         reference is cloned and its direction performed (Breeze; Qwen3-TTS
         clones the voice only). No extra parameters needed.
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

    # ── Cloned voice (auto: the character has a gold reference) ─────────────────
    char_id = row.get("character", "")
    clone = None   # (character_name, resolved_ref, ref_transcript, direction)
    if char_id:
        # Deciding *whether* this row clones is best-effort: a project that
        # cannot be read just means we fall through to a preset voice, the
        # same as a character with no reference clip.
        try:
            project = _project_json(project_id)
            character = next(
                (c for c in project.get("characters", [])
                 if c["id"] == char_id or c.get("name", "").upper() == char_id.upper()),
                None,
            )
            va = (character or {}).get("voice_assignment", {})
            if character and va.get("ref_audio_path"):
                emotion_key = row.get("emotion", "").strip().lower()
                entry = next(
                    (e for e in va.get("emotional_palette", [])
                     if e.get("ref_audio_path") and emotion_key
                     and emotion_key in (e.get("emotion", "").lower(), e.get("label", "").lower())),
                    None,
                )
                ref = entry["ref_audio_path"] if entry else va["ref_audio_path"]
                transcript = (entry.get("ref_transcript") if entry else va.get("ref_transcript")) or ""
                note = (instruct or row.get("instruct", "")).strip()
                direction = " ".join(x for x in (note, (entry or {}).get("direction", "")) if x).strip()
                # Resolve relative paths (Pharaoh-1qp) against the character's
                # bundle dir before uploading.
                clone = (
                    character.get("name", char_id),
                    _resolve_voice_path(project_id, character["id"], ref),
                    transcript,
                    direction,
                )
        except Exception as exc:
            log.warning(f"Could not check the cloned voice for {char_id}: {exc}")

    # Once we know the row *is* a cloned voice, a failure is fatal. Falling
    # through to a preset here would return a job_id and the wrong voice with
    # no signal that the character's cloned voice was not used.
    if clone is not None:
        char_name, resolved_ref, ref_transcript, direction = clone
        try:
            return json.dumps(_post("tts", "/generate/voice_clone", {
                "text": row["prompt"],
                "ref_audio_path": resolved_ref,
                "ref_transcript": ref_transcript,
                "instruct": direction,
                "seed": seed,
                "output_path": output_path,
            }, upload_fields=("ref_audio_path",)))
        except Exception as exc:
            log.warning(f"Clone failed for {char_name}: {exc}")
            return json.dumps({
                "error": (
                    f"character '{char_name}' has a cloned voice but the request "
                    f"failed: {exc}. Check the TTS server (port 18001) with "
                    f"server_health, or pass speaker=... to use a preset voice "
                    f"on purpose."
                )
            })

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
    Uses the SFX server's default engine: MOSS-SoundEffect v2 where installed
    (effects and beds up to 30 s; it runs 100 steps whatever `steps` says),
    else Woosh-DFlow (4 steps, 10 s max). Returns job_id immediately.
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
        "model_variant": "auto",
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
    instrumental: bool = True,
    bpm: int = 0,
) -> str:
    """
    Submit a music generation job for a MUSIC script row.
    The music port runs YuE2 on NVIDIA hosts (ACE-Step elsewhere). With YuE2,
    instrumental=True (default) means no singing; bpm > 0 sets the tempo exactly.
    diffusion_steps and lm_model_size only apply to ACE-Step.
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
            "instrumental": instrumental,
            **({"bpm": bpm} if bpm > 0 else {}),
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
                "instrumental": instrumental,
                **({"bpm": bpm} if bpm > 0 else {}),
            })
            jobs.append({"take": i + 1, "seed": seed + i, "output_path": take_path, **result})
        return json.dumps({"batch": True, "jobs": jobs})


