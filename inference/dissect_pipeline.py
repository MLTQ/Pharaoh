"""
Dissect pipeline — take a finished audio drama apart.

    source → separate (dialogue / music / effects)
           → diarize the dialogue stem (who spoke when)
           → link speakers across diarization chunks (voice embeddings)
           → transcribe every speaker turn (word timestamps)
           → pick clean 3–15 s solo reference clips per speaker

Everything here is synchronous and GPU-bound; `dissect_server.py` runs it in
a worker thread under the process-wide inference lock. When the ML stack is
unavailable (or PHARAOH_DISSECT_STUB=1) a stub path produces the same manifest
shape from simple energy-based segmentation so the UI works on any machine.

The output directory is self-contained and relocatable: every path in
`manifest.json` is relative to it.
"""
from __future__ import annotations

import bisect
import datetime
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import soundfile as sf

log = logging.getLogger(__name__)

MANIFEST_VERSION = 1

MODEL_DIR = Path(
    os.environ.get("PHARAOH_DISSECT_MODEL_DIR", Path.home() / "pharaoh-models" / "dissect")
).expanduser()
MSST_DIR = Path(os.environ.get("PHARAOH_MSST_DIR", MODEL_DIR / "msst")).expanduser()
SEPARATOR_CONFIG = MODEL_DIR / "config_dnr_bandit_bsrnn_multi_mus64.yaml"
SEPARATOR_WEIGHTS = MODEL_DIR / "model_bandit_plus_dnr_sdr_11.47.chpt"

DIARIZER_ID = "nvidia/Nemotron-3-Diarization"
EMBEDDER_ID = "nvidia/speakerverification_en_titanet_large"
ASR_ID = "nvidia/parakeet-tdt-0.6b-v3"
SEPARATOR_ID = "bandit-plus-dnr"

SEP_SR = 44100      # BandIt Plus native rate
ML_SR = 16000       # diarizer / embedder / ASR rate
CLIP_SR = 48000     # project-standard rate for exported reference clips
BLEED_CAP_DB = 60.0 # dialogue-over-bed ratios above this all mean "nothing underneath"

# Streaming: sources are processed in windows so memory stays flat however
# long they are (a 20 h audiobook decoded whole is ~26 GB before separation).
WINDOW_S = 600.0    # 10 min per window; a multiple of ENV_FRAME_S
CONTEXT_S = 8.0     # separator context either side (> its 6 s chunk)
ENV_FRAME_S = 0.05  # loudness-envelope resolution (per stem, mono)

ProgressFn = Callable[[float, str], None]


class DissectCancelled(Exception):
    """Raised from a progress callback to stop a run at the next checkpoint."""


@dataclass
class DissectOptions:
    separate: bool = True
    transcribe: bool = True
    max_candidates: int = 6
    min_clip_s: float = 3.0
    max_clip_s: float = 15.0
    # The diarizer tracks at most 8 speakers per pass. Long sources are cut
    # into chunks and the per-chunk speakers are re-linked by voice embedding.
    chunk_minutes: float = 20.0
    # Cosine similarity above which two chunk-local speakers are the same voice.
    link_threshold: float = 0.6


@dataclass
class Turn:
    speaker: str
    start: float
    end: float
    text: str = ""
    words: list = field(default_factory=list)
    overlap: bool = False


# ── Audio I/O ─────────────────────────────────────────────────────────────────

# Tags worth carrying from an audiobook / podcast container into the manifest.
_KEPT_TAGS = ("title", "album", "artist", "album_artist", "composer", "genre", "date",
              "comment", "description", "copyright")


def probe_container(path: str) -> dict:
    """Chapters, descriptive tags and embedded cover art of a source file.

    Returns {"chapters": [{index, title, start, end}], "tags": {...},
    "cover_stream": int|None, "cover_codec": str|None}. Empty on any probe
    failure — metadata is a bonus, never a reason to fail the import.
    """
    out = {"chapters": [], "tags": {}, "cover_stream": None, "cover_codec": None, "duration": None}
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_chapters",
             "-show_format", "-show_streams", path],
            check=True, capture_output=True, timeout=60,
        )
        info = json.loads(res.stdout or b"{}")
    except Exception as exc:
        log.warning("ffprobe failed for %s: %s", path, exc)
        return out
    for i, ch in enumerate(info.get("chapters") or []):
        try:
            start, end = float(ch["start_time"]), float(ch["end_time"])
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            continue
        title = ((ch.get("tags") or {}).get("title") or "").strip() or f"Chapter {i + 1}"
        out["chapters"].append({"index": len(out["chapters"]), "title": title,
                                "start": round(start, 3), "end": round(end, 3)})
    try:
        out["duration"] = float((info.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        pass
    tags = {k.lower(): v for k, v in ((info.get("format") or {}).get("tags") or {}).items()}
    out["tags"] = {k: str(tags[k])[:2000] for k in _KEPT_TAGS if tags.get(k)}
    for st in info.get("streams") or []:
        if st.get("codec_type") == "video" and (st.get("disposition") or {}).get("attached_pic"):
            out["cover_stream"] = int(st["index"])
            out["cover_codec"] = st.get("codec_name")
            break
    return out


def extract_cover(path: str, stream: int, codec: Optional[str], out_dir: Path) -> Optional[str]:
    """Copy an embedded cover image out as cover.jpg / cover.png. Returns the relative path."""
    rel = "cover.png" if codec == "png" else "cover.jpg"
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", path,
             "-map", f"0:{stream}", "-frames:v", "1", "-c:v", "copy", str(out_dir / rel)],
            check=True, capture_output=True, timeout=60,
        )
    except Exception:
        # Unusual codecs (bmp, gif) won't stream-copy into .jpg — re-encode.
        try:
            rel = "cover.jpg"
            subprocess.run(
                ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", path,
                 "-map", f"0:{stream}", "-frames:v", "1", str(out_dir / rel)],
                check=True, capture_output=True, timeout=60,
            )
        except Exception as exc:
            log.warning("cover extraction failed: %s", exc)
            return None
    return rel if (out_dir / rel).is_file() else None


