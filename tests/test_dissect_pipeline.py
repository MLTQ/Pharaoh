"""
Tests for inference/dissect_pipeline.py — the pure parts that decide which
clips a character gets cloned from, plus a stub-mode run of the whole
pipeline (no GPU, no NeMo) to pin the manifest shape the Rust side reads.
"""
import json
import shutil
import subprocess

import numpy as np
import pytest

dp = pytest.importorskip("dissect_pipeline")
from dissect_pipeline import DissectOptions, Turn  # noqa: E402


class TestSoloIntervals:
    def test_overlap_is_carved_out(self):
        turns = [Turn("A", 0.0, 10.0), Turn("B", 4.0, 6.0)]
        assert dp.solo_intervals(turns, "A") == [(0.0, 4.0), (6.0, 10.0)]

    def test_fully_covered_turn_has_no_solo_span(self):
        turns = [Turn("A", 2.0, 3.0), Turn("B", 0.0, 10.0)]
        assert dp.solo_intervals(turns, "A") == []

    def test_slivers_are_dropped(self):
        turns = [Turn("A", 0.0, 5.0), Turn("B", 0.2, 5.0)]
        assert dp.solo_intervals(turns, "A") == []

    def test_mark_overlaps_flags_both_sides(self):
        turns = [Turn("A", 0.0, 5.0), Turn("B", 4.0, 8.0), Turn("A", 9.0, 10.0)]
        dp.mark_overlaps(turns)
        assert [t.overlap for t in turns] == [True, True, False]


class TestLinkSpeakers:
    @staticmethod
    def _unit(v):
        v = np.asarray(v, dtype=np.float32)
        return v / np.linalg.norm(v)

    def test_same_voice_across_chunks_merges(self):
        c = {
            "c0:speaker_0": self._unit([1, 0, 0]),
            "c1:speaker_1": self._unit([0.95, 0.05, 0]),
            "c1:speaker_0": self._unit([0, 1, 0]),
        }
        m = dp.link_speakers(c, threshold=0.6)
        assert m["c0:speaker_0"] == m["c1:speaker_1"]
        assert m["c1:speaker_0"] != m["c0:speaker_0"]

    def test_speakers_from_one_chunk_never_merge(self):
        # Identical embeddings, but the diarizer separated them in one pass.
        c = {"c0:speaker_0": self._unit([1, 0]), "c0:speaker_1": self._unit([1, 0])}
        m = dp.link_speakers(c, threshold=0.6)
        assert m["c0:speaker_0"] != m["c0:speaker_1"]


class TestWindows:
    def test_short_span_is_skipped(self):
        assert dp._windows((0.0, 2.0), [], DissectOptions()) == []

    def test_span_within_bounds_is_one_clip(self):
        assert dp._windows((1.0, 9.0), [], DissectOptions()) == [(1.0, 9.0)]

    def test_long_span_cuts_in_word_gaps(self):
        # Words every 0.5 s with a 0.3 s gap after each; span 0–30 s.
        words = [{"word": "w", "start": i * 0.5, "end": i * 0.5 + 0.2} for i in range(60)]
        wins = dp._windows((0.0, 30.0), words, DissectOptions())
        opts = DissectOptions()
        assert len(wins) >= 2
        for a, b in wins:
            assert opts.min_clip_s <= b - a <= opts.max_clip_s
        # Every interior cut lands in a gap between words, not mid-word.
        for a, _ in wins[1:]:
            assert not any(w["start"] < a < w["end"] for w in words)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required to decode")
def test_stub_run_writes_relocatable_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARAOH_DISSECT_STUB", "1")
    src = tmp_path / "drama.wav"
    # 3 × (5 s tone burst, 1.5 s silence): three "turns" for the stub segmenter.
    sr = 16000
    burst = 0.3 * np.sin(2 * np.pi * 220 * np.arange(5 * sr) / sr)
    gap = np.zeros(int(1.5 * sr))
    audio = np.concatenate([gap, burst, gap, burst, gap, burst, gap]).astype(np.float32)
    import soundfile as sf
    sf.write(str(src), audio, sr)

    out = tmp_path / "import"
    progress = []
    manifest = dp.run(dp.Models(), str(src), out, DissectOptions(), lambda f, m: progress.append(f))

    assert manifest["stub"] is True
    assert manifest["warnings"] and "Stub mode" in manifest["warnings"][0]
    assert progress[-1] == 1.0
    assert manifest["stems"] == {"dialogue": "stems/dialogue.wav"}
    on_disk = json.loads((out / "manifest.json").read_text())
    assert on_disk["speakers"] == manifest["speakers"]
    assert manifest["speakers"], "stub segmenter should find the tone bursts"
    for sp in manifest["speakers"]:
        assert sp["id"].startswith("S")
        for c in sp["candidates"]:
            # Paths are relative to the import dir, and the files exist there.
            assert not c["path"].startswith("/")
            assert (out / c["path"]).is_file()
            info = sf.info(str(out / c["path"]))
            assert info.samplerate == dp.CLIP_SR
            assert 3.0 <= c["duration"] <= 15.0


