"""``python -m tests.golden`` writes the fixtures; ``--check`` only compares."""

from __future__ import annotations

import sys

from .driver import FIXTURE_DIR, stale, write


def main(argv: list[str]) -> int:
    if "--check" in argv:
        names = stale()
        for name in names:
            print(f"stale: {FIXTURE_DIR / name}")
        return 1 if names else 0
    write()
    print(f"wrote golden fixtures to {FIXTURE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
