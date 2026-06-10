"""
MCP tools: character voice pipeline — emotional palette and RVC training.

Covers the four-stage voice identity workflow: design palette takes (Qwen3
VoiceDesign), approve references, build a Chatterbox training corpus, train
an RVC model, and convert audio with it. Importing this module registers the
tools against the shared FastMCP instance from server.py.
"""
import json
from pathlib import Path

from projectfs import (
    _known_characters,
    _project_dir,
    _project_json,
    _read_meta,
    _relativize_voice_path,
    _resolve_voice_path,
)
from remote import _auto_unload_others, _post
from server import mcp


@mcp.tool()
def generate_palette_take(
    project_id: str,
    character_id: str,
    emotion: str,
    direction: str,
    test_line: str,
    seed: int = 0,
    label: str = "",
) -> str:
    """
    Generate a Qwen3 VoiceDesign reference take for a character's palette emotion slot.

    Combines the character's base_voice_description (vocal identity) with the emotion's
    direction (short performance instruction) to produce a coherent instruct string, then
    calls Qwen3-TTS /generate/voice_design. Saves to characters/{character_id}/palette/
    and upserts the palette entry in project.json (qa_status='unreviewed').

    After reviewing the take, call approve_palette_take to lock it as the reference.
    Multiple takes can be generated with different seeds before approving.

    emotion:   slug key (e.g. "neutral", "sardonic", "tense")
    direction: short emotional direction to layer on the character's base voice, e.g.
               "Flat, controlled fear. Each word measured." — NOT a full voice description.
               The character's base_voice_description is prepended automatically.
    test_line: the text to synthesise for audition
    label:     human-readable display name (defaults to capitalised emotion key)
    """
    proj_dir = _project_dir(project_id)
    proj_path = proj_dir / "project.json"
    project = _project_json(project_id)

    character = next((c for c in project.get("characters", []) if c["id"] == character_id), None)
    if character is None:
        return json.dumps({"error": (
            f"character {character_id!r} not found in project {project_id}. "
            f"Known characters: {_known_characters(project)}"
        )})

    va = character.setdefault("voice_assignment", {})
    base_desc = va.get("base_voice_description", "").strip()

    # Combine base identity + emotional direction into a single VoiceDesign instruct
    if base_desc and direction.strip():
        full_instruct = f"{base_desc} {direction.strip()}"
    elif base_desc:
        full_instruct = base_desc
    else:
        full_instruct = direction.strip()

    if not full_instruct:
        return json.dumps({"error": "No voice description available. Set the character's base voice description in the Voice Design tab first."})

    palette_dir = proj_dir / "characters" / character_id / "palette"
    palette_dir.mkdir(parents=True, exist_ok=True)

    out_path = str(palette_dir / f"{emotion}_{seed}.wav")
    _auto_unload_others("tts")
    result = _post("tts", "/generate/voice_design", {
        "text": test_line,
        "voice_description": full_instruct,
        "seed": seed,
        "output_path": out_path,
    })

    # Upsert palette entry in project.json
    palette = va.setdefault("emotional_palette", [])
    entry = next((e for e in palette if e["emotion"] == emotion), None)
    if entry is None:
        entry = {
            "emotion": emotion,
            "label": label or emotion.capitalize(),
            "direction": direction,
            "ref_audio_path": None,
            "ref_transcript": None,
            "qa_status": "unreviewed",
        }
        palette.append(entry)
    else:
        entry["direction"] = direction
        if label:
            entry["label"] = label

    proj_path.write_text(json.dumps(project, indent=2, default=str))
    return json.dumps({"ok": True, "output_path": out_path, "full_instruct": full_instruct, **result})