class TestChunkBounds:
    def test_no_chapters_splits_evenly(self):
        b = dp.chunk_bounds(3000.0, 1200.0, [])
        assert len(b) == 3 and b[0][0] == 0.0 and b[-1][1] == 3000.0
        assert all(y - x <= 1200.0 + 1e-6 for x, y in b)

    def test_cuts_land_on_chapter_starts(self):
        # Five 7-minute chapters, 20-minute chunks → pack two chapters per chunk.
        chapters = [{"index": i, "title": f"c{i}", "start": i * 420.0, "end": (i + 1) * 420.0} for i in range(5)]
        b = dp.chunk_bounds(2100.0, 1200.0, chapters)
        starts = {c["start"] for c in chapters}
        assert [x for x, _ in b] == [0.0, 840.0, 1680.0]
        assert all(x in starts for x, _ in b)
        assert b[-1][1] == 2100.0

    def test_overlong_chapter_is_split(self):
        chapters = [{"index": 0, "title": "all", "start": 0.0, "end": 3000.0}]
        b = dp.chunk_bounds(3000.0, 1200.0, chapters)
        assert len(b) == 3 and all(y - x <= 1200.0 + 1e-6 for x, y in b)

    def test_chapter_of(self):
        chapters = [{"index": 0, "title": "a", "start": 0.0, "end": 5.0},
                    {"index": 1, "title": "b", "start": 5.0, "end": 9.0}]
        assert dp.chapter_of(chapters, 4.99) == 0
        assert dp.chapter_of(chapters, 5.0) == 1
        assert dp.chapter_of(chapters, 9.5) is None


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_stub_run_on_m4b_keeps_chapters_tags_and_cover(tmp_path, monkeypatch):
    monkeypatch.setenv("PHARAOH_DISSECT_STUB", "1")
    import soundfile as sf
    sr = 16000
    burst = 0.3 * np.sin(2 * np.pi * 220 * np.arange(5 * sr) / sr)
    gap = np.zeros(int(1.5 * sr))
    wav = tmp_path / "src.wav"
    sf.write(str(wav), np.concatenate([gap, burst, gap, burst, gap]).astype(np.float32), sr)
    meta = tmp_path / "meta.txt"
    meta.write_text(
        ";FFMETADATA1\ntitle=Anne Test\nartist=LibriVox\n"
        "[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=7000\ntitle=Bright River\n"
        "[CHAPTER]\nTIMEBASE=1/1000\nSTART=7000\nEND=14500\ntitle=Green Gables\n"
    )
    cover = tmp_path / "c.jpg"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    "color=c=red:s=64x64:d=1", "-frames:v", "1", str(cover)], check=True)
    m4b = tmp_path / "book.m4b"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-i", str(meta), "-i", str(cover),
                    "-map", "0:a", "-map", "2:v", "-map_metadata", "1", "-map_chapters", "1",
                    "-c:a", "aac", "-c:v", "copy", "-disposition:v:0", "attached_pic", str(m4b)], check=True)

    out = tmp_path / "import"
    m = dp.run(dp.Models(), str(m4b), out, DissectOptions(), lambda f, msg: None)

    assert [c["title"] for c in m["chapters"]] == ["Bright River", "Green Gables"]
    assert m["source_tags"]["title"] == "Anne Test" and m["source_tags"]["artist"] == "LibriVox"
    assert m["cover"] == "cover.jpg" and (out / "cover.jpg").is_file()
    # The cover stream must not have been decoded as audio.
    assert 13.0 < m["duration_s"] < 16.0
    chapters_seen = {t["chapter"] for t in m["turns"]}
    assert chapters_seen <= {0, 1} and chapters_seen
    for sp in m["speakers"]:
        assert set(sp["chapters"]) <= {0, 1}
        for c in sp["candidates"]:
            assert c["chapter"] in (0, 1)


def test_find_credits_from_a_real_dramatis_personae():
    # Transcribed turns from the LibriVox "Anne of Green Gables" (DR) cast list,
    # including a credit split across a pause and ASR's "Red by".
    rows = [
        ("S1", 17.8, "Dramatus personae."), ("S1", 20.4, "Anne and Narrator read by RL Lipshaw"),
        ("S2", 24.9, "Marilla Cuthbert"), ("S2", 26.6, "Read by Elizabeth Clett"),
        ("S4", 28.7, "Matthew Cuthbert, read by Bruce Perry."),
        ("S5", 68.8, "The Doctor read by Phil Shinevere."),
        ("S6", 43.6, "Mrs Spencer."), ("S6", 45.5, "Read by Sally McConnell"),
        ("S6", 83.9, "Miss Lucilla Harris, read by Sally McConnell."),
        ("S1", 101.0, "End of dramatis personae"),
        ("S3", 300.0, "I said to Thomas, I said, and he just sat there."),
    ]
    turns = [{"speaker": s, "start": t, "end": t + 1.5, "text": x} for s, t, x in rows]
    got = {k: [(c["character"], c["performer"]) for c in v] for k, v in dp.find_credits(turns).items()}
    assert got["S1"] == [("Anne and Narrator", "RL Lipshaw")]
    assert got["S2"] == [("Marilla Cuthbert", "Elizabeth Clett")]
    assert got["S4"] == [("Matthew Cuthbert", "Bruce Perry")]
    assert got["S5"] == [("The Doctor", "Phil Shinevere")]
    assert got["S6"] == [("Mrs Spencer", "Sally McConnell"), ("Miss Lucilla Harris", "Sally McConnell")]
    assert "S3" not in got
