"""The engine sources derived from Python's tables and xlsxwriter must be what
``scripts/engine_tables.py`` writes today."""

from __future__ import annotations

import subprocess
import sys

from tests.golden.reader import ROOT


def test_generated_engine_sources_are_current() -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "engine_tables.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, (
        f"run `pixi run -e core-dev python scripts/engine_tables.py` and commit the result:\n{proc.stdout}"
    )