@mcp.tool()
def approve_palette_take(
    project_id: str,
    character_id: str,
    emotion: str,
    audio_path: str,
) -> str:
    """
    Lock a palette take as the approved reference for this emotion slot.

    Updates project.json: sets emotional_palette[emotion].ref_audio_path = audio_path
    and qa_status = 'approved'. Also sets voice_assignment.model = 'Chatterbox' if not
    already set.

    After approval, generate_tts / generate_chatterbox will automatically use this
    reference when generating lines with this emotion.
    """
    if not Path(audio_path).is_file():
        return json.dumps({"error": (
            f"audio_path not found: {audio_path} — pass the absolute path returned "
            f"by generate_palette_take or list_palette_takes"
        )})

    proj_path = _project_dir(project_id) / "project.json"
    project = _project_json(project_id)
    for char in project.get("characters", []):
        if char["id"] == character_id:
            va = char.setdefault("voice_assignment", {})
            palette = va.setdefault("emotional_palette", [])
            entry = next((e for e in palette if e["emotion"] == emotion), None)
            if entry is None:
                return json.dumps({"error": (
                    f"emotion {emotion!r} not found in palette for character {character_id}. "
                    f"Existing emotions: {[e.get('emotion') for e in palette] or 'none'}. "
                    f"Run generate_palette_take first."
                )})
            # Pharaoh-1qp: store paths inside the character bundle as relative
            # so project.json stays portable across machines / library imports.
            entry["ref_audio_path"] = _relativize_voice_path(project_id, character_id, audio_path)
            entry["qa_status"] = "approved"
            # Promote model to Chatterbox
            va["model"] = "Chatterbox"
            break
    else:
        return json.dumps({"error": (
            f"character {character_id!r} not found in project {project_id}. "
            f"Known characters: {_known_characters(project)}"
        )})

    proj_path.write_text(json.dumps(project, indent=2, default=str))
    return json.dumps({"ok": True, "character_id": character_id, "emotion": emotion, "ref": audio_path})


@mcp.tool()
def list_character_palette(project_id: str, character_id: str) -> str:
    """
    Return all palette entries for a character with their qa_status and ref_audio_path.
    Use this to check which emotion slots are ready (approved) vs. still need takes.
    """
    project = _project_json(project_id)
    character = next(
        (c for c in project.get("characters", []) if c["id"] == character_id),
        None,
    )
    if character is None:
        return json.dumps({"error": (
            f"character {character_id!r} not found in project {project_id}. "
            f"Known characters: {_known_characters(project)}"
        )})
    va = character.get("voice_assignment", {})
    return json.dumps({
        "character_id": character_id,
        "name": character.get("name"),
        "model": va.get("model"),
        "emotional_palette": va.get("emotional_palette", []),
    }, indent=2)


@mcp.tool()
def list_palette_takes(project_id: str, character_id: str, emotion: str) -> str:
    """
    List all palette take WAV files for a character/emotion combination.
    Palette takes live in characters/{character_id}/palette/ named like
    "{emotion}_{timestamp}.wav". Sorted oldest to newest.
    """
    palette_dir = _project_dir(project_id) / "characters" / character_id / "palette"
    if not palette_dir.exists():
        return json.dumps([])
    files = []
    for f in sorted(palette_dir.glob(f"{emotion}_*.wav")):
        meta = _read_meta(str(f))
        files.append({
            "path": str(f),
            "qa_status": meta.get("qa_status", "unreviewed") if meta else "unreviewed",
            "seed": meta.get("seed") if meta else None,
            "generated_at": meta.get("generated_at", "") if meta else "",
        })
    return json.dumps(files, indent=2)


@mcp.tool()
def list_rvc_models(project_id: str, character_id: str) -> str:
    """
    List trained RVC models available for a character.
    Scans characters/{character_id}/rvc/ for .pth files and checks for a
    matching .index (FAISS) file. Returns name, pth_path, index_path, size_bytes.
    """
    rvc_dir = _project_dir(project_id) / "characters" / character_id / "rvc"
    if not rvc_dir.exists():
        return json.dumps([])
    models = []
    for pth in sorted(rvc_dir.glob("*.pth")):
        index = pth.with_suffix(".index")
        models.append({
            "name": pth.stem,
            "pth_path": str(pth),
            "index_path": str(index) if index.exists() else None,
            "size_bytes": pth.stat().st_size,
        })
    return json.dumps(models, indent=2)


