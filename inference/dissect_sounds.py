"""
Sound effects, ambience and music found in a dissected recording.

Works from the per-stem loudness envelopes `dissect_pipeline.stream_stems`
records (50 ms frames), so detection over a 20 h audiobook is a few numpy
passes rather than a re-read of the audio:

    effects stem → short events  → "sfx"       (door, footsteps, gunshot …)
                 → human sounds  → "vocal"     (gasp, laugh, sigh — tagged, split out)
                 → long regions  → "ambience"  (rain, crowd, room tone …)
    music stem   → regions       → "music"     (stings < 8 s, cues / beds ≥ 8 s;
                                                dropped when the tagger hears no music)

Each found region is then labelled by an AudioSet classifier (AST) reading a
≤ 10 s excerpt of its stem, so the UI can show "Door · Knock" instead of an
anonymous blip. Without transformers the regions are still returned, unlabelled.
"""
from __future__ import annotations

import logging
from typing import Optional

import numpy as np

import dissect_pipeline as dp

log = logging.getLogger(__name__)

TAGGER_ID = "MIT/ast-finetuned-audioset-10-10-0.4593"
TAG_SR = 16000
TAG_MAX_S = 10.0

# Caps keep a long book's manifest browsable; the strongest are kept. They
# scale with length — a flat 100 ambience cap truncated a 20 h audiobook.
MAX_SFX = 300
MAX_AMBIENCE = 100
MAX_MUSIC = 150
CAP_PER_HOUR = {"sfx": 60, "ambience": 25, "music": 25}
CAP_CEILING = {"sfx": 1500, "ambience": 500, "music": 500}


def caps(duration_s: float) -> dict[str, int]:
    h = max(0.0, duration_s) / 3600
    base = {"sfx": MAX_SFX, "ambience": MAX_AMBIENCE, "music": MAX_MUSIC}
    return {k: min(CAP_CEILING[k], max(base[k], int(CAP_PER_HOUR[k] * h))) for k in base}

# Labels that say nothing useful about an effect (the stem is effects by
# construction; speech/music labels are bleed).
_SFX_NOISE = {
    "Speech", "Silence", "Music", "Male speech, man speaking", "Female speech, woman speaking",
    "Narration, monologue", "Conversation", "Inside, small room", "Inside, large room or hall",
    "Inside, public space", "Outside, urban or manmade", "Outside, rural or natural", "Sound effect",
    "Noise", "Environmental noise",
}
# Nonverbal performance sounds that the separator routes to the effects stem.
# They are real material (Chatterbox tags, breaths) but not sound effects.
HUMAN_VOCAL = {
    "Speech", "Conversation", "Narration, monologue", "Male speech, man speaking",
    "Female speech, woman speaking", "Child speech, kid speaking", "Babbling", "Whispering",
    "Gasp", "Sigh", "Chuckle, chortle", "Giggle", "Laughter", "Snicker", "Belly laugh", "Baby laughter",
    "Throat clearing", "Cough", "Sneeze", "Sniff", "Breathing", "Pant", "Wheeze", "Snoring", "Gargling",
    "Whimper", "Crying, sobbing", "Wail, moan", "Groan", "Grunt", "Screaming", "Shout", "Yell",
    "Humming", "Hiccup", "Burping, eructation", "Chewing, mastication", "Human voice",
}
# Plain speech on the effects stem is dialogue bleed, not a performance sound.
SPEECH = {"Speech", "Conversation", "Narration, monologue", "Male speech, man speaking",
          "Female speech, woman speaking", "Child speech, kid speaking", "Babbling", "Human voice"}
HUMAN_VOCAL -= SPEECH

# The tagger's "Music" score must reach this for a music-stem region to count.
MUSIC_MIN = 0.15

_MUSIC_NOISE = {"Speech", "Silence", "Music", "Narration, monologue", "Male speech, man speaking",
                "Female speech, woman speaking"}


def regions(power: np.ndarray, rel_db: float, abs_db: float, gap_s: float, min_s: float) -> list[dict]:
    """Contiguous stretches louder than the stem's own noise floor.

    floor = 20th percentile of non-silent frames; threshold = max(floor +
    rel_db, abs_db). Runs closer than `gap_s` merge; runs shorter than `min_s`
    drop. Returns [{start, end, peak_db, floor_db}] in seconds.
    """
    if len(power) == 0:
        return []
    dbs = 10 * np.log10(power + 1e-12)
    live = dbs[dbs > -100]
    floor = float(np.percentile(live, 20)) if len(live) else -100.0
    thr = max(floor + rel_db, abs_db)
    active = dbs > thr
    if not active.any():
        return []
    # Run boundaries.
    d = np.diff(np.concatenate([[0], active.astype(np.int8), [0]]))
    starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
    gap = int(round(gap_s / dp.ENV_FRAME_S))
    merged: list[list[int]] = []
    for a, b in zip(starts, ends):
        if merged and a - merged[-1][1] <= gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    min_f = int(round(min_s / dp.ENV_FRAME_S))
    out = []
    for a, b in merged:
        if b - a < min_f:
            continue
        out.append({
            "start": round(a * dp.ENV_FRAME_S, 3),
            "end": round(b * dp.ENV_FRAME_S, 3),
            "peak_db": round(float(dbs[a:b].max()), 1),
            "floor_db": round(floor, 1),
        })
    return out