def chapter_of(chapters: list[dict], t: float) -> Optional[int]:
    """Index of the chapter containing time `t` (seconds), or None."""
    for ch in chapters:
        if ch["start"] <= t < ch["end"]:
            return ch["index"]
    return None


def chunk_bounds(duration: float, chunk_s: float, chapters: list[dict]) -> list[tuple[float, float]]:
    """Diarization chunks of at most ~`chunk_s`, cut at chapter boundaries when possible.

    Blind cuts can land mid-sentence and split one speaker's turn across two
    chunks. Chapter starts are natural scene breaks, so chunks are built by
    greedily packing whole chapters; a chapter longer than `chunk_s` is split
    into equal parts.
    """
    chunk_s = max(60.0, chunk_s)
    if not chapters:
        n = max(1, math.ceil(duration / chunk_s))
        step = duration / n
        return [(i * step, min(duration, (i + 1) * step)) for i in range(n)]
    cuts = sorted({0.0, duration, *[c["start"] for c in chapters if 0 < c["start"] < duration]})
    pieces = []
    for a, b in zip(cuts, cuts[1:]):
        k = max(1, math.ceil((b - a) / chunk_s))
        step = (b - a) / k
        pieces += [(a + i * step, a + (i + 1) * step) for i in range(k)]
    out: list[list[float]] = []
    for a, b in pieces:
        if out and b - out[-1][0] <= chunk_s:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [(round(a, 3), round(b, 3)) for a, b in out]


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Resample (samples,) or (samples, ch) audio. torchaudio when present, else linear."""
    if sr_in == sr_out:
        return x
    try:
        import torch
        import torchaudio.functional as AF
        t = torch.from_numpy(np.ascontiguousarray(x.T if x.ndim == 2 else x[None]))
        y = AF.resample(t, sr_in, sr_out).numpy()
        return y.T if x.ndim == 2 else y[0]
    except Exception:
        n = int(round(len(x) * sr_out / sr_in))
        src = np.linspace(0, len(x) - 1, n)
        if x.ndim == 1:
            return np.interp(src, np.arange(len(x)), x).astype(np.float32)
        return np.stack([np.interp(src, np.arange(len(x)), x[:, c]) for c in range(x.shape[1])], 1).astype(np.float32)


def to_mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=1) if x.ndim == 2 else x


def write_wav(path: Path, x: np.ndarray, sr: int) -> None:
    """24-bit PCM; the container follows the suffix (.wav clips, .flac stems)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 0.999:
        x = x * (0.999 / peak)
    sf.write(str(path), x, sr, subtype="PCM_24")


def rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    return 20 * math.log10(float(np.sqrt(np.mean(np.square(x)))) + 1e-9)


def db(ms: float) -> float:
    """Mean-square power → dBFS."""
    return 10 * math.log10(ms + 1e-12)


class Signal16:
    """Mono 16 kHz dialogue kept as int16 (2.3 GB for 20 h instead of 4.6).

    Slicing returns float32 in [-1, 1], so callers treat it like an array.
    """

    def __init__(self, capacity: int) -> None:
        self.a = np.zeros(max(capacity, 1), dtype=np.int16)
        self.n = 0

    def __len__(self) -> int:
        return self.n

    def __getitem__(self, s: slice) -> np.ndarray:
        return self.a[: self.n][s].astype(np.float32) / 32767.0

    def put(self, start: int, x: np.ndarray) -> None:
        end = start + len(x)
        if end > len(self.a):
            self.a = np.concatenate([self.a, np.zeros(end - len(self.a) + ML_SR * 60, np.int16)])
        self.a[start:end] = (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16)
        self.n = max(self.n, end)


def frame_power(x: np.ndarray, sr: int) -> np.ndarray:
    """Mean-square power per ENV_FRAME_S frame of mono-mixed `x`."""
    hop = int(round(ENV_FRAME_S * sr))
    m = to_mono(x).astype(np.float32)
    n = int(math.ceil(len(m) / hop))
    if n == 0:
        return np.zeros(0, np.float32)
    pad = np.zeros(n * hop, np.float32)
    pad[: len(m)] = m
    return np.mean(pad.reshape(n, hop) ** 2, axis=1).astype(np.float32)


class Envelope:
    """Per-stem loudness envelopes at ENV_FRAME_S resolution."""

    def __init__(self, frames: dict[str, np.ndarray]) -> None:
        self.frames = frames

    def power(self, stem: str, a: float, b: float) -> float:
        f = self.frames.get(stem)
        if f is None or len(f) == 0:
            return 0.0
        i, j = int(a / ENV_FRAME_S), max(int(math.ceil(b / ENV_FRAME_S)), int(a / ENV_FRAME_S) + 1)
        return float(np.mean(f[i:j])) if i < len(f) else 0.0

    def db(self, stem: str, a: float, b: float) -> float:
        return db(self.power(stem, a, b))


class StemReader:
    """Random access into the FLAC stems on disk (for clip export)."""

    def __init__(self, out_dir: Path, stem_paths: dict[str, str]) -> None:
        self.paths = {k: out_dir / v for k, v in stem_paths.items()}

    def read(self, stem: str, a: float, b: float) -> np.ndarray:
        with sf.SoundFile(str(self.paths[stem])) as f:
            sr = f.samplerate
            f.seek(max(0, int(a * sr)))
            return f.read(max(0, int((b - a) * sr)), dtype="float32", always_2d=True)


def stream_decode(path: str, sr: int, channels: int):
    """Yield consecutive float32 blocks of `path` from one ffmpeg process.

    A single continuous decode — no seeking — so window joins are sample-exact.
    """
    cmd = [
        "ffmpeg", "-nostdin", "-loglevel", "error", "-i", path,
        "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(sr), "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = 4 * channels

    def read(n_samples: int) -> np.ndarray:
        want = n_samples * frame_bytes
        chunks, got = [], 0
        while got < want:
            b = proc.stdout.read(want - got)
            if not b:
                break
            chunks.append(b)
            got += len(b)
        raw = b"".join(chunks)
        raw = raw[: len(raw) - len(raw) % frame_bytes]
        return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels)

    try:
        yield read
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass
        proc.kill()
        proc.wait()
        if proc.returncode not in (0, -9, None) and proc.stderr is not None:
            err = proc.stderr.read().decode(errors="replace")[-500:]
            if err.strip():
                log.warning("ffmpeg: %s", err)