# ── RVC voice pipeline tools ─────────────────────────────────────────────────

@mcp.tool()
def corpus_status(project_id: str, character_id: str) -> str:
    """
    Return corpus build status for a character's RVC training data.

    Shows the count of WAV files in characters/{character_id}/rvc_corpus/,
    their total duration, and whether the corpus meets the 5-minute minimum
    recommended for good RVC training results.

    Run this before build_corpus to see current state, and after to verify
    the corpus is ready for train_rvc_model.
    """
    proj = _project_json(project_id)
    char_dir = _project_dir(project_id) / "characters" / character_id
    corpus_dir = char_dir / "rvc_corpus"

    files = list(corpus_dir.glob("*.wav")) if corpus_dir.exists() else []
    total_ms = 0
    for wav in files:
        meta_path = wav.parent / (wav.name + ".meta.json")
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                total_ms += meta.get("duration_actual_ms") or meta.get("duration_ms") or 0
            except Exception:
                pass

    ready = total_ms >= 5 * 60 * 1000  # 5 minutes
    return json.dumps({
        "character_id": character_id,
        "corpus_dir": str(corpus_dir),
        "file_count": len(files),
        "total_duration_ms": total_ms,
        "total_duration_min": round(total_ms / 60000, 1),
        "ready_for_training": ready,
        "recommendation": (
            "Ready for training." if ready
            else f"Need {round((5*60000 - total_ms)/60000, 1)} more minutes of audio. Run build_corpus."
        ),
    }, indent=2)


