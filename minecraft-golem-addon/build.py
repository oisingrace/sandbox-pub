#!/usr/bin/env python3
"""Stamp VERSION into both manifests and build ../golem-commanders-v<VERSION>.mcaddon.
Bump VERSION for every build: Minecraft only imports a pack over an existing one if its version is higher."""
import json, os, sys, zipfile, glob
here = os.path.dirname(os.path.abspath(__file__)); os.chdir(here)
v = open("VERSION").read().strip(); vt = [int(x) for x in v.split(".")]
for pack, label in (("BP", "BP"), ("RP", "RP")):
    p = f"{pack}/manifest.json"; m = json.load(open(p))
    m["header"]["name"] = f"Golem Commanders v{v} ({label})"
    m["header"]["version"] = vt
    for mod in m["modules"]: mod["version"] = vt
    for dep in m.get("dependencies", []):
        if "uuid" in dep: dep["version"] = vt   # BP -> RP dependency must match the RP version
    json.dump(m, open(p, "w"), indent=2); open(p, "a").write("\n")
out = os.path.abspath(f"../golem-commanders-v{v}.mcaddon")
for old in glob.glob("../golem-commanders*.mcaddon"): os.remove(old)
def pack(folder):
    path = f"/tmp/golem_{folder}_v{v}.mcpack"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for r, _, fs in os.walk(folder):
            for f in fs:
                full = os.path.join(r, f); z.write(full, os.path.relpath(full, folder))
    return path
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in ("BP", "RP"):
        p = pack(f); z.write(p, os.path.basename(p)); os.remove(p)
print(out)
