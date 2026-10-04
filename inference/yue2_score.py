"""
Score handling for the YuE2 music server, kept free of torch so it can be
tested anywhere.

YuE2 writes an ABC score (Vocal + Ins voices, chord symbols on Vocal) and then
renders it. It has no duration or tempo argument, so Pharaoh controls both
here, on the score:

- `repair`: a plan cut off by the planner's token cap ends mid-line; drop
  trailing lines until it parses.
- `set_tempo`: rewrite the Q: header so a requested BPM is exact.
- `instrumental`: move every Vocal note to Ins (vendored YuE2 helper).
- `trim`: keep the whole bars that fit a target duration.
"""
from __future__ import annotations

import re
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "yue2_abc"))
from abc_tools import parse_abc  # noqa: E402
from compile_score import compile_events  # noqa: E402
from instrumentalize import convert_score, section_starts  # noqa: E402

NO_VOCALS = "no vocals, no singing, no choir, no spoken words"


def planning_lyrics(duration_s: float) -> str:
    """Section tags for an instrumental plan; fewer sections for short cues."""
    if duration_s < 45:
        return "[Intro]\n\n[Verse]\n\n[Outro]\n"
    return "[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n"


def section_tags(abc: str) -> str:
    """The lyrics YuE2 expects with an instrumental score: its section tags only."""
    labels = [line[2:] for line in abc.splitlines() if line.startswith("% ")]
    return "\n\n".join("[" + x.title() + "]" for x in labels) + ("\n" if labels else "")


def style_text(caption: str, bpm: int | None, key: str, instrumental: bool) -> str:
    parts = [caption.strip().rstrip(".,")]
    if key.strip():
        parts.append(key.strip())
    if bpm:
        parts.append(f"{bpm} BPM")
    style = ", ".join(p for p in parts if p)
    if instrumental:
        if not re.match(r"^instrumental\b", style, re.I):
            style = "Instrumental, " + style
        style += ", " + NO_VOCALS
    return style + "."


def _parses(abc: str, instrumental: bool) -> bool:
    try:
        convert_score(abc) if instrumental else parse_abc(abc)
        return True
    except Exception:
        return False


def repair(abc: str, instrumental: bool = True) -> str:
    """Drop trailing lines of a token-capped plan until it parses."""
    lines = abc.splitlines()
    while lines:
        text = "\n".join(lines) + "\n"
        if _parses(text, instrumental):
            return text
        lines.pop()
    raise ValueError("YuE2 wrote a score that can't be read; try another seed")


def set_tempo(abc: str, bpm: int) -> str:
    """Force the header tempo to `bpm` quarter notes per minute."""
    if re.search(r"^Q:", abc, re.M):
        return re.sub(r"^Q:.*$", f"Q:1/4={bpm}", abc, count=1, flags=re.M)
    return re.sub(r"^(L:.*)$", rf"\1\nQ:1/4={bpm}", abc, count=1, flags=re.M)


def nominal_seconds(abc: str) -> float:
    s = parse_abc(abc)
    return float(s.voices["Ins"].time * 60 / s.bpm)


def instrumental(abc: str) -> str:
    converted, _ = convert_score(abc)
    return converted


def trim(abc: str, seconds: float) -> str:
    """Cut an instrumental score to the whole bars that fit in `seconds`.

    parse_abc measures time in quarter-note beats. Keeps at least one bar.
    """
    s = parse_abc(abc)
    ins, voc = s.voices["Ins"], s.voices["Vocal"]
    sections = section_starts(abc, s)
    limit = Fraction(seconds).limit_denominator(1000) * s.bpm / 60
    bars, cut = [], Fraction(0)
    for start, _, (n, d) in voc.bars:
        length = Fraction(4 * n, d)
        if start + length > limit and bars:
            break
        bar = dict(meter=f"{n}/{d}", key=next(k for t, k in reversed(voc.keys) if t <= start))
        if start in sections:
            bar["section"] = sections[start]
        bars.append(bar)
        cut = start + length
    if cut >= ins.time:
        return abc
    notes = [[str(t), str(min(d, cut - t)), p] for t, p, d in ins.notes if t < cut]
    chords = []
    for t, c in voc.chords:
        if t < cut and (not chords or chords[-1][0] != str(t)):
            chords.append([str(t), c])
    text, _ = compile_events(dict(bpm=s.bpm, key=voc.keys[0][1], bars=bars, notes=notes, chords=chords))
    return text