def stream_stems(models: Optional["Models"], input_path: str, out_dir: Path, expected_s: Optional[float],
                 do_separate: bool, progress: ProgressFn) -> tuple[dict[str, str], Signal16, Envelope, float]:
    """Decode → (separate) → write FLAC stems, window by window.

    Each window is processed with CONTEXT_S of real audio either side and
    only its centre kept, so the separator never sees an artificial edge.
    Returns (stem paths, 16 kHz mono dialogue, envelopes, duration_s).
    """
    import contextlib

    win = int(WINDOW_S * SEP_SR)
    ctx = int(CONTEXT_S * SEP_SR)
    names = ["dialogue", "music", "effects"] if do_separate else ["dialogue"]
    (out_dir / "stems").mkdir(parents=True, exist_ok=True)
    stem_paths = {n: f"stems/{n}.flac" for n in names}
    mono16 = Signal16(int(((expected_s or 3600.0) + 5) * ML_SR))
    env: dict[str, list[np.ndarray]] = {n: [] for n in names}
    total_est = max(1.0, expected_s or 0.0)

    with contextlib.ExitStack() as stack:
        writers = {n: stack.enter_context(sf.SoundFile(str(out_dir / stem_paths[n]), "w", SEP_SR, 2,
                                                      subtype="PCM_24", format="FLAC")) for n in names}
        read = stack.enter_context(contextlib.contextmanager(stream_decode)(input_path, SEP_SR, 2))
        prev_tail = np.zeros((0, 2), np.float32)
        buf = read(win + ctx)
        pos = 0
        while len(buf):
            cur = min(win, len(buf))
            ctx_block = np.concatenate([prev_tail, buf]) if len(prev_tail) else buf
            k0, k1 = len(prev_tail), len(prev_tail) + cur
            done_s = pos / SEP_SR
            label = f"Separating dialogue, music and effects · {fmt_hms(done_s)} / {fmt_hms(total_est)}" \
                if do_separate else f"Reading audio · {fmt_hms(done_s)} / {fmt_hms(total_est)}"
            if do_separate:
                sub = lambda f, _m, d=done_s, c=cur: progress(min(1.0, (d + f * c / SEP_SR) / total_est), label)
                parts = separate(models, ctx_block, sub)
            else:
                progress(min(1.0, done_s / total_est), label)
                parts = {"dialogue": ctx_block}
            for n in names:
                seg = np.clip(parts[n][k0:k1], -0.999, 0.999)
                writers[n].write(seg)
                env[n].append(frame_power(seg, SEP_SR))
            dia = to_mono(parts["dialogue"][k0:k1])
            mono16.put(int(round(pos * ML_SR / SEP_SR)), resample(dia, SEP_SR, ML_SR).astype(np.float32))
            prev_tail = buf[max(0, cur - ctx):cur]
            lookahead = buf[cur:]
            buf = np.concatenate([lookahead, read(win)]) if len(lookahead) else read(win + ctx)
            pos += cur
    duration = pos / SEP_SR
    frames = {n: (np.concatenate(v) if v else np.zeros(0, np.float32)) for n, v in env.items()}
    return stem_paths, mono16, Envelope(frames), duration


def fmt_hms(s: float) -> str:
    s = int(max(0, s))
    return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


# ── Model registry ────────────────────────────────────────────────────────────

class Models:
    """Lazily loaded, process-resident models. Freed by `unload()`."""

    def __init__(self) -> None:
        self.separator = None
        self.separator_cfg = None
        self.diarizer = None
        self.embedder = None
        self.asr = None
        self.tagger = None  # dissect_sounds.Tagger, loaded on first use

    @staticmethod
    def ml_available() -> tuple[bool, str]:
        if os.environ.get("PHARAOH_DISSECT_STUB") == "1":
            return False, "stub mode forced by PHARAOH_DISSECT_STUB=1"
        try:
            import torch  # noqa: F401
            import nemo.collections.asr  # noqa: F401
        except Exception as exc:
            return False, f"NeMo not importable ({exc.__class__.__name__}: {exc})"
        return True, ""

    @staticmethod
    def separator_available() -> tuple[bool, str]:
        missing = [p for p in (MSST_DIR, SEPARATOR_CONFIG, SEPARATOR_WEIGHTS) if not p.exists()]
        if missing:
            return False, "separator files missing: " + ", ".join(str(p) for p in missing)
        return True, ""

    @property
    def device(self) -> str:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"

    def load_separator(self):
        if self.separator is not None:
            return self.separator
        import torch
        import yaml
        from ml_collections import ConfigDict

        # MSST's `models.bandit.core` package __init__ pulls in its training
        # stack (asteroid, lightning, pyloudnorm...). Registering a bare package
        # object lets the model submodules import without executing it.
        root = str(MSST_DIR)
        if root not in sys.path:
            sys.path.insert(0, root)
        pkg = "models.bandit.core"
        if pkg not in sys.modules:
            mod = types.ModuleType(pkg)
            mod.__path__ = [os.path.join(root, *pkg.split("."))]
            sys.modules[pkg] = mod
        from models.bandit.core.model import MultiMaskMultiSourceBandSplitRNNSimple

        cfg = ConfigDict(yaml.load(SEPARATOR_CONFIG.read_text(), Loader=yaml.FullLoader))
        model = MultiMaskMultiSourceBandSplitRNNSimple(**cfg.model)
        state = torch.load(str(SEPARATOR_WEIGHTS), map_location="cpu", weights_only=False)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        model.load_state_dict(state)
        self.separator = model.to(self.device).eval()
        self.separator_cfg = cfg
        return self.separator

    def load_diarizer(self):
        if self.diarizer is None:
            from nemo.collections.asr.models import SortformerEncLabelModel
            d = SortformerEncLabelModel.from_pretrained(DIARIZER_ID, map_location=self.device).eval()
            # 30.4 s offline-style buffer (values in 80 ms frames), per the model card.
            m = d.sortformer_modules
            m.spkcache_len = 264
            m.fifo_len = 40
            m.chunk_len = 340
            m.chunk_right_context = 40
            m.spkcache_update_period = 300
            d._check_streaming_parameters()
            self.diarizer = d
        return self.diarizer

    def load_embedder(self):
        if self.embedder is None:
            from nemo.collections.asr.models import EncDecSpeakerLabelModel
            self.embedder = EncDecSpeakerLabelModel.from_pretrained(EMBEDDER_ID, map_location=self.device).eval()
        return self.embedder

    def load_asr(self):
        if self.asr is None:
            from nemo.collections.asr.models import ASRModel
            self.asr = ASRModel.from_pretrained(ASR_ID, map_location=self.device).eval()
        return self.asr

    def loaded(self) -> list[str]:
        return [n for n in ("separator", "diarizer", "embedder", "asr", "tagger") if getattr(self, n) is not None]

    def unload(self) -> None:
        self.separator = self.separator_cfg = self.diarizer = self.embedder = self.asr = self.tagger = None
        try:
            import gc
            import torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


