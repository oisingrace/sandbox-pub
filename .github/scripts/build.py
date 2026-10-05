"""Writes games.json and patchnotes.json for the site.

games.json      - every .html file in games/
patchnotes.json - one entry per commit that touched games/, newest first:
                  when it happened, which games were added/updated/removed,
                  and the commit message as the note (GitHub's default
                  "Add files via upload"-style messages are left out).
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GAMES = ROOT / "games"

DEFAULT_MESSAGE = re.compile(
    r"^(Add files via upload|(Create|Update|Delete|Rename|Add) \S+)$", re.I)
TRAILER = re.compile(r"^(Co-Authored-By|Claude-Session|Signed-off-by):", re.I)
KINDS = {"A": "added", "M": "updated", "D": "removed"}


def is_game(path):
    return (path.startswith("games/") and path.count("/") == 1
            and path.lower().endswith((".html", ".htm")))


def games_list():
    return sorted((p.name for p in GAMES.glob("*.htm*") if p.is_file()),
                  key=str.lower)


def note_from(message):
    lines = [l for l in message.strip().splitlines() if not TRAILER.match(l)]
    # Rejoin hard-wrapped lines; keep blank lines between paragraphs.
    note = re.sub(r"(?<!\n)\n(?!\n)", " ", "\n".join(lines).strip())
    return "" if DEFAULT_MESSAGE.match(note) else note


def patch_notes():
    log = subprocess.run(
        ["git", "log", "--no-renames", "--name-status",
         "--format=%x1e%cI%x1f%B%x1f", "--", "games/"],
        cwd=ROOT, capture_output=True, text=True, check=True).stdout
    notes = []
    for record in log.split("\x1e")[1:]:
        time, message, files = record.split("\x1f")
        entry = {"time": time, "note": note_from(message),
                 "added": [], "updated": [], "removed": []}
        for line in files.strip().splitlines():
            status, path = line.split("\t", 1)
            if is_game(path) and status[0] in KINDS:
                entry[KINDS[status[0]]].append(path.split("/", 1)[1])
        if entry["note"] or entry["added"] or entry["updated"] or entry["removed"]:
            notes.append(entry)
    return notes


(ROOT / "games.json").write_text(json.dumps(games_list(), indent=2))
(ROOT / "patchnotes.json").write_text(json.dumps(patch_notes(), indent=2))
