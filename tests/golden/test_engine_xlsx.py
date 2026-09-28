"""The engine's committed sample workbook, opened by openpyxl, holds the grid
the oracle recorded for the same export."""

from __future__ import annotations

import json
from typing import Any

from tests.golden.driver import FIXTURE_DIR, ROOT
from tests.golden.model_steps import _grid

SAMPLE = ROOT / "engine" / "fixtures" / "xlsx" / "sample.xlsx"
CASE = "xlsx_types"


def _recorded() -> Any:
    doc = json.loads((FIXTURE_DIR / "export_bytes.json").read_text(encoding="utf-8"))
    (step,) = [step for step in doc["steps"] if step.get("case") == CASE]
    return step["result"]["file"]["xlsx"]


def test_openpyxl_reads_the_engine_sample_as_the_oracle_recorded() -> None:
    assert SAMPLE.is_file(), "run `npm run xlsx-sample` in engine/"
    # As text, so an int read back where the oracle's was a float fails.
    assert json.dumps(_grid(SAMPLE.read_bytes())) == json.dumps(_recorded())
