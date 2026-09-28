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