def beds(power: np.ndarray, abs_db: float = -48.0, gap_s: float = 1.5, min_s: float = 8.0) -> list[dict]:
    """Sustained stretches above an absolute level.

    `regions` measures against the stem's own floor, so a bed that runs under
    the whole recording (rain, a crowd, room tone) *is* the floor and never
    shows up there. This pass catches it by level alone.
    """
    if len(power) == 0:
        return []
    dbs = 10 * np.log10(power + 1e-12)
    # Smooth over ~1 s so a bed's texture doesn't break it into pieces.
    k = max(1, int(round(1.0 / dp.ENV_FRAME_S)))
    sm = np.convolve(dbs, np.ones(k) / k, mode="same")
    active = sm > abs_db
    if not active.any():
        return []
    d = np.diff(np.concatenate([[0], active.astype(np.int8), [0]]))
    starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
    gap = int(round(gap_s / dp.ENV_FRAME_S))
    merged: list[list[int]] = []
    for a, b in zip(starts, ends):
        if merged and a - merged[-1][1] <= gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    out = []
    for a, b in merged:
        if (b - a) * dp.ENV_FRAME_S < min_s:
            continue
        out.append({"start": round(a * dp.ENV_FRAME_S, 3), "end": round(b * dp.ENV_FRAME_S, 3),
                    "peak_db": round(float(dbs[a:b].max()), 1), "floor_db": round(abs_db, 1),
                    "level_db": round(float(np.median(dbs[a:b])), 1)})
    return out


def classify(effects: list[dict], music: list[dict], sustained: Optional[list[dict]] = None,
             duration_s: float = 0.0) -> tuple[list[dict], list[dict], list[dict]]:
    """Split effect regions into sfx vs ambience, give music a role, cap each list.

    `sustained` (from `beds`) adds level-based ambience; floor-relative long
    regions that overlap one are folded into it rather than listed twice.
    """
    sfx, amb = [], []
    for r in effects:
        dur = r["end"] - r["start"]
        prominence = r["peak_db"] - r["floor_db"]
        if dur <= 6.0:
            # A little pre-roll and tail so the attack and decay survive the cut.
            sfx.append({**r, "start": round(max(0.0, r["start"] - 0.1), 3), "end": round(r["end"] + 0.3, 3),
                        "kind": "sfx", "prominence": round(prominence, 1)})
        else:
            amb.append({**r, "kind": "ambience", "prominence": round(prominence, 1)})
    for b in sustained or []:
        if any(a["start"] < b["end"] and b["start"] < a["end"] for a in amb):
            continue
        amb.append({**b, "kind": "ambience", "prominence": round(b["peak_db"] - b["floor_db"], 1)})
    mus = []
    for r in music:
        dur = r["end"] - r["start"]
        mus.append({**r, "kind": "music", "role": "sting" if dur < 8.0 else "cue",
                    "prominence": round(r["peak_db"] - r["floor_db"], 1)})
    cap = caps(duration_s)
    sfx = sorted(sfx, key=lambda r: -r["prominence"])[:cap["sfx"]]
    amb = sorted(amb, key=lambda r: -(r["end"] - r["start"]) * max(r["prominence"], 1.0))[:cap["ambience"]]
    mus = sorted(mus, key=lambda r: -(r["end"] - r["start"]))[:cap["music"]]
    return (sorted(sfx, key=lambda r: r["start"]), sorted(amb, key=lambda r: r["start"]),
            sorted(mus, key=lambda r: r["start"]))


class Tagger:
    """AudioSet AST classifier, loaded once per Models instance."""

    def __init__(self, device: str) -> None:
        from transformers import ASTFeatureExtractor, ASTForAudioClassification
        self.fe = ASTFeatureExtractor.from_pretrained(TAGGER_ID)
        self.model = ASTForAudioClassification.from_pretrained(TAGGER_ID).to(device).eval()
        self.device = device
        self.labels = self.model.config.id2label

    def tag(self, clips: list[np.ndarray], top: int = 3) -> list[list[dict]]:
        import torch
        out: list[list[dict]] = []
        for i in range(0, len(clips), 16):
            batch = clips[i:i + 16]
            feats = self.fe(batch, sampling_rate=TAG_SR, return_tensors="pt")
            with torch.inference_mode():
                logits = self.model(**{k: v.to(self.device) for k, v in feats.items()}).logits
            probs = torch.sigmoid(logits).float().cpu().numpy()
            for row in probs:
                idx = np.argsort(-row)[: top + 6]
                out.append([{"label": self.labels[int(j)], "score": round(float(row[j]), 3)} for j in idx])
        return out