# ── Stage 1: separation ───────────────────────────────────────────────────────

def separate(models: Models, mix: np.ndarray, progress: ProgressFn) -> dict[str, np.ndarray]:
    """Overlap-add BandIt Plus over (samples, 2) audio at 44.1 kHz.

    Returns {"dialogue", "music", "effects"} arrays of the same shape.
    """
    import torch

    model = models.load_separator()
    cfg = models.separator_cfg
    stems = list(cfg.model.stems)  # ['speech', 'music', 'effects']
    chunk = int(cfg.audio.chunk_size)
    step = chunk // 2
    batch = 4
    device = models.device

    n = mix.shape[0]
    pad_front = step
    total = pad_front + n
    n_chunks = max(1, math.ceil((total - chunk) / step) + 1) if total > chunk else 1
    padded_len = (n_chunks - 1) * step + chunk
    x = np.zeros((padded_len, 2), dtype=np.float32)
    x[pad_front:pad_front + n] = mix

    # Accumulate on the CPU: an hour of 3-stem stereo is ~4 GB, which would
    # crowd the GPU for no speed benefit.
    window = np.hanning(chunk + 1)[:chunk].astype(np.float32)
    out = np.zeros((len(stems), 2, padded_len), dtype=np.float32)
    norm = np.zeros(padded_len, dtype=np.float32)
    xt = x.T.copy()

    starts = [i * step for i in range(n_chunks)]
    with torch.inference_mode(), torch.autocast(device_type="cuda", enabled=device == "cuda"):
        for b in range(0, len(starts), batch):
            group = starts[b:b + batch]
            seg = torch.from_numpy(np.stack([xt[:, s:s + chunk] for s in group])).to(device)
            y = model(seg).float().cpu().numpy()  # (B, stems, 2, T)
            for k, s in enumerate(group):
                out[:, :, s:s + chunk] += y[k] * window
                norm[s:s + chunk] += window
            progress(min(1.0, (b + len(group)) / len(starts)), "Separating dialogue, music and effects")

    out /= np.maximum(norm, 1e-4)
    res = out[:, :, pad_front:pad_front + n]
    names = {"speech": "dialogue", "music": "music", "effects": "effects"}
    return {names.get(s, s): res[i].T for i, s in enumerate(stems)}


# ── Stage 2: diarization ──────────────────────────────────────────────────────

def _parse_segment(seg) -> tuple[float, float, str]:
    if isinstance(seg, str):
        a, b, spk = seg.split()
        return float(a), float(b), spk
    a, b, spk = seg[:3]
    return float(a), float(b), str(spk)


def diarize(models: Models, mono16: np.ndarray, opts: DissectOptions, workdir: Path,
            progress: ProgressFn, chapters: Optional[list[dict]] = None) -> list[Turn]:
    """Diarize in chunks; speaker labels are chunk-local ("c0:speaker_1")."""
    diar = models.load_diarizer()
    bounds = chunk_bounds(len(mono16) / ML_SR, opts.chunk_minutes * 60, chapters or [])
    turns: list[Turn] = []
    n_chunks = len(bounds)
    for ci, (a, b) in enumerate(bounds):
        offset = int(a * ML_SR)
        piece = mono16[offset:int(b * ML_SR)]
        if len(piece) < ML_SR:
            continue
        path = workdir / f"diar_{ci}.wav"
        sf.write(str(path), piece, ML_SR)
        segs = diar.diarize(audio=[str(path)], batch_size=1, verbose=False)[0]
        for seg in segs:
            a, b, spk = _parse_segment(seg)
            turns.append(Turn(speaker=f"c{ci}:{spk}", start=a + offset / ML_SR, end=b + offset / ML_SR))
        progress((ci + 1) / n_chunks, "Finding who speaks when")
    turns.sort(key=lambda t: t.start)
    return turns


def mark_overlaps(turns: list[Turn]) -> None:
    for i, t in enumerate(turns):
        for j in range(i + 1, len(turns)):
            u = turns[j]
            if u.start >= t.end:
                break
            if u.speaker != t.speaker:
                t.overlap = u.overlap = True


def solo_intervals(turns: list[Turn], speaker: str) -> list[tuple[float, float]]:
    """Spans where `speaker` talks and nobody else does.

    Other speakers' turns are start-sorted and searched with bisect, so this is
    ~O(n log n) — a 20 h book has tens of thousands of turns.
    """
    others = sorted((t.start, t.end) for t in turns if t.speaker != speaker)
    starts = [a for a, _ in others]
    longest = max((b - a for a, b in others), default=0.0)
    out: list[tuple[float, float]] = []
    for t in turns:
        if t.speaker != speaker:
            continue
        pieces = [(t.start, t.end)]
        lo = bisect.bisect_left(starts, t.start - longest)
        hi = bisect.bisect_left(starts, t.end)
        for a, b in others[lo:hi]:
            if b <= t.start or a >= t.end:
                continue
            nxt = []
            for s_, e in pieces:
                if b <= s_ or a >= e:
                    nxt.append((s_, e))
                    continue
                if a > s_:
                    nxt.append((s_, a))
                if b < e:
                    nxt.append((b, e))
            pieces = nxt
        out.extend(p for p in pieces if p[1] - p[0] > 0.3)
    return sorted(out)


