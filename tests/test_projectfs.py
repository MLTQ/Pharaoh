"""
Round-trip tests for the MCP server's script.csv reader/writer.

The bug these lock down: `_write_script_rows` used `rows[0].keys()` as the
DictWriter header with the default `extrasaction="raise"`. Any tool that added a
column to a row other than the first — `update_script_row` with an `emotion`,
`spatialize_row` with `spatial_azimuth` — raised *after* the file had been
opened with mode "w", leaving script.csv truncated to a bare header.
"""
import csv

import projectfs
from projectfs import SCRIPT_FIELDS, _script_rows, _write_script_rows


def _blank_row(**over):
    row = {f: "" for f in SCRIPT_FIELDS}
    row.update(over)
    return row


def _make_scene(projects_dir, rows):
    (projects_dir / "p1" / "scenes" / "s1").mkdir(parents=True)
    _write_script_rows("p1", "s1", rows)


def test_write_uses_canonical_22_column_header(projects_dir):
    _make_scene(projects_dir, [_blank_row(type="DIALOGUE", prompt="hello")])

    path = projects_dir / "p1" / "scenes" / "s1" / "script.csv"
    header = next(csv.reader(path.read_text().splitlines()))
    assert header == SCRIPT_FIELDS
    assert len(header) == 22
    # The Rust ScriptRow tail that the old 16-column header dropped.
    for col in ("emotion", "gain_envelope", "spatial_azimuth", "spatial_space"):
        assert col in header


def test_adding_a_key_to_a_later_row_does_not_truncate(projects_dir):
    rows = [
        _blank_row(type="DIALOGUE", prompt=f"line {i}", file=f"a{i}.wav")
        for i in range(3)
    ]
    _make_scene(projects_dir, rows)

    back = _script_rows("p1", "s1")
    back[2]["spatial_azimuth"] = "90"

    _write_script_rows("p1", "s1", back)

    final = _script_rows("p1", "s1")
    assert len(final) == 3, "rows must survive the write"
    assert final[2]["spatial_azimuth"] == "90"
    assert final[0]["file"] == "a0.wav"


def test_unknown_extra_column_is_appended_not_fatal(projects_dir):
    _make_scene(projects_dir, [_blank_row(type="SFX", prompt="door")])

    back = _script_rows("p1", "s1")
    back[0]["some_future_column"] = "x"
    _write_script_rows("p1", "s1", back)

    final = _script_rows("p1", "s1")
    assert final[0]["some_future_column"] == "x"
    assert final[0]["prompt"] == "door"


def test_write_is_atomic_and_leaves_no_temp_file(projects_dir):
    _make_scene(projects_dir, [_blank_row(type="DIALOGUE", prompt="hi")])
    scene = projects_dir / "p1" / "scenes" / "s1"
    assert list(scene.glob("*.tmp")) == []


def test_failed_write_leaves_the_previous_file_intact(projects_dir, monkeypatch):
    _make_scene(projects_dir, [_blank_row(type="DIALOGUE", prompt="original")])
    path = projects_dir / "p1" / "scenes" / "s1" / "script.csv"
    before = path.read_text()

    class Boom(Exception):
        pass

    def explode(*a, **k):
        raise Boom()

    monkeypatch.setattr(projectfs.csv, "DictWriter", explode)
    try:
        _write_script_rows("p1", "s1", [_blank_row(type="DIALOGUE", prompt="new")])
    except Boom:
        pass

    assert path.read_text() == before, "a failed write must not clobber the file"
