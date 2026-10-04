"""yue2_score: shaping YuE2's planned scores (no GPU, no yue2 package needed)."""
from pathlib import Path

import pytest

import yue2_score as y
from abc_tools import parse_abc

FIXTURES = Path(__file__).parent / "fixtures" / "yue2"
TAVERN = (FIXTURES / "tavern.abc").read_text()        # a full plan: 249 s at 80 BPM
TRUNCATED = (FIXTURES / "truncated.abc").read_text()  # planner hit its token cap mid-line


def test_truncated_plan_is_repaired_to_whole_lines():
    with pytest.raises(Exception):
        y.instrumental(TRUNCATED)
    fixed = y.repair(TRUNCATED)
    assert fixed != TRUNCATED and TRUNCATED.startswith(fixed.rstrip("\n").rsplit("\n", 1)[0])
    assert y.nominal_seconds(y.instrumental(fixed)) > 100


def test_complete_plan_is_left_alone():
    assert y.repair(TAVERN) == TAVERN.rstrip("\n") + "\n"


def test_instrumental_moves_every_vocal_note():
    score = parse_abc(y.instrumental(TAVERN))
    assert not score.voices["Vocal"].notes
    assert score.voices["Ins"].notes
    assert score.voices["Vocal"].chords, "harmony stays on the Vocal voice"


@pytest.mark.parametrize("target", [10, 20, 30, 60, 90])
def test_trim_fits_whole_bars_within_target(target):
    short = y.trim(y.instrumental(TAVERN), target)
    seconds = y.nominal_seconds(short)
    bar = 2 * 60 / 80  # 2/4 at 80 BPM
    assert target - bar <= seconds <= target


def test_trim_longer_than_score_keeps_score():
    ins = y.instrumental(TAVERN)
    assert y.trim(ins, 600) == ins


def test_set_tempo_rescales_duration():
    ins = y.instrumental(TAVERN)
    faster = y.set_tempo(ins, 160)
    assert parse_abc(faster).bpm == 160
    assert y.nominal_seconds(faster) == pytest.approx(y.nominal_seconds(ins) / 2)


def test_section_tags_are_the_only_lyrics():
    tags = y.section_tags(y.trim(y.instrumental(TAVERN), 60))
    assert tags.startswith("[Intro]")
    assert all(line.startswith("[") for line in tags.split())


def test_style_text_for_instrumental_cue():
    style = y.style_text("tense underscore, sparse piano.", 70, "Cm", True)
    assert style == ("Instrumental, tense underscore, sparse piano, Cm, 70 BPM, "
                     "no vocals, no singing, no choir, no spoken words.")
    assert y.style_text("Instrumental, harp", None, "", True).count("Instrumental") == 1
    assert "no vocals" not in y.style_text("pop ballad", None, "", False)
