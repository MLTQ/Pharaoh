"""breeze_server helpers: tag translation, what should be heard, and WER."""
import pytest

pytest.importorskip("fastapi")
from breeze_server import spoken_words, to_vocal_events, wer


def test_pharaoh_tags_become_breeze_vocal_events():
    assert to_vocal_events("[laugh] You believed him?") == "(laugh) You believed him?"
    assert to_vocal_events("Well [sighs] fine.") == "Well (sigh) fine."
    assert to_vocal_events("[Clears Throat] Right.") == "(clears throat) Right."
    assert to_vocal_events("[gasps] What?") == "(gasp) What?"
    assert to_vocal_events("[sobbing] Please.") == "(sob) Please."
    assert to_vocal_events("[wheeze] Hah.") == "(wheeze) Hah.", "unknown cues still become events"
    assert to_vocal_events("No tags here.") == "No tags here."


def test_spoken_words_drop_events_and_tags():
    assert spoken_words("(laugh) You actually [chuckle] believed him?").split() == ["You", "actually", "believed", "him?"]


def test_wer():
    assert wer("The ledger was under the third stair.", "the ledger was under the third stair") == 0
    assert wer("one two three four", "one two four") == 0.25
    assert wer("", "anything") == 0
    assert wer("tucked under the third stair", "bath sell looks third stair") > 0.5