# ── Stage 3: speaker linking ──────────────────────────────────────────────────

def _embed(models: Models, audio16: np.ndarray) -> Optional[np.ndarray]:
    if len(audio16) < ML_SR // 2:
        return None
    emb, _ = models.load_embedder().infer_segment(audio16)
    v = emb.detach().float().cpu().numpy().reshape(-1)
    return v / (np.linalg.norm(v) + 1e-9)


def speaker_centroids(models: Models, turns: list[Turn], mono16: np.ndarray,
                      max_seconds: float = 60.0) -> dict[str, np.ndarray]:
    """Duration-weighted mean embedding of each speaker's longest solo spans."""
    out: dict[str, np.ndarray] = {}
    for spk in sorted({t.speaker for t in turns}):
        spans = sorted(solo_intervals(turns, spk), key=lambda s: s[0] - s[1])
        acc, used = None, 0.0
        for a, b in spans:
            if used >= max_seconds or b - a < 1.0:
                break
            b = min(b, a + 10.0)
            v = _embed(models, mono16[int(a * ML_SR):int(b * ML_SR)])
            if v is None:
                continue
            acc = v * (b - a) if acc is None else acc + v * (b - a)
            used += b - a
        if acc is not None:
            out[spk] = acc / (np.linalg.norm(acc) + 1e-9)
    return out


def link_speakers(centroids: dict[str, np.ndarray], threshold: float) -> dict[str, str]:
    """Average-linkage merge of chunk-local speakers into global ones.

    Two speakers from the same chunk are never merged: the diarizer saw them
    side by side and already decided they differ, which beats the embedder.
    Vectorised (cluster-similarity matrix updated in place): a long book has
    hundreds of chunk-local speakers, and the pairwise-mean version was cubic.
    """
    keys = list(centroids)
    n = len(keys)
    mapping: dict[str, str] = {}
    if n == 0:
        return mapping
    E = np.stack([centroids[k] for k in keys]).astype(np.float64)
    S = E @ E.T
    chunk_ids = {c: i for i, c in enumerate(sorted({k.split(":", 1)[0] for k in keys}))}
    conflict = np.zeros((n, len(chunk_ids)), dtype=bool)
    for i, k in enumerate(keys):
        conflict[i, chunk_ids[k.split(":", 1)[0]]] = True
    size = np.ones(n)
    alive = np.ones(n, dtype=bool)
    members: list[list[int]] = [[i] for i in range(n)]

    def blocked() -> np.ndarray:
        return (conflict.astype(np.int32) @ conflict.T.astype(np.int32)) > 0

    B = blocked()
    while True:
        M = np.where(B | ~alive[:, None] | ~alive[None, :], -np.inf, S)
        np.fill_diagonal(M, -np.inf)
        i, j = np.unravel_index(int(np.argmax(M)), M.shape)
        if not np.isfinite(M[i, j]) or M[i, j] <= threshold:
            break
        # Merge j into i: average linkage by size-weighted rows.
        S[i, :] = (size[i] * S[i, :] + size[j] * S[j, :]) / (size[i] + size[j])
        S[:, i] = S[i, :]
        size[i] += size[j]
        conflict[i] |= conflict[j]
        alive[j] = False
        members[i] += members[j]
        members[j] = []
        row = (conflict.astype(np.int32) @ conflict[i].astype(np.int32)) > 0
        B[i, :] = row
        B[:, i] = row

    for k, group in enumerate(g for g in members if g):
        for m in group:
            mapping[keys[m]] = f"tmp{k}"
    return mapping


# ── Stage 4: transcription ────────────────────────────────────────────────────

def transcribe_turns(models: Models, turns: list[Turn], mono16: np.ndarray,
                     progress: ProgressFn, max_turn_s: float = 30.0) -> None:
    """Fill `text` and absolute-time `words` on every turn."""
    asr = models.load_asr()
    # Spans only — audio is sliced per batch. Materialising every turn's audio
    # up front cost ~4.6 GB on a 20 h book.
    jobs: list[tuple[Turn, float, float]] = []
    for t in turns:
        a = t.start
        while a < t.end - 0.2:
            b = min(t.end, a + max_turn_s)
            jobs.append((t, a, b))
            a = b
    batch = 16
    for i in range(0, len(jobs), batch):
        group = jobs[i:i + batch]
        audio = [mono16[int(a * ML_SR):int(b * ML_SR)] for _, a, b in group]
        hyps = asr.transcribe(audio, batch_size=batch, timestamps=True, verbose=False)
        for (turn, offset, _), h in zip(group, hyps):
            text = (h.text or "").strip()
            if text:
                turn.text = (turn.text + " " + text).strip()
            for w in (h.timestamp or {}).get("word", []) or []:
                turn.words.append({
                    "word": w["word"],
                    "start": round(offset + float(w["start"]), 3),
                    "end": round(offset + float(w["end"]), 3),
                })
        progress(min(1.0, (i + len(group)) / max(1, len(jobs))), "Transcribing lines")


# ── Stage 5: reference candidates ─────────────────────────────────────────────

class WordIndex:
    """Per-speaker words sorted by start, for bisect range lookups."""

    def __init__(self, turns: list[Turn]) -> None:
        self.words: dict[str, list[dict]] = {}
        for t in turns:
            self.words.setdefault(t.speaker, []).extend(t.words)
        self.starts: dict[str, list[float]] = {}
        for spk, ws in self.words.items():
            ws.sort(key=lambda w: w["start"])
            self.starts[spk] = [w["start"] for w in ws]

    def within(self, speaker: str, a: float, b: float) -> list[dict]:
        ws, st = self.words.get(speaker, []), self.starts.get(speaker, [])
        lo = bisect.bisect_left(st, a - 0.05)
        hi = bisect.bisect_right(st, b + 0.05)
        return [w for w in ws[lo:hi] if w["end"] <= b + 0.05]


