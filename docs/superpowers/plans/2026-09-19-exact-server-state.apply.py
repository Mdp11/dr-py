"""Apply the code blocks of one task of a plan document to a working tree.

    python replay.py <plan.md> <tree> <task number> [--upto "<step title fragment>"]

Reads the plan ON DISK, never its template: `path` (create): writes a file,
"In `path`, replace:" / "with:" replaces an exact string that must occur once,
"In `path`, delete:" removes one. With --upto, stops before the first step
heading that contains the fragment, so a failing state can be run first;
--from resumes there.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

plan = Path(sys.argv[1]).read_text()
tree = Path(sys.argv[2])
task_no = int(sys.argv[3])
upto = sys.argv[sys.argv.index("--upto") + 1] if "--upto" in sys.argv else None
start = sys.argv[sys.argv.index("--from") + 1] if "--from" in sys.argv else None

tasks = re.split(r"(?m)^### Task (\d+):", plan)
body = next(tasks[i + 1] for i in range(1, len(tasks), 2) if int(tasks[i]) == task_no)

if start is not None:
    at = next(
        m.start() for m in re.finditer(r"(?m)^- \[ \] \*\*Step.*$", body) if start in m.group(0)
    )
    body = body[at:]
if upto is not None:
    at = next(
        m.start() for m in re.finditer(r"(?m)^- \[ \] \*\*Step.*$", body) if upto in m.group(0)
    )
    body = body[:at]

def block(name: str) -> str:
    return rf"(?P<{name}_ticks>`{{3,}})[a-z]*\n(?P<{name}>.*?)^(?P={name}_ticks)\n"


CREATE = re.compile(r"(?ms)^`(?P<path>[^`\n]+)` \(create\):\n\n" + block("new"))
REPLACE = re.compile(
    r"(?ms)^In `(?P<path>[^`\n]+)`, replace:\n\n" + block("old") + r"\nwith:\n\n" + block("new")
)
DELETE = re.compile(r"(?ms)^In `(?P<path>[^`\n]+)`, delete:\n\n" + block("old"))

actions: list[tuple[int, str, str, str, str]] = []
for m in CREATE.finditer(body):
    actions.append((m.start(), "create", m["path"], "", m["new"]))
for m in REPLACE.finditer(body):
    actions.append((m.start(), "replace", m["path"], m["old"], m["new"]))
for m in DELETE.finditer(body):
    actions.append((m.start(), "delete", m["path"], m["old"], ""))

for _, kind, path, old, new in sorted(actions):
    target = tree / path
    if kind == "create":
        assert not target.exists(), f"{path} exists already"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(new)
    else:
        text = target.read_text()
        if text.count(old) == 0:
            # a fragment of a long prose line: the block's own line end is not part of it
            old, new = old.removesuffix("\n"), new.removesuffix("\n")
        assert text.count(old) == 1, f"{path}: block occurs {text.count(old)} times:\n{old[:200]}"
        target.write_text(text.replace(old, new))
    print(f"{kind:8} {path}")
print(f"task {task_no}: {len(actions)} blocks applied")
