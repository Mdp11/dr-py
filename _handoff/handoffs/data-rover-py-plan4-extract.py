"""Write the code blocks of ONE task (optionally ONE step) of the engine-snapshot plan to disk.

    python data-rover-py-plan4-extract.py <task> [--step N]... [--root DIR] [--dry-run]

Three kinds of block are applied, in the order the plan shows them:

  `path`:                      or  `path` (replace the whole file):
  <blank> ```lang … ```            -> the file is written whole

  In `path`, replace:
  <blank> ```lang old ``` <blank> with: <blank> ```lang new ```
                                   -> `old` must occur exactly once; it becomes `new`

  In `path`, delete the line:
  <blank> ```lang old ```          -> `old` and its line end must occur exactly once; they go

Shell blocks (`git mv`, `git switch`, commits) and Run: lines are NOT executed: do those by hand.
The blocks are copied from the plan ON DISK, never retyped, so nothing a tool layer does to
typed text can reach them. No block of this plan holds a 4-digit unicode escape.
"""

import argparse
import re
from pathlib import Path

PLAN = Path("/home/mdp/workspace/data-rover-py/docs/superpowers/plans/2026-09-18-engine-snapshot.md")
BLOCK = re.compile(
    r"^`(?P<file>[^`\n]+\.(?:py|ts))`(?: \([^\n]*\))?:\n\n```(?:python|ts)\n(?P<body>.*?)\n```$"
    r"|^In `(?P<target>[^`\n]+)`, replace:\n\n```\w+\n(?P<old>.*?)\n```\n\nwith:\n\n```\w+\n(?P<new>.*?)\n```$"
    r"|^In `(?P<shorter>[^`\n]+)`, delete the line:\n\n```\w+\n(?P<gone>.*?)\n```$",
    re.S | re.M,
)

parser = argparse.ArgumentParser()
parser.add_argument("task", type=int)
parser.add_argument("--step", type=int, action="append", default=[])
parser.add_argument("--root", default="/home/mdp/workspace/data-rover-py")
parser.add_argument("--dry-run", action="store_true")
args = parser.parse_args()

plan = PLAN.read_text(encoding="utf-8")
start = plan.index(f"\n### Task {args.task}:")
following = plan.find("\n### Task ", start + 1)
section = plan[start : following if following >= 0 else plan.index("\n## After this plan")]

steps = re.split(r"(?m)^- \[ \] \*\*Step (\d+):", section)
chunks = [(int(steps[i]), steps[i + 1]) for i in range(1, len(steps), 2)]
for number, chunk in chunks:
    if args.step and number not in args.step:
        continue
    for match in BLOCK.finditer(chunk):
        if match["file"]:
            target = Path(args.root) / match["file"]
            print(f"step {number}:", "dry" if args.dry_run else "write", match["file"])
            if not args.dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(match["body"] + "\n", encoding="utf-8")
            continue
        name = match["target"] or match["shorter"]
        old, new = (match["old"], match["new"]) if match["target"] else (match["gone"] + "\n", "")
        target = Path(args.root) / name
        text = target.read_text(encoding="utf-8")
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"step {number}: {name}: old text occurs {count} times")
        print(f"step {number}:", "dry" if args.dry_run else "edit", name)
        if not args.dry_run:
            target.write_text(text.replace(old, new), encoding="utf-8")
