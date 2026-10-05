#!/usr/bin/env python3
"""Bundle index.html + src/*.js into one self-contained HTML file.

The modules are concatenated in dependency order into a single inline
<script type="module">. Local imports are dropped (everything shares one
scope); CDN imports resolved by the page's import map are kept once.

Usage: python3 scripts/build-standalone.py  ->  writes games/smash-lot.html
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER = ['physics', 'carkit', 'carModel', 'vehicles', 'destruction', 'world', 'effects', 'camera', 'input', 'audio', 'settings', 'menu', 'burn', 'terrain', 'net', 'multiplayer', 'carCollision', 'stadium', 'football', 'bot', 'quake', 'flamethrower', 'score', 'patchnotes', 'vsmap', 'motorway', 'weapons', 'versus', 'customs', 'workshop', 'main']
OUT = ROOT / 'games' / 'smash-lot.html'

bare_imports = []
parts = []
for name in ORDER:
    src = (ROOT / 'src' / f'{name}.js').read_text()
    for line in re.findall(r"^import .*?;\n", src, flags=re.M):
        if re.search(r"from '\.", line):
            continue
        if line not in bare_imports:
            bare_imports.append(line)
    src = re.sub(r"^import .*?;\n", '', src, flags=re.M)
    src = re.sub(r'^export (default )?', '', src, flags=re.M)
    parts.append(f'// ===== {name}.js =====\n{src.strip()}\n')

code = ''.join(bare_imports) + '\n' + '\n'.join(parts)
names = re.findall(r'^(?:const|let|function|class|async function) (\w+)', code, flags=re.M)
dups = sorted({n for n in names if names.count(n) > 1})
if dups:
    raise SystemExit(f'Top-level name collision between modules: {dups}')

html = (ROOT / 'index.html').read_text()
tag = '<script type="module" src="./src/main.js"></script>'
assert tag in html, 'entry script tag not found in index.html'
html = html.replace(tag, f'<script type="module">\n{code}</script>')
OUT.write_text(html)
print(f'wrote {OUT.relative_to(ROOT)} ({len(html) // 1024} KB)')
