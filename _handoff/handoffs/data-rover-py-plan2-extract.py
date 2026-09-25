"""Write the whole-file code blocks of ONE task of the engine-store plan to disk.

    python data-rover-py-plan2-extract.py <task number> [--root DIR] [--dry-run]
                                          [--only TEXT]... [--skip TEXT]... [--partials]

--only / --skip pick blocks by a substring of their path, so a task's tests can
be written first (--only test), seen failing, and the rest written after
(--skip test). With --partials and --only/--skip, the partial edits follow the
same filter.

The tool layer of a Claude session decodes 4-digit unicode escapes typed into a
tool call, so files holding escapes must be copied from the plan ON DISK, never
retyped. A whole-file block is introduced by a line "`path`:" or
"`path` (...):", a blank line, and a python/ts fence. The partial edits (Task 2:
the test file's import block and appended tests, serialize.py's insertion;
Task 7: model.ts) are applied only with --partials, which expects the files in
the state the plan says they are in at that step and refuses anything else.
"""

import argparse
import re
from pathlib import Path

PLAN = Path("/home/mdp/workspace/data-rover-py/docs/superpowers/plans/2026-09-18-engine-store.md")
BLOCK = re.compile(
    r"^`([^`\n]+\.(?:py|ts))`(?: \([^\n]*\))?:\n\n```(?:python|ts)\n(.*?)\n```$", re.S | re.M
)

parser = argparse.ArgumentParser()
parser.add_argument("task", type=int)
parser.add_argument("--root", default="/home/mdp/workspace/data-rover-py")
parser.add_argument("--dry-run", action="store_true")
parser.add_argument("--partials", action="store_true")
parser.add_argument("--only", action="append", default=[])
parser.add_argument("--skip", action="append", default=[])
args = parser.parse_args()

plan = PLAN.read_text(encoding="utf-8")
start = plan.index(f"\n### Task {args.task}:")
following = plan.find("\n### Task ", start + 1)
section = plan[start : following if following >= 0 else plan.index("\n## After this plan")]


def wanted(path: str) -> bool:
    if args.only and not any(text in path for text in args.only):
        return False
    return not any(text in path for text in args.skip)


for path, body in BLOCK.findall(section):
    if not wanted(path):
        continue
    target = Path(args.root) / path
    print("dry" if args.dry_run else "write", path, f"({len(body.splitlines())} lines)")
    if not args.dry_run:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body + "\n", encoding="utf-8")


def fenced(step_title: str, lang: str) -> list[str]:
    begin = section.index(step_title)
    end = section.find("\n- [ ] **Step", begin + 1)
    step = section[begin : end if end >= 0 else len(section)]
    return re.findall(rf"```{lang}\n(.*?)\n```", step, flags=re.S)


def edit(path: str, change) -> None:
    if not wanted(path):
        return
    target = Path(args.root) / path
    before = target.read_text(encoding="utf-8")
    after = change(before)
    assert after != before, f"{path}: nothing changed"
    print("dry" if args.dry_run else "edit", path)
    if not args.dry_run:
        target.write_text(after, encoding="utf-8")


def once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one {old[:50]!r}"
    return text.replace(old, new)


if args.partials and args.task == 2:
    imports, appended = fenced("**Step 1: Write the failing tests**", "python")
    (line_writer,) = fenced("**Step 3: Add the line writer**", "python")

    def tests(text: str) -> str:
        a, b = text.index("import gzip"), text.index("MM_YAML = ")
        assert "iter_entity_lines" not in text, "already applied"
        return text[:a] + imports + "\n\n" + text[b:].rstrip("\n") + "\n\n\n" + appended + "\n"

    edit("tests/api/test_snapshot_codec.py", tests)
    edit(
        "src/data_rover/api/serialize.py",
        lambda text: once(text, "def iter_buffered(", line_writer + "\n\n\ndef iter_buffered("),
    )

if args.partials and args.task == 7:
    errors, load, methods, reserved = fenced("**Step 5: Add the loader to `Model`**", "ts")
    anchor = "\t/** Recomputes every index and the records' adjacency from the entities. */"

    def model(text: str) -> str:
        text = once(text, "import { ModelError } from './errors.ts';", errors)
        text = once(text, "import { IndexSet } from './indexes.ts';\n", "import { IndexSet } from './indexes.ts';\n" + load + "\n")
        text = once(text, anchor, methods + "\n\n" + anchor)
        return text.rstrip("\n") + "\n\n" + reserved + "\n"

    edit("engine/src/model/model.ts", model)
