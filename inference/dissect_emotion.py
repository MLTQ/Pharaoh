"""
Emotion tagging for dissected dialogue (emotion2vec+ large).

Diarization turns are short (median ~2 s), so consecutive turns by the same
speaker are first joined into *utterances* of up to ~12 s — the length a
voice-clone reference wants. Each utterance gets emotion2vec's utterance-level
scores over seven emotions. The palette then offers a character's real clips
per emotion as clone references: Chatterbox copies a reference's delivery as
much as its timbre, so a genuinely angry clip gives angry lines.

Used two ways: at the end of a dissect run (the dialogue is already in memory
as 16 kHz mono), and standalone for imports dissected before this existed
(`tag_file`: the client uploads a 16 kHz mono rendering of the dialogue stem).
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

import numpy as np

log = logging.getLogger(__name__)

MODEL_ID = "emotion2vec/emotion2vec_plus_large"
SR = 16000
# emotion2vec's classes, minus "other" and "<unk>" (no use as palette labels).
LABELS = ("angry", "disgusted", "fearful", "happy", "neutral", "sad", "surprised")

MAX_UTT_S = 12.0   # join same-speaker turns up to this length
JOIN_GAP_S = 0.6   # ...when the pause between them is at most this
MIN_UTT_S = 1.0    # shorter utterances carry too little to classify
BATCH = 32

ProgressFn = Callable[[float, str], None]


def utterances(turns: list[dict], max_s: float = MAX_UTT_S, gap_s: float = JOIN_GAP_S,
               min_s: float = MIN_UTT_S) -> list[dict]:
    """Join consecutive same-speaker turns into utterances; split long ones.

    `turns` are manifest turn rows: speaker, start, end, text, overlap.
    """
    out: list[dict] = []
    cur: Optional[dict] = None

    def flush():
        if cur is None:
            return
        dur = cur["end"] - cur["start"]
        if dur < min_s:
            return
        # A single long turn is cut into even pieces no longer than max_s.
        n = max(1, int(np.ceil(dur / max_s)))
        step = dur / n
        for k in range(n):
            a = cur["start"] + k * step
            out.append({
                "speaker": cur["speaker"], "start": round(a, 3), "end": round(a + step, 3),
                "text": cur["text"] if n == 1 else "", "overlap": cur["overlap"],
            })

    for t in sorted(turns, key=lambda t: t["start"]):
        if (cur is not None and t["speaker"] == cur["speaker"]
                and t["start"] - cur["end"] <= gap_s and t["end"] - cur["start"] <= max_s):
            cur["end"] = max(cur["end"], t["end"])
            cur["text"] = (cur["text"] + " " + (t.get("text") or "")).strip()
            cur["overlap"] = cur["overlap"] or bool(t.get("overlap"))
        else:
            flush()
            cur = {"speaker": t["speaker"], "start": float(t["start"]), "end": float(t["end"]),
                   "text": t.get("text") or "", "overlap": bool(t.get("overlap"))}
    flush()
    return out


class EmotionTagger:
    """emotion2vec+ large through FunASR. ~1.2 GB VRAM; ~10 ms per utterance on a 4090."""

    def __init__(self, device: str = "cuda") -> None:
        from funasr import AutoModel
        dev = device
        if dev == "cuda":
            dev = "cuda:0"
        self.model = AutoModel(model=MODEL_ID, hub="hf", disable_update=True, device=dev)

    def scores(self, clips: list[np.ndarray]) -> list[dict[str, float]]:
        res = self.model.generate(clips, granularity="utterance", extract_embedding=False, disable_pbar=True)
        out = []
        for r in res:
            raw = {lab.split("/")[-1]: float(s) for lab, s in zip(r["labels"], r["scores"])}
            out.append({k: round(raw.get(k, 0.0), 4) for k in LABELS})
        return out


def tag(tagger: EmotionTagger, utts: list[dict], audio: Callable[[float, float], np.ndarray],
        progress: Optional[ProgressFn] = None) -> list[dict]:
    """Score each utterance in place (adds `scores` and `emotion`); returns utts."""
    for i in range(0, len(utts), BATCH):
        batch = utts[i:i + BATCH]
        clips = [audio(u["start"], u["end"]) for u in batch]
        # A clip of digital silence would only produce noise; give it a floor.
        clips = [c if len(c) >= SR // 4 else np.zeros(SR // 4, np.float32) for c in clips]
        for u, s in zip(batch, tagger.scores(clips)):
            u["scores"] = s
            u["emotion"] = max(s, key=s.get)
        if progress:
            progress(min(1.0, (i + len(batch)) / max(1, len(utts))),
                     f"Reading emotions · {i + len(batch)} of {len(utts)} lines")
    return utts


def result(utts: list[dict]) -> dict:
    return {"model": MODEL_ID, "labels": list(LABELS), "utterances": utts}


def tag_file(tagger: EmotionTagger, audio_path: str, turns: list[dict],
             progress: Optional[ProgressFn] = None) -> dict:
    """Standalone: tag `turns` against a 16 kHz mono file (read by seeking)."""
    import soundfile as sf

    f = sf.SoundFile(audio_path)
    if f.samplerate != SR:
        raise ValueError(f"expected {SR} Hz audio, got {f.samplerate}")

    def audio(a: float, b: float) -> np.ndarray:
        f.seek(max(0, int(a * SR)))
        x = f.read(max(1, int((b - a) * SR)), dtype="float32", always_2d=True)
        return x.mean(axis=1)

    try:
        return result(tag(tagger, utterances(turns), audio, progress))
    finally:
        f.close()