def _windows(span: tuple[float, float], words: list[dict], opts: DissectOptions) -> list[tuple[float, float]]:
    """Cut a solo span into clip windows, preferring cuts in the gaps between words."""
    a, b = span
    if b - a < opts.min_clip_s:
        return []
    if b - a <= opts.max_clip_s:
        return [(a, b)]
    target = min(opts.max_clip_s, max(opts.min_clip_s, 10.0))
    gaps = [(words[k]["end"] + words[k + 1]["start"]) / 2
            for k in range(len(words) - 1) if words[k + 1]["start"] - words[k]["end"] >= 0.12]
    out, cur = [], a
    while b - cur >= opts.min_clip_s:
        want = cur + target
        if b - cur <= opts.max_clip_s:
            out.append((cur, b))
            break
        cands = [g for g in gaps if cur + opts.min_clip_s <= g <= cur + opts.max_clip_s]
        cut = min(cands, key=lambda g: abs(g - want)) if cands else want
        out.append((cur, cut))
        cur = cut
    return out


def pick_candidates(models: Optional[Models], turns: list[Turn], speaker: str,
                    env: Envelope, separated: bool, mono16, words: WordIndex,
                    centroid: Optional[np.ndarray], opts: DissectOptions) -> list[dict]:
    """Rank a speaker's solo windows as clone references; scoring reads the
    loudness envelopes, so no audio is touched until the winners are exported."""
    scored = []
    for span in solo_intervals(turns, speaker):
        words_all = words.within(speaker, *span)
        for a, b in _windows(span, words_all, opts):
            # Trim to the spoken words, with a little air either side.
            ws = [w for w in words_all if w["start"] >= a - 0.05 and w["end"] <= b + 0.05]
            if ws:
                a = max(a, ws[0]["start"] - 0.15)
                b = min(b, ws[-1]["end"] + 0.25)
            d = b - a
            if d < opts.min_clip_s or d > opts.max_clip_s:
                continue
            level = env.db("dialogue", a, b)
            if level < -45:
                continue
            bleed_db = None
            if separated:
                # Capped: on a dry source the music/effects stems are near
                # silence and the raw ratio runs past 100 dB — meaningless detail.
                bed = env.power("music", a, b) + env.power("effects", a, b)
                bleed_db = min(BLEED_CAP_DB, level - db(bed))
            wps = len(ws) / d if ws else 0.0
            score = 1.0 - min(1.0, abs(d - 8.0) / 8.0)
            if bleed_db is not None:
                score += max(-1.0, min(1.0, (bleed_db - 10.0) / 15.0))
            if opts.transcribe:
                score += 0.5 if 1.0 <= wps <= 4.5 else -0.5
            scored.append({
                "start": round(a, 3), "end": round(b, 3), "duration": round(d, 3),
                "transcript": " ".join(w["word"] for w in ws),
                "level_db": round(level, 1),
                "bleed_db": None if bleed_db is None else round(bleed_db, 1),
                "score": score,
            })

    scored.sort(key=lambda c: -c["score"])
    # Voice-consistency check on the front-runners: a clip that doesn't sound
    # like the speaker's centroid is probably a diarization slip.
    if models is not None and centroid is not None:
        for c in scored[: opts.max_candidates * 3]:
            v = _embed(models, mono16[int(c["start"] * ML_SR):int(c["end"] * ML_SR)])
            c["similarity"] = None if v is None else round(float(v @ centroid), 3)
            if c["similarity"] is not None:
                c["score"] += 2.0 * (c["similarity"] - 0.5)
        scored.sort(key=lambda c: -c["score"])

    picked: list[dict] = []
    for c in scored:
        if len(picked) >= opts.max_candidates:
            break
        if any(c["start"] < p["end"] and p["start"] < c["end"] for p in picked):
            continue
        picked.append(c)
    for c in picked:
        c["score"] = round(c["score"], 3)
        c.setdefault("similarity", None)
    return picked


def export_clip(reader: StemReader, stem: str, a: float, b: float, path: Path) -> None:
    seg = to_mono(reader.read(stem, a, b)).astype(np.float32)
    seg = resample(seg, SEP_SR, CLIP_SR)
    fade = int(0.012 * CLIP_SR)
    if len(seg) > 2 * fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        seg[:fade] *= ramp
        seg[-fade:] *= ramp[::-1]
    # Level to roughly -20 dBFS RMS so auditions compare fairly.
    gain = 10 ** ((-20.0 - rms_db(seg)) / 20)
    write_wav(path, seg * min(gain, 10.0), CLIP_SR)


# ── Cast credits ─────────────────────────────────────────────────────────────

# "Matthew Cuthbert, read by Bruce Perry." / "Station Master played by X" — the
# dramatis personae of a LibriVox reading, or a podcast's end credits. "red" is
# a common ASR slip for "read".
_CREDIT_RE = re.compile(
    r"(?P<char>[A-Z][\w.'’\- ]{1,50}?)[,.:]?\s+(?i:is\s+)?(?i:read|red|played|voiced|performed)\s+(?i:by)\s+"
    r"(?P<who>[A-Z][\w.'’\- ]{0,50}?)\s*(?:[.,;]|$)",
)
_CREDIT_SKIP = re.compile(r"^(?:and|this|end|dramatis|dramatus)\b", re.I)


