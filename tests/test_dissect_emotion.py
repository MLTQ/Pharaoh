"""dissect_emotion.utterances: diarization turns -> clone-length utterances."""
import numpy as np

from dissect_emotion import EMB_DIM, LABELS, prosody, speaking_rate, tag, utterances


def T(spk, a, b, text="", overlap=False):
    return {"speaker": spk, "start": a, "end": b, "text": text, "overlap": overlap}


def test_joins_close_same_speaker_turns():
    u = utterances([T("S1", 0.0, 1.5, "Hello"), T("S1", 1.8, 3.0, "there")])
    assert len(u) == 1
    assert (u[0]["start"], u[0]["end"], u[0]["text"]) == (0.0, 3.0, "Hello there")


def test_another_speaker_or_a_long_pause_breaks_the_utterance():
    u = utterances([T("S1", 0, 2), T("S2", 2.1, 4), T("S1", 4.1, 6), T("S1", 8.0, 10)])
    assert [x["speaker"] for x in u] == ["S1", "S2", "S1", "S1"]


def test_never_longer_than_max_and_long_turns_are_split_evenly():
    u = utterances([T("S1", 0, 30, "long")], max_s=12)
    assert len(u) == 3
    assert all(abs((x["end"] - x["start"]) - 10) < 1e-6 for x in u)
    joined = utterances([T("S1", 0, 7), T("S1", 7.2, 14)], max_s=12)
    assert len(joined) == 2, "joining would exceed max_s"


def test_drops_fragments_and_carries_overlap():
    u = utterances([T("S1", 0, 0.5), T("S2", 1, 3, overlap=True)])
    assert len(u) == 1 and u[0]["speaker"] == "S2" and u[0]["overlap"] is True


def test_tag_scores_every_utterance_with_the_argmax_emotion_and_embedding():
    class Fake:
        def scores(self, clips):
            v = np.ones(EMB_DIM, np.float32) / np.sqrt(EMB_DIM)
            return [({k: (0.9 if k == "angry" else 0.01) for k in LABELS}, v) for _ in clips]

    utts = utterances([T("S1", 0, 2), T("S2", 3, 5)])
    utts, vecs = tag(Fake(), utts, lambda a, b: np.zeros(int((b - a) * 16000), np.float32))
    assert all(x["emotion"] == "angry" and set(x["scores"]) == set(LABELS) for x in utts)
    assert vecs.shape == (2, EMB_DIM) and abs(float(np.linalg.norm(vecs[0].astype(np.float32))) - 1) < 1e-2


def test_speaking_rate_from_word_timings():
    words = [{"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4} for i, w in enumerate("one two three four five".split())]
    # 5 words of 0.4 s with 0.1 s gaps: 2.0 s + 0.4 s of gaps.
    assert speaking_rate(words) == round(5 / 2.4, 2)
    paused = [dict(w, start=w["start"] + (3 if i >= 3 else 0), end=w["end"] + (3 if i >= 3 else 0)) for i, w in enumerate(words)]
    assert speaking_rate(paused) == round(5 / (2.0 + 0.1 * 3 + 0.25), 2), "a long pause counts as 0.25 s"
    assert speaking_rate(words[:2]) is None
    u = utterances([T("S1", 0, 2.4) | {"words": words}])
    assert u[0]["rate"] == round(5 / 2.4, 2)


def test_prosody_tells_a_pitched_tone_from_noise():
    pytest = __import__("pytest")
    pytest.importorskip("librosa")
    t = np.arange(16000 * 2) / 16000
    tone = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    noise = (0.05 * np.random.default_rng(0).standard_normal(len(t))).astype(np.float32)
    pt, pn = prosody(tone), prosody(noise)
    assert abs(pt["f0_hz"] - 220) < 10 and pt["f0_var"] < 0.5
    assert pn["flat"] > pt["flat"], "noise (breath, whisper) is spectrally flatter"
    assert pt["loud_db"] > pn["loud_db"]
