"""CSV renderer for table export. Pure over (model, headers, rows) — the CSV
sibling of `api/table_export.py`'s xlsx writer, sharing its cell display text
through `core/table/cell_text.py` so the two formats cannot drift (spec §6).

Machine-consumer stance: UTF-8, NO BOM (Excel is what the xlsx format is
for), stdlib `excel` dialect (RFC-4180 quoting, CRLF row terminator). No
trailing notice row — to a CSV parser a notice would be one more data row;
degradation is signalled by `#ERROR:` cell text and the response headers.

Spec: docs/superpowers/specs/2026-08-19-custom-export-v2-design.md §6
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable

from data_rover.core.model.model import Model

from .cell_text import cell_text
from .cells import Cell


def render_csv(
    model: Model,
    headers: list[str],
    row_iter: Iterable[list[Cell]],
    *,
    row_number_col: int | None = None,
) -> bytes:
    """Mirror of `build_workbook`'s row contract, minus workbook chrome:
    `headers` already carries the row-number column's header when
    `row_number_col` is given, and each row from `row_iter` then carries one
    FEWER cell than `headers` has entries. Both a `row_number_col` outside
    `headers`' range and a row length mismatch raise `ValueError` — callers
    (`table_export_engine` via the routes) map it to a 422, exactly like the
    xlsx writer's identical checks."""
    if row_number_col is not None and not 0 <= row_number_col < len(headers):
        raise ValueError(
            f"row_number_col={row_number_col} is out of range for "
            f"{len(headers)} header(s)"
        )
    expected_len = len(headers) - (1 if row_number_col is not None else 0)
    buf = io.StringIO()
    writer = csv.writer(buf, dialect="excel")
    writer.writerow(headers)
    for r, row in enumerate(row_iter, start=1):
        if len(row) != expected_len:
            raise ValueError(
                f"row {r} has {len(row)} cell(s), expected {expected_len} "
                f"for {len(headers)} header(s) with row_number_col="
                f"{row_number_col!r}"
            )
        cells = iter(row)
        out: list[object] = []
        for col in range(len(headers)):
            out.append(r if col == row_number_col else cell_text(model, next(cells)))
        writer.writerow(out)
    return buf.getvalue().encode("utf-8")