def find_credits(turns: list[dict], join_gap_s: float = 2.5) -> dict[str, list[dict]]:
    """Cast credits heard in each speaker's own voice.

    Consecutive turns by the same speaker are joined first because a credit is
    often split across a pause ("Marilla Cuthbert" … "Read by Elizabeth").
    Returns {speaker_id: [{character, performer, at}]}, deduplicated per
    character. These are suggestions — diarization of rapid-fire credit lists
    is the least reliable part of a recording.
    """
    blocks: list[dict] = []
    for t in sorted(turns, key=lambda t: t["start"]):
        text = (t.get("text") or "").strip()
        if not text:
            continue
        if blocks and blocks[-1]["speaker"] == t["speaker"] and t["start"] - blocks[-1]["end"] <= join_gap_s:
            blocks[-1]["text"] += " " + text
            blocks[-1]["end"] = t["end"]
        else:
            blocks.append({"speaker": t["speaker"], "start": t["start"], "end": t["end"], "text": text})

    out: dict[str, list[dict]] = {}
    for b in blocks:
        for m in _CREDIT_RE.finditer(b["text"]):
            char = m.group("char").strip(" .,")
            who = m.group("who").strip(" .,")
            # Drop a leading clause the regex swallowed: "...personae. Anne" → "Anne".
            char = re.split(r"[.!?]\s+", char)[-1]
            if not char or not who or _CREDIT_SKIP.match(char) or len(char.split()) > 6:
                continue
            seen = out.setdefault(b["speaker"], [])
            if any(c["character"].lower() == char.lower() for c in seen):
                continue
            seen.append({"character": char, "performer": who, "at": round(b["start"], 2)})
    return out


# ── Stub path ─────────────────────────────────────────────────────────────────

def stub_turns(env: Envelope) -> list[Turn]:
    """Energy-gated segmentation from the dialogue envelope, speakers
    alternating per pause. UI plumbing only."""
    p = env.frames.get("dialogue", np.zeros(0))
    if len(p) == 0:
        return []
    # Envelope frames → 0.1 s steps (the gate's original resolution).
    k = max(1, int(round(0.1 / ENV_FRAME_S)))
    n = len(p) // k
    frames = [db(float(x)) for x in p[: n * k].reshape(n, k).mean(axis=1)] if n else []
    thresh = (np.percentile(frames, 60) if frames else -40) - 6
    turns, start, quiet, spk = [], None, 0, 0
    for i, level in enumerate(frames + [-120.0] * 6):
        t = i * 0.1
        if level > thresh:
            start = t if start is None else start
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet >= 6:
                if t - start > 1.0:
                    turns.append(Turn(speaker=f"c0:speaker_{spk % 3}", start=start, end=t - 0.6))
                    spk += 1
                start, quiet = None, 0
    return turns


# ── Orchestration ─────────────────────────────────────────────────────────────

