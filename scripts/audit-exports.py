"""Audit the published package: every shipped file vs every file reachable
through the exports map.

A file present in `files` but absent from `exports` is published yet
unimportable — the exact defect that made read-along.css unreachable.
"""
import json
import pathlib

d = json.load(open("package.json", encoding="utf-8"))
exports = d.get("exports", {})
reachable = set()
for value in exports.values():
    if isinstance(value, str):
        reachable.add(value.lstrip("./"))

shipped = []
for pattern in d.get("files", []):
    p = pathlib.Path(pattern)
    if p.is_dir():
        shipped += [
            str(x).replace("\\", "/") for x in p.rglob("*") if x.is_file()
        ]
    elif p.is_file():
        shipped.append(pattern)

print(f"{d['name']}@{d['version']}")
print()
print("  shipped:")
for f in sorted(shipped):
    print(f"     {f}")
print()
print("  reachable via exports:")
for f in sorted(reachable):
    print(f"     {f}")
print()
blocked = [f for f in shipped if f not in reachable]
print("  SHIPPED BUT UNREACHABLE:")
for f in sorted(blocked):
    print(f"     {f}")
if not blocked:
    print("     none")
