"""dissect_emotion.utterances: diarization turns -> clone-length utterances."""
import numpy as np

from dissect_emotion import LABELS, tag, utterances


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


def test_tag_scores_every_utterance_with_the_argmax_emotion():
    class Fake:
        def scores(self, clips):
            return [{k: (0.9 if k == "angry" else 0.01) for k in LABELS} for _ in clips]

    utts = utterances([T("S1", 0, 2), T("S2", 3, 5)])
    tag(Fake(), utts, lambda a, b: np.zeros(int((b - a) * 16000), np.float32))
    assert all(x["emotion"] == "angry" and set(x["scores"]) == set(LABELS) for x in utts)