def run(models: Models, input_path: str, out_dir: Path, opts: DissectOptions,
        progress: ProgressFn) -> dict:
    """Run the full pipeline and write `out_dir/manifest.json`. Returns the manifest.

    Memory is bounded by the window size plus the 16 kHz int16 dialogue
    (~115 MB per hour), not by the source length.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    ml_ok, ml_reason = models.ml_available()
    sep_ok, sep_reason = models.separator_available() if ml_ok else (False, ml_reason)
    stub = not ml_ok
    warnings: list[str] = []
    if stub:
        warnings.append(f"Stub mode: {ml_reason}. Speakers and transcripts are placeholders.")

    def stage(lo: float, hi: float) -> ProgressFn:
        return lambda f, msg: progress(lo + (hi - lo) * max(0.0, min(1.0, f)), msg)

    progress(0.01, "Reading source")
    container = probe_container(input_path)
    chapters = container["chapters"]
    cover = None
    if container["cover_stream"] is not None:
        cover = extract_cover(input_path, container["cover_stream"], container["cover_codec"], out_dir)

    do_separate = bool(opts.separate and ml_ok and sep_ok)
    if opts.separate and ml_ok and not sep_ok:
        warnings.append(f"Separation skipped: {sep_reason}")
    stem_paths, mono16, env, duration = stream_stems(
        models if do_separate else None, input_path, out_dir, container["duration"],
        do_separate, stage(0.02, 0.35),
    )
    if duration < 1.0:
        raise ValueError("source audio is shorter than one second")
    reader = StemReader(out_dir, stem_paths)

    tmp = Path(tempfile.mkdtemp(prefix="pharaoh-dissect-"))
    try:
        if stub:
            turns = stub_turns(env)
            centroids: dict[str, np.ndarray] = {}
            mapping = {s: s for s in {t.speaker for t in turns}}
        else:
            turns = diarize(models, mono16, opts, tmp, stage(0.35, 0.5), chapters)
            progress(0.51, "Matching voices across the recording")
            centroids = speaker_centroids(models, turns, mono16)
            mapping = link_speakers(centroids, opts.link_threshold)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # Re-key turns and centroids onto global speakers.
    for t in turns:
        t.speaker = mapping.get(t.speaker, t.speaker)
    merged: dict[str, list[np.ndarray]] = {}
    for local, v in centroids.items():
        merged.setdefault(mapping.get(local, local), []).append(v)
    global_centroids = {k: (np.mean(v, 0) / (np.linalg.norm(np.mean(v, 0)) + 1e-9)) for k, v in merged.items()}
    turns.sort(key=lambda t: t.start)
    mark_overlaps(turns)

    if opts.transcribe and not stub:
        transcribe_turns(models, turns, mono16, stage(0.53, 0.8))
    words = WordIndex(turns)

    # Stable, human-facing speaker ids: most speech first (usually the narrator).
    talk: dict[str, float] = {}
    for t in turns:
        talk[t.speaker] = talk.get(t.speaker, 0.0) + (t.end - t.start)
    order = sorted(talk, key=lambda s: -talk[s])
    final_id = {s: f"S{i + 1}" for i, s in enumerate(order)}
    by_speaker: dict[str, list[Turn]] = {}
    for t in turns:
        by_speaker.setdefault(t.speaker, []).append(t)

    speakers = []
    for i, spk in enumerate(order):
        progress(0.8 + 0.08 * i / max(1, len(order)), "Choosing reference clips")
        cands = pick_candidates(None if stub else models, turns, spk, env, do_separate, mono16, words,
                                global_centroids.get(spk), opts)
        sid = final_id[spk]
        for k, c in enumerate(cands, 1):
            c["id"] = f"{sid}_c{k}"
            c["chapter"] = chapter_of(chapters, c["start"])
            c["path"] = f"candidates/{c['id']}.wav"
            export_clip(reader, "dialogue", c["start"], c["end"], out_dir / c["path"])
        own = by_speaker[spk]
        sample = next((t.text for t in sorted(own, key=lambda t: t.start - t.end) if t.text), "")
        speakers.append({
            "id": sid,
            "label": f"Speaker {i + 1}",
            "total_speech_s": round(talk[spk], 2),
            "turn_count": len(own),
            "first_heard_s": round(min(t.start for t in own), 2),
            "sample_text": sample[:240],
            # Chapters this voice appears in — "the narrator is in all 12".
            "chapters": sorted({ci for t in own if (ci := chapter_of(chapters, t.start)) is not None}),
            "candidates": cands,
        })

    turn_rows = [
        {"speaker": final_id[t.speaker], "start": round(t.start, 3), "end": round(t.end, 3),
         "text": t.text, "overlap": t.overlap, "chapter": chapter_of(chapters, t.start)}
        for t in turns
    ]
    credits = find_credits(turn_rows)
    for sp in speakers:
        sp["credits"] = credits.get(sp["id"], [])

    sounds: dict = {"sfx": [], "vocal": [], "ambience": [], "music": []}
    if do_separate:
        from dissect_sounds import find_sounds
        sounds = find_sounds(env, reader, chapters, models, stage(0.88, 0.99))

    # Word timings are the bulk of a long transcript; keep them out of the
    # manifest the UI loads, next to it for later use (scene import).
    (out_dir / "transcript.json").write_text(json.dumps([
        {"speaker": final_id[t.speaker], "start": round(t.start, 3), "end": round(t.end, 3), "words": t.words}
        for t in turns
    ]))

    manifest = {
        "version": MANIFEST_VERSION,
        "source_path": input_path,
        "source_name": Path(input_path).name,
        "duration_s": round(duration, 3),
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "stub": stub,
        "separated": do_separate,
        "models": {
            "separation": SEPARATOR_ID if do_separate else None,
            "diarization": None if stub else DIARIZER_ID,
            "embedding": None if stub else EMBEDDER_ID,
            "asr": ASR_ID if (opts.transcribe and not stub) else None,
            "tagging": sounds.get("tagger"),
        },
        "options": opts.__dict__,
        "warnings": warnings + sounds.get("warnings", []),
        "stems": stem_paths,
        "chapters": chapters,
        "source_tags": container["tags"],
        "cover": cover,
        "speakers": speakers,
        "sounds": {k: sounds.get(k, []) for k in ("sfx", "vocal", "ambience", "music")},
        "transcript": "transcript.json",
        "turns": turn_rows,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    progress(1.0, "Done")
    return manifest


# ── Setup helpers (called by setup.sh) ───────────────────────────────────────

def prefetch() -> None:
    """Download the NeMo checkpoints into the Hugging Face cache NeMo reads.

    Only the .nemo files — the model repos also carry demo videos and GIFs.
    """
    from huggingface_hub import snapshot_download
    for repo in (DIARIZER_ID, EMBEDDER_ID, ASR_ID):
        path = snapshot_download(repo, allow_patterns=["*.nemo"])
        print(f"  ✓ {repo} → {path}", flush=True)
    # AudioSet tagger for sound-effect / music labels (dissect_sounds.py).
    tagger = "MIT/ast-finetuned-audioset-10-10-0.4593"
    path = snapshot_download(tagger, allow_patterns=["*.json", "*.safetensors"])
    print(f"  ✓ {tagger} → {path}", flush=True)


def check(deep: bool = True) -> bool:
    """Report whether this environment can run a real (non-stub) dissect.

    `deep` instantiates the diarizer on CPU — the model whose RoPE encoder
    needs NeMo newer than the 3.0.0 wheel, i.e. the likeliest thing to break.
    """
    ok = True
    ml_ok, reason = Models.ml_available()
    print(f"  {'✓' if ml_ok else '✗'} NeMo / torch importable{'' if ml_ok else f' — {reason}'}")
    ok &= ml_ok
    sep_ok, sep_reason = Models.separator_available()
    print(f"  {'✓' if sep_ok else '✗'} separator code + weights{'' if sep_ok else f' — {sep_reason}'}")
    ok &= sep_ok
    for tool in ("ffmpeg", "ffprobe"):
        found = shutil.which(tool) is not None
        print(f"  {'✓' if found else '✗'} {tool} on PATH")
        ok &= found
    if ml_ok:
        import torch
        cuda = torch.cuda.is_available()
        name = torch.cuda.get_device_name(0) if cuda else "none"
        print(f"  {'✓' if cuda else '!'} CUDA: {name}{'' if cuda else ' (CPU-only will be very slow)'}")
    if ml_ok and deep:
        try:
            from nemo.utils import logging as nemo_logging
            nemo_logging.setLevel(logging.ERROR)  # it prints the whole training config
            from nemo.collections.asr.models import SortformerEncLabelModel
            SortformerEncLabelModel.from_pretrained(DIARIZER_ID, map_location="cpu")
            print("  ✓ diarizer loads (NeMo supports its encoder)")
        except Exception as exc:
            print(f"  ✗ diarizer failed to load — {exc.__class__.__name__}: {str(exc)[:200]}")
            ok = False
    return ok


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Dissect pipeline setup helpers")
    ap.add_argument("--prefetch", action="store_true", help="download the NeMo checkpoints")
    ap.add_argument("--check", action="store_true", help="verify this environment")
    ap.add_argument("--quick", action="store_true", help="with --check: skip loading the diarizer")
    a = ap.parse_args()
    if not (a.prefetch or a.check):
        ap.error("pass --prefetch and/or --check")
    logging.basicConfig(level=logging.ERROR)
    if a.prefetch:
        prefetch()
    if a.check and not check(deep=not a.quick):
        sys.exit(1)
