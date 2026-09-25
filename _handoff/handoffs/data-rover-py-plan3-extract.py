"""Write the code blocks of ONE task (optionally ONE step) of the engine-ops plan to disk.

    python data-rover-py-plan3-extract.py <task> [--step N]... [--root DIR] [--dry-run]

Two kinds of block are applied, in the order the plan shows them:

  `path`:                      or  `path` (replace the whole file):
  <blank> ```lang … ```            -> the file is written whole

  In `path`, replace:
  <blank> ```lang old ``` <blank> with: <blank> ```lang new ```
                                   -> `old` must occur exactly once; it becomes `new`

The blocks are copied from the plan ON DISK, never retyped, so nothing a tool layer
does to typed text can reach them. No block of this plan holds a 4-digit unicode
escape, but the habit stays.
"""

import argparse
import re
from pathlib import Path

PLAN = Path("/home/mdp/workspace/data-rover-py/docs/superpowers/plans/2026-09-18-engine-ops.md")
BLOCK = re.compile(
    r"^`(?P<file>[^`\n]+\.(?:py|ts))`(?: \([^\n]*\))?:\n\n```(?:python|ts)\n(?P<body>.*?)\n```$"
    r"|^In `(?P<target>[^`\n]+)`, replace:\n\n```\w+\n(?P<old>.*?)\n```\n\nwith:\n\n```\w+\n(?P<new>.*?)\n```$",
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
        else:
            target = Path(args.root) / match["target"]
            text = target.read_text(encoding="utf-8")
            count = text.count(match["old"])
            if count != 1:
                raise SystemExit(f"step {number}: {match['target']}: old text occurs {count} times")
            print(f"step {number}:", "dry" if args.dry_run else "edit", match["target"])
            if not args.dry_run:
                target.write_text(text.replace(match["old"], match["new"]), encoding="utf-8")
