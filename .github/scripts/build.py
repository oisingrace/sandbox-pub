"""Writes games.json, experiments.json and patchnotes.json for the site.

games.json       - every .html file in games/
experiments.json - every .html file in experiments/
patchnotes.json  - one entry per commit that touched games/ or experiments/, newest first:
                  when it happened, which games were added/updated/removed,
                  and the commit message as the note (GitHub's default
                  "Add files via upload"-style messages are left out).

A game can carry its own patch notes instead: a block in its HTML like

    <script type="application/json" id="patch-notes">
      [{"version": "1.1", "date": "2026-10-05", "title": "...", "notes": ["...", "..."]}, ...]
    </script>

(newest first). Each version becomes an entry, and that game's commits
are left out of the list so it isn't shown twice.
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GAMES = ROOT / "games"
EXPERIMENTS = ROOT / "experiments"

DEFAULT_MESSAGE = re.compile(
    r"^(Add files via upload|(Create|Update|Delete|Rename|Add) \S+)$", re.I)
TRAILER = re.compile(r"^(Co-Authored-By|Claude-Session|Signed-off-by):", re.I)
KINDS = {"A": "added", "M": "updated", "D": "removed"}
OWN_NOTES = re.compile(
    r"<script[^>]*\bid=[\"']patch-notes[\"'][^>]*>(.*?)</script>", re.S | re.I)


# Search-engine verification files (e.g. google1234abcd.html) aren't games.
VERIFICATION = re.compile(r"^google[0-9a-f]+\.html$", re.I)


def is_game(path):
    return (path.startswith(("games/", "experiments/")) and path.count("/") == 1
            and path.lower().endswith((".html", ".htm"))
            and not VERIFICATION.match(path.split("/", 1)[1]))


def html_files(folder):
    return sorted((p.name for p in folder.glob("*.htm*")
                   if p.is_file() and not VERIFICATION.match(p.name)),
                  key=str.lower)


def note_from(message):
    lines = [l for l in message.strip().splitlines() if not TRAILER.match(l)]
    # Rejoin hard-wrapped lines; keep blank lines between paragraphs.
    note = re.sub(r"(?<!\n)\n(?!\n)", " ", "\n".join(lines).strip())
    return "" if DEFAULT_MESSAGE.match(note) else note


def own_notes():
    """Games and experiments that carry their own patch notes: file name -> versions (newest first)."""
    out = {}
    for p in [*GAMES.glob("*.htm*"), *EXPERIMENTS.glob("*.htm*")]:
        m = OWN_NOTES.search(p.read_text(encoding="utf-8", errors="ignore"))
        if not m:
            continue
        try:
            versions = json.loads(m.group(1))
        except ValueError:
            continue
        if isinstance(versions, list) and versions:
            out[p.name] = versions
    return out


def own_entries(own):
    entries = []
    for file, versions in own.items():
        n = len(versions)
        for i, v in enumerate(versions):
            if not isinstance(v, dict) or not re.match(r"^\d{4}-\d{2}-\d{2}$", str(v.get("date", ""))):
                continue
            # Midday UTC on its date; later versions a moment later, so same-day ones stay in order.
            entries.append({
                "time": f"{v['date']}T12:00:{n - i:02d}Z" if n - i < 60 else f"{v['date']}T12:00:59Z",
                "dateOnly": True,
                "title": " · ".join(x for x in [f"v{v['version']}" if v.get("version") else "", str(v.get("title", ""))] if x),
                "items": [str(x) for x in v.get("notes", []) if str(x).strip()],
                "note": "",
                "added": [file] if i == n - 1 else [],
                "updated": [] if i == n - 1 else [file],
                "removed": [],
            })
    return entries


def patch_notes():
    own = own_notes()
    log = subprocess.run(
        ["git", "log", "--no-renames", "--name-status",
         "--format=%x1e%cI%x1f%B%x1f", "--", "games/", "experiments/"],
        cwd=ROOT, capture_output=True, text=True, check=True).stdout
    notes = []
    for record in log.split("\x1e")[1:]:
        time, message, files = record.split("\x1f")
        entry = {"time": time, "note": note_from(message),
                 "added": [], "updated": [], "removed": []}
        touched = 0
        for line in files.strip().splitlines():
            status, path = line.split("\t", 1)
            if is_game(path) and status[0] in KINDS:
                touched += 1
                name = path.split("/", 1)[1]
                if name in own:
                    continue  # this game writes its own notes
                entry[KINDS[status[0]]].append(name)
        tagged = entry["added"] or entry["updated"] or entry["removed"]
        # A commit that only changed games with their own notes is covered by those.
        if touched and not tagged:
            continue
        if entry["note"] or tagged:
            notes.append(entry)
    return own_entries(own) + notes


(ROOT / "games.json").write_text(json.dumps(html_files(GAMES), indent=2))
(ROOT / "experiments.json").write_text(json.dumps(html_files(EXPERIMENTS), indent=2))
(ROOT / "patchnotes.json").write_text(json.dumps(patch_notes(), indent=2))
