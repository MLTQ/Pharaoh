"""
MCP tools: series (show bibles) and episodes.

"Make me an episode of X" from an MCP client: read the bible with
`get_series_brief`, write the episode yourself in audio-drama Fountain, then
land it with `import_series_episode`. Landing and the brief go through the
`pharaoh` CLI, the same Rust code the app runs: Fountain import, the series
cast's library voices, `#tag` sound cues bound to the show's recordings, and
the canon log. Listing is plain filesystem.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

from config import PROJECTS_DIR, log
from server import mcp

_HERE = Path(__file__).resolve().parent


def _cli() -> str | None:
    """The pharaoh binary: $PHARAOH_CLI, the newest repo build, the installed app, or PATH."""
    target = _HERE.parent.parent / "src-tauri" / "target"
    builds = sorted(
        (p for p in (target / "release" / "pharaoh", target / "debug" / "pharaoh") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    candidates = [
        os.environ.get("PHARAOH_CLI", ""),
        *(str(b) for b in builds),
        "/Applications/Pharaoh.app/Contents/MacOS/pharaoh",
        str(Path.home() / "Applications" / "Pharaoh.app" / "Contents" / "MacOS" / "pharaoh"),
        shutil.which("pharaoh") or "",
    ]
    for c in candidates:
        if c and Path(c).is_file() and os.access(c, os.X_OK):
            return c
    return None


def _run(args: list[str], stdin: str | None = None, timeout: int = 300) -> dict:
    cli = _cli()
    if not cli:
        return {"error": "pharaoh CLI not found; build it (cd src-tauri && cargo build) or set PHARAOH_CLI"}
    try:
        r = subprocess.run([cli, *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"pharaoh {' '.join(args[:2])} timed out"}
    if r.returncode != 0:
        return {"error": (r.stderr or r.stdout).strip()[-3000:]}
    return {"stdout": r.stdout, "stderr": r.stderr}


def _series_root() -> Path:
    return PROJECTS_DIR / "_series"


@mcp.tool()
def list_series() -> str:
    """
    List every series (show bible): id, title, format, logline, cast names and
    episode count. A series is a recurring cast, world and house style; its
    episodes are ordinary projects with `series_id` set.
    """
    out = []
    root = _series_root()
    episodes: dict[str, int] = {}
    if PROJECTS_DIR.exists():
        for pj in PROJECTS_DIR.glob("*/project.json"):
            try:
                sid = json.loads(pj.read_text()).get("series_id")
            except Exception:
                continue
            if sid:
                episodes[sid] = episodes.get(sid, 0) + 1
    if root.exists():
        for sj in sorted(root.glob("*/series.json")):
            try:
                s = json.loads(sj.read_text())
            except Exception as e:
                log.warning("unreadable %s: %s", sj, e)
                continue
            sid = sj.parent.name
            out.append({
                "id": sid,
                "title": s.get("title", ""),
                "format": s.get("format", ""),
                "logline": s.get("logline", ""),
                "cast": [m.get("name", "") for m in s.get("cast", [])],
                "episodes": episodes.get(sid, 0),
            })
    return json.dumps(out, indent=2)


@mcp.tool()
def get_series_brief(series: str) -> str:
    """
    The series bible as the episode writer sees it (Markdown): premise, world,
    cast (engines, how they talk, catchphrases, relationships), sets and their
    bed lines, the sound package tags (`MUSIC: #theme`), the formula, house
    style, golden scenes and canon so far. `series` is an id or (part of) the
    title. Read this before writing an episode.
    """
    r = _run(["series", "brief", series])
    return r.get("stdout") or json.dumps(r)


@mcp.tool()
def import_series_episode(
    series: str,
    fountain: str,
    title: str = "",
    logline: str = "",
    synopsis: str = "",
    canon_summary: str = "",
    canon_facts: list[str] | None = None,
    canon_gags: list[str] | None = None,
    canon_threads: list[str] | None = None,
) -> str:
    """
    Land a finished episode script as a new episode of `series`.

    `fountain` is the whole script in audio-drama Fountain: `# Act` section
    lines, a heading (INT./EXT.) per scene, CHARACTER cues in capitals using
    the cast's names, (parentheticals) as short delivery notes, and
    `SFX:` / `BED:` / `MUSIC:` lines; a tag from the brief's sound package
    (`MUSIC: #theme`, `BED: #hum`) plays the show's own recording.

    The episode gets the series cast with their library voices; new speakers
    become characters to design. The canon_* fields are what this episode
    adds to the show's continuity (summary, facts, running gags, open threads).

    Returns the new project_id, scene count and new characters. Generate and
    render it like any project afterwards.
    """
    args = ["episode", "import", series, "-"]
    for flag, val in (("--title", title), ("--logline", logline), ("--synopsis", synopsis)):
        if val:
            args += [flag, val]
    canon = {
        "summary": canon_summary,
        "facts": canon_facts or [],
        "gags": canon_gags or [],
        "threads": canon_threads or [],
    }
    if any(canon.values()):
        args += ["--canon", json.dumps(canon)]
    r = _run(args, stdin=fountain)
    return r.get("stdout") or json.dumps(r)