@mcp.tool()
def build_corpus(
    project_id: str,
    character_id: str,
    target_count: int = 50,
) -> str:
    """
    Generate a Chatterbox corpus for RVC training (Stage 3 of voice pipeline).

    Generates `target_count` takes of the character's palette test line across
    all approved emotional states. Each take uses a different paralinguistic
    tag combination ([sigh], [chuckle], [laugh], [gasp], [clears throat], [hmm])
    so the resulting corpus covers the character's expressive range.

    Output: characters/{character_id}/rvc_corpus/{emotion}_{i}.wav
    Uses the character's approved palette reference WAVs as Chatterbox clone sources.

    PREREQUISITES: Stage 2 must be complete — at least 2 approved palette entries.
    This is a long-running operation. Returns a list of job_ids.
    Poll job_status(job_id) on each to track progress (~8 min total on GPU).

    Args:
        target_count: Total WAVs to generate across all emotions (default 50).
    """
    proj = _project_json(project_id)
    char = next(
        (c for c in proj.get("characters", []) if c["id"] == character_id),
        None,
    )
    if char is None:
        return json.dumps({"error": (
            f"character {character_id} not found in project {project_id}. "
            f"Known characters: {_known_characters(proj)}"
        )})

    palette = char.get("voice_assignment", {}).get("emotional_palette", [])
    approved = [e for e in palette if e.get("qa_status") == "approved" and e.get("ref_audio_path")]
    if not approved:
        return json.dumps({"error": "No approved palette entries found. Complete Stage 2 first."})

    # Paralinguistic tag variants: the same line is generated clean and with each
    # tag in prefix + suffix position to maximise prosodic variety in the corpus.
    tag_variants = [
        "",                   # clean (no tag) — baseline voice
        "[sigh] ",            # prefix sigh
        "[chuckle] ",
        "[laugh] ",
        "[gasp] ",
        "[clears throat] ",
        "[hmm] ",
        " [sigh]",            # suffix sigh (different prosodic shape)
        " [chuckle]",
        " [laugh]",
    ]

    # Use a fixed corpus test line — NOT instruct_default (which is a voice description,
    # not a line of speech). Rotate through varied lines so the corpus has prosodic diversity.
    _CORPUS_TEST_LINES = [
        "And then she said — nothing at all.",
        "The signal was gone before I could trace it.",
        "I knew what it meant. I just didn't want to say it out loud.",
        "Something is wrong with the archive.",
        "You were never supposed to find this.",
        "Three days. That's all we had.",
        "It doesn't matter anymore. None of it does.",
        "She looked at me like I was already gone.",
        "I've seen that look before. It never ends well.",
        "The door was open. It shouldn't have been.",
    ]
    char_dir = _project_dir(project_id) / "characters" / character_id
    corpus_dir = char_dir / "rvc_corpus"
    corpus_dir.mkdir(parents=True, exist_ok=True)

    per_emotion = max(1, target_count // len(approved))
    job_ids = []
    global_take = 0  # used to rotate test lines across all takes

    for entry in approved:
        emotion = entry["emotion"]
        # Resolve relative paths (Pharaoh-1qp) so the chatterbox server sees absolute.
        ref_path = _resolve_voice_path(project_id, character_id, entry["ref_audio_path"])
        tag_cycle = tag_variants * ((per_emotion // len(tag_variants)) + 1)

        for i in range(per_emotion):
            tag = tag_cycle[i % len(tag_variants)]
            # Rotate through varied test lines for prosodic diversity
            base_line = _CORPUS_TEST_LINES[global_take % len(_CORPUS_TEST_LINES)]
            text = f"{tag}{base_line}" if tag.startswith("[") else f"{base_line}{tag}" if tag else base_line
            global_take += 1
            out_path = str(corpus_dir / f"{emotion}_{i:03d}.wav")

            try:
                resp = _post("chatterbox", "/generate/clone", {
                    "text": text.strip(),
                    "ref_audio_path": ref_path,
                    "exaggeration": 0.45,
                    "cfg_weight": 0.5,
                    "temperature": 0.8,
                    "seed": i,
                    "output_path": out_path,
                }, upload_fields=("ref_audio_path",))
                job_ids.append(resp.get("job_id", "unknown"))
            except Exception as exc:
                return json.dumps({
                    "error": (
                        f"corpus generation stopped after queueing {len(job_ids)} take(s) "
                        f"(failed on emotion '{emotion}', take {i}): {exc}"
                    ),
                    "partial_job_ids": job_ids,
                })

    return json.dumps({
        "status": "queued",
        "total_takes": len(job_ids),
        "job_ids": job_ids,
        "corpus_dir": str(corpus_dir),
        "note": "Poll job_status(job_id) for each. Takes ~8 min total. Then run train_rvc_model.",
    }, indent=2)


@mcp.tool()
def train_rvc_model(project_id: str, character_id: str, epochs: int = 100) -> str:
    """
    Train an RVC voice model from the character's Chatterbox corpus (Stage 4).

    Scans characters/{character_id}/rvc_corpus/ for WAV files and submits a
    training job to the RVC server (port 18006). Training typically takes
    10–20 minutes on GPU.

    Output files:
      characters/{character_id}/rvc/{character_name}.pth    ← voice model
      characters/{character_id}/rvc/{character_name}.index  ← FAISS index

    PREREQUISITES: corpus_status() must show ready_for_training == true
    (at least 5 minutes / ~20+ WAV files in rvc_corpus/).

    Returns a job_id. Poll job_status(job_id) until status == "complete".
    """
    proj = _project_json(project_id)
    char = next(
        (c for c in proj.get("characters", []) if c["id"] == character_id),
        None,
    )
    if char is None:
        return json.dumps({"error": (
            f"character {character_id} not found in project {project_id}. "
            f"Known characters: {_known_characters(proj)}"
        )})

    char_name = char.get("name", "voice").replace(" ", "_").lower()
    char_dir = _project_dir(project_id) / "characters" / character_id
    corpus_dir = char_dir / "rvc_corpus"
    rvc_dir = char_dir / "rvc"
    rvc_dir.mkdir(parents=True, exist_ok=True)

    corpus_wavs = sorted(corpus_dir.glob("*.wav")) if corpus_dir.exists() else []
    if not corpus_wavs:
        return json.dumps({"error": (
            f"rvc_corpus/ is empty for character {character_id} "
            f"(looked in {corpus_dir}). Run build_corpus first."
        )})

    try:
        resp = _post("rvc", "/train", {
            "corpus_paths": [str(p) for p in corpus_wavs],
            "output_model_path": str(rvc_dir / f"{char_name}.pth"),
            "output_index_path": str(rvc_dir / f"{char_name}.index"),
            "character_name": char_name,
            "sample_rate": 48000,
            "epochs": epochs,
        })
        return json.dumps({
            "job_id": resp.get("job_id"),
            "status": "training_started",
            "corpus_files": len(corpus_wavs),
            "output_dir": str(rvc_dir),
            "note": "Training takes 10–20 min on GPU. Poll job_status(job_id).",
        }, indent=2)
    except Exception as exc:
        return json.dumps({"error": (
            f"failed to submit RVC training job for character {character_id} "
            f"({len(corpus_wavs)} corpus files): {exc}"
        )})


@mcp.tool()
def rvc_convert(
    project_id: str,
    character_id: str,
    input_path: str,
    output_path: str,
    pitch_shift: int = 0,
    index_rate: float = 0.5,
) -> str:
    """
    Convert a single audio file using the character's trained RVC model.

    Use this to:
    - Test the pipeline on a sample line before committing to full production
    - Manually apply the RVC pass to a specific Chatterbox take
    - A/B compare Chatterbox-only vs Chatterbox+RVC output

    The character must have a trained RVC model (Stage 4 complete).
    generate_tts() applies this automatically when rvc_enabled is true.

    Args:
        input_path:   Absolute path to Chatterbox output WAV.
        output_path:  Where to write the RVC-converted WAV.
        pitch_shift:  Semitones (default 0). Use negative to lower pitch.
        index_rate:   0–1. Lower preserves [sigh][chuckle] tags; higher = more consistent.
    """
    proj = _project_json(project_id)
    char = next(
        (c for c in proj.get("characters", []) if c["id"] == character_id),
        None,
    )
    if char is None:
        return json.dumps({"error": (
            f"character {character_id} not found in project {project_id}. "
            f"Known characters: {_known_characters(proj)}"
        )})

    va = char.get("voice_assignment", {})
    model_path = va.get("rvc_model_path")
    index_path = va.get("rvc_index_path", "")

    if not model_path or not Path(model_path).exists():
        char_name = char.get("name", "voice").replace(" ", "_").lower()
        char_dir = _project_dir(project_id) / "characters" / character_id
        # Try the conventional location
        fallback = char_dir / "rvc" / f"{char_name}.pth"
        if fallback.exists():
            model_path = str(fallback)
        else:
            return json.dumps({
                "error": "No trained RVC model found. Run train_rvc_model first.",
                "looked_for": [str(fallback)],
            })

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    try:
        resp = _post("rvc", "/convert", {
            "input_path": input_path,
            "output_path": output_path,
            "model_path": model_path,
            "index_path": index_path,
            "pitch_shift": pitch_shift,
            "f0_method": "rmvpe",
            "index_rate": index_rate,
            "filter_radius": 3,
            "rms_mix_rate": 0.25,
            "protect": va.get("rvc_protect", 0.33),
        }, upload_fields=("input_path",))
        return json.dumps(resp, indent=2)
    except Exception as exc:
        return json.dumps({"error": (
            f"RVC conversion failed for {input_path} "
            f"(character {character_id}, model {model_path}): {exc}"
        )})