def _excerpt(reader: dp.StemReader, stem: str, r: dict) -> np.ndarray:
    a, b = r["start"], r["end"]
    if b - a > TAG_MAX_S:  # the middle is the most representative stretch
        mid = (a + b) / 2
        a, b = mid - TAG_MAX_S / 2, mid + TAG_MAX_S / 2
    x = dp.to_mono(reader.read(stem, a, b)).astype(np.float32)
    x = dp.resample(x, dp.SEP_SR, TAG_SR).astype(np.float32)
    return x if len(x) >= TAG_SR // 4 else np.pad(x, (0, TAG_SR // 4 - len(x)))


def _name(labels: list[dict], noise: set, fallback: str) -> tuple[str, list[dict]]:
    kept = [l for l in labels if l["label"] not in noise and l["score"] >= 0.05][:3]
    return (" · ".join(l["label"] for l in kept[:2]) or fallback), kept


def find_sounds(env: dp.Envelope, reader: dp.StemReader, chapters: list[dict],
                models: Optional[dp.Models], progress: dp.ProgressFn) -> dict:
    progress(0.0, "Finding sound effects and music")
    fx_power = env.frames.get("effects", np.zeros(0))
    effects = regions(fx_power, rel_db=12.0, abs_db=-50.0, gap_s=0.25, min_s=0.15)
    music = regions(env.frames.get("music", np.zeros(0)), rel_db=10.0, abs_db=-45.0, gap_s=2.0, min_s=3.0)
    duration_s = len(fx_power) * dp.ENV_FRAME_S
    sfx, amb, mus = classify(effects, music, beds(fx_power), duration_s)

    warnings: list[str] = []
    tagger = None
    if models is not None and (sfx or amb or mus):
        try:
            tagger = getattr(models, "tagger", None) or Tagger(models.device)
            models.tagger = tagger
        except Exception as exc:
            warnings.append(f"Sound labelling unavailable ({exc.__class__.__name__}: {exc}); sounds are unlabelled.")

    raw: dict[int, list[dict]] = {}
    groups = [("sfx", sfx, "effects", _SFX_NOISE, "Sound"), ("ambience", amb, "effects", _SFX_NOISE, "Ambience"),
              ("music", mus, "music", _MUSIC_NOISE, "Music")]
    total = sum(len(g[1]) for g in groups) or 1
    done = 0
    for kind, items, stem, noise, fallback in groups:
        for k, r in enumerate(items, 1):
            r["id"] = f"{kind[:3]}{k}"
            r["stem"] = stem
            r["duration"] = round(r["end"] - r["start"], 3)
            r["chapter"] = dp.chapter_of(chapters, r["start"])
            r["name"], r["labels"] = fallback, []
        if tagger is not None:
            for i in range(0, len(items), 16):
                batch = items[i:i + 16]
                tags = tagger.tag([_excerpt(reader, stem, r) for r in batch])
                for r, t in zip(batch, tags):
                    raw[id(r)] = t
                    r["name"], r["labels"] = _name(t, noise, fallback)
                done += len(batch)
                progress(done / total, f"Labelling sounds · {done} / {total}")
    vocal: list[dict] = []
    if tagger is not None:
        keep = []
        for r in sfx:
            labels = raw.get(id(r), [])
            top = labels[0]["label"] if labels else None
            if top in SPEECH:
                # Dialogue bleed unless the tagger also hears a real sound.
                other = next((l for l in labels if l["label"] not in SPEECH and l["label"] not in HUMAN_VOCAL
                              and l["label"] not in _SFX_NOISE and l["score"] >= 0.1), None)
                if other is None:
                    continue
                r["name"] = other["label"]
                keep.append(r)
            elif top in HUMAN_VOCAL:
                # Nonverbal performance sounds: their own group.
                vocal.append({**r, "kind": "vocal", "name": top})
            else:
                keep.append(r)
        sfx = keep
        # Music-stem regions the tagger doesn't hear as music are bleed.
        mus = [r for r in mus
               if max((l["score"] for l in raw.get(id(r), []) if l["label"] == "Music"), default=0.0) >= MUSIC_MIN]
        for k, r in enumerate(vocal, 1):
            r["id"] = f"voc{k}"
        for k, r in enumerate(sfx, 1):
            r["id"] = f"sfx{k}"
        for k, r in enumerate(mus, 1):
            r["id"] = f"mus{k}"
    progress(1.0, "Sounds found")
    return {"sfx": sfx, "vocal": vocal, "ambience": amb, "music": mus,
            "tagger": TAGGER_ID if tagger is not None else None, "warnings": warnings}
