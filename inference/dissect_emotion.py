"""
Emotion tagging for dissected dialogue (emotion2vec+ large).

Diarization turns are short (median ~2 s), so consecutive turns by the same
speaker are first joined into *utterances* of up to ~12 s — the length a
voice-clone reference wants. Each utterance gets emotion2vec's utterance-level
scores over seven emotions. The palette then offers a character's real clips
per emotion as clone references: Chatterbox copies a reference's delivery as
much as its timbre, so a genuinely angry clip gives angry lines.

Each utterance also gets a delivery profile — pace (words/s from the word
timings), loudness, pitch level and movement, breathiness — and emotion2vec's
1024-d embedding (`emotion_vecs.f16`), so palette emotions can be *recipes*
(blends of the seven classes plus delivery targets: "tender" = happy + soft +
slow) and any clip can find "more like this".

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
VERSION = 2          # 2: prosody features + embeddings
VECS_FILE = "emotion_vecs.f16"   # N × EMB_DIM little-endian float16, L2-normalised, utterance order
EMB_DIM = 1024
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

    `turns` are manifest turn rows: speaker, start, end, text, overlap, and
    optionally `words` ({word, start, end}) for the speaking rate.
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
            b = a + step
            words = [w for w in cur["words"] if w.get("start", -1) >= a - 1e-3 and w.get("end", 1e9) <= b + 1e-3]
            out.append({
                "speaker": cur["speaker"], "start": round(a, 3), "end": round(b, 3),
                "text": cur["text"] if n == 1 else " ".join(w.get("word", "") for w in words),
                "overlap": cur["overlap"], "rate": speaking_rate(words),
            })

    for t in sorted(turns, key=lambda t: t["start"]):
        if (cur is not None and t["speaker"] == cur["speaker"]
                and t["start"] - cur["end"] <= gap_s and t["end"] - cur["start"] <= max_s):
            cur["end"] = max(cur["end"], t["end"])
            cur["text"] = (cur["text"] + " " + (t.get("text") or "")).strip()
            cur["overlap"] = cur["overlap"] or bool(t.get("overlap"))
            cur["words"] += t.get("words") or []
        else:
            flush()
            cur = {"speaker": t["speaker"], "start": float(t["start"]), "end": float(t["end"]),
                   "text": t.get("text") or "", "overlap": bool(t.get("overlap")),
                   "words": list(t.get("words") or [])}
    flush()
    return out


def speaking_rate(words: list[dict]) -> Optional[float]:
    """Words per second of speech, or None without word timings."""
    if len(words) < 3:
        return None
    span = words[-1]["end"] - words[0]["start"]
    return round(len(words) / span, 2) if span > 0.5 else None


def prosody(x: np.ndarray) -> dict:
    """Delivery profile of a 16 kHz mono clip.

    loud_db: RMS of the active frames · f0_hz: median pitch · f0_var: pitch
    movement (semitone std) · flat: median spectral flatness (high = breathy /
    whispered, unvoiced) · voiced: fraction of active frames with a pitch.
    """
    import librosa

    out = {"loud_db": None, "f0_hz": None, "f0_var": None, "flat": None, "voiced": None}
    if len(x) < SR // 2:
        return out
    hop = 320
    rms = librosa.feature.rms(y=x, frame_length=1024, hop_length=hop)[0]
    floor = max(1e-4, float(np.percentile(rms, 95)) * 0.1)
    active = rms > floor
    if active.sum() < 5:
        return out
    out["loud_db"] = round(float(20 * np.log10(np.sqrt(np.mean(rms[active] ** 2)) + 1e-9)), 2)
    S = np.abs(librosa.stft(x, n_fft=512, hop_length=hop))
    flat = librosa.feature.spectral_flatness(S=S)[0]
    n = min(len(flat), len(active))
    out["flat"] = round(float(np.median(flat[:n][active[:n]])), 4)
    f0 = librosa.yin(x, fmin=65, fmax=600, sr=SR, frame_length=1024, hop_length=hop)
    n = min(len(f0), len(active))
    f0, act = f0[:n], active[:n]
    # yin always answers; keep frames whose pitch sits away from the search
    # bounds (unvoiced frames pile up there) and are active.
    ok = act & (f0 > 70) & (f0 < 580)
    out["voiced"] = round(float(ok.sum() / max(1, act.sum())), 3)
    if ok.sum() >= 5:
        semis = 12 * np.log2(f0[ok] / np.median(f0[ok]))
        out["f0_hz"] = round(float(np.median(f0[ok])), 1)
        out["f0_var"] = round(float(np.std(semis)), 3)
    return out


class EmotionTagger:
    """emotion2vec+ large through FunASR. ~1.2 GB VRAM; ~10 ms per utterance on a 4090."""

    def __init__(self, device: str = "cuda") -> None:
        from funasr import AutoModel
        dev = device
        if dev == "cuda":
            dev = "cuda:0"
        self.model = AutoModel(model=MODEL_ID, hub="hf", disable_update=True, device=dev)

    def scores(self, clips: list[np.ndarray]) -> list[tuple[dict[str, float], np.ndarray]]:
        """Per clip: class scores and the L2-normalised utterance embedding."""
        res = self.model.generate(clips, granularity="utterance", extract_embedding=True, disable_pbar=True)
        out = []
        for r in res:
            raw = {lab.split("/")[-1]: float(s) for lab, s in zip(r["labels"], r["scores"])}
            v = np.asarray(r.get("feats", np.zeros(EMB_DIM)), dtype=np.float32).reshape(-1)
            out.append(({k: round(raw.get(k, 0.0), 4) for k in LABELS}, v / (np.linalg.norm(v) + 1e-9)))
        return out


def tag(tagger: EmotionTagger, utts: list[dict], audio: Callable[[float, float], np.ndarray],
        progress: Optional[ProgressFn] = None) -> tuple[list[dict], np.ndarray]:
    """Score each utterance in place (adds `scores`, `emotion` and the delivery
    profile); returns (utts, embeddings N × EMB_DIM float16)."""
    from concurrent.futures import ThreadPoolExecutor

    vecs = np.zeros((len(utts), EMB_DIM), dtype=np.float16)
    with ThreadPoolExecutor(max_workers=6) as pool:
        for i in range(0, len(utts), BATCH):
            batch = utts[i:i + BATCH]
            clips = [audio(u["start"], u["end"]) for u in batch]
            # A clip of digital silence would only produce noise; give it a floor.
            clips = [c if len(c) >= SR // 4 else np.zeros(SR // 4, np.float32) for c in clips]
            profiles = pool.map(prosody, clips)  # CPU, overlaps the GPU pass
            for k, (u, (s, v)) in enumerate(zip(batch, tagger.scores(clips))):
                u["scores"] = s
                u["emotion"] = max(s, key=s.get)
                if len(v) == EMB_DIM:
                    vecs[i + k] = v.astype(np.float16)
            for u, p in zip(batch, profiles):
                u.update(p)
            if progress:
                progress(min(1.0, (i + len(batch)) / max(1, len(utts))),
                         f"Reading emotions · {i + len(batch)} of {len(utts)} lines")
    return utts, vecs


def result(utts: list[dict]) -> dict:
    return {"model": MODEL_ID, "version": VERSION, "labels": list(LABELS), "vectors": VECS_FILE,
            "embedding_dim": EMB_DIM, "utterances": utts}


def tag_file(tagger: EmotionTagger, audio_path: str, turns: list[dict],
             progress: Optional[ProgressFn] = None) -> tuple[dict, np.ndarray]:
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
        utts, vecs = tag(tagger, utterances(turns), audio, progress)
        return result(utts), vecs
    finally:
        f.close()
