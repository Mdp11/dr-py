"""xlsx writer for table export. Lives in the API layer (core stays xlsx-free).
Consumes core cell dataclasses and produces workbook bytes.

xlsxwriter in normal mode, NOT the old openpyxl write-only streaming:
`worksheet.autofit()` needs the whole sheet's cell data to measure
(xlsxwriter itself warns and no-ops in `constant_memory` mode, and openpyxl
has no working autofit at all — its `bestFit` flag is ignored by Excel). The
bounded-peak-memory property the old streaming builder had is consciously
traded away for the export path (spec:
docs/superpowers/specs/2026-07-24-table-panel-polish-pack-design.md, item 11);
`iter_export_rows` still feeds this chunk-by-chunk, xlsxwriter accumulates.
This trade-off is about `constant_memory` only — the `Workbook` options below
deliberately do NOT set `in_memory`, which is an orthogonal knob controlling
whether generated worksheet XML is buffered in RAM or spilled to temp files;
setting it `True` would stack a second full sheet copy on top of what
autofit already forces, for no benefit `constant_memory` doesn't already
give up.

openpyxl remains a test-suite dependency (it READS workbooks back; xlsxwriter
is write-only).
"""

from __future__ import annotations

import io
from collections.abc import Callable, Iterable

import xlsxwriter  # type: ignore[import-untyped]

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.table.cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)

#: Autofit cap, in pixels (~43 characters): one huge cell must not blow a
#: column out to an unusable width. Excel's own hard cap is 1790px.
AUTOFIT_MAX_PX = 300

#: xlsx forbids these in a sheet name; the old openpyxl builder let them
#: bubble up as a 422 (`ValueError`), xlsxwriter would raise a non-ValueError
#: and 500 — sanitizing is strictly kinder than either.
_INVALID_SHEET_CHARS = set("[]:*?/\\")


def _sheet_title(name: str) -> str:
    cleaned = "".join("_" if ch in _INVALID_SHEET_CHARS else ch for ch in name)
    # Truncate BEFORE stripping leading/trailing apostrophes: stripping first
    # then truncating can leave a 31-char name ending in "'" (e.g. when char
    # 32 of the original was itself an apostrophe), which xlsxwriter rejects
    # with InvalidWorksheetName — NOT a ValueError, so the route's
    # `except (NavigationResolveError, ValueError)` misses it and the request
    # 500s instead of the 422 this helper exists to guarantee.
    return cleaned[:31].strip("'") or "Table"


def _display(model: Model, eid: str) -> str:
    # shared case-insensitive `name` lookup — same label the grid displays
    return display_name(model.elements[eid])


def _cell_text(model: Model, cell: Cell) -> object:
    """Map one core cell dataclass to the xlsx value it should render as."""
    if isinstance(cell, ElementCell):
        return _display(model, cell.element_id) if cell.element_id else ""
    if isinstance(cell, ValueCell):
        return "" if not cell.present or cell.value is None else cell.value
    if isinstance(cell, ValuesCell):
        return "; ".join(str(v) for v in cell.values)
    if isinstance(cell, ErrorCell):
        return f"#ERROR: {cell.message}"
    if isinstance(cell, PendingCell):
        # Only reachable when exporting after a FAILED sweep (Task 8): a
        # completed sweep leaves no pending cells, so this path is a
        # last-resort rendering rather than an expected export outcome.
        return "#ERROR: not computed"
    assert isinstance(cell, ElementsCell)
    return "; ".join(_display(model, e) for e in cell.element_ids)


def build_workbook(
    model: Model,
    headers: list[str],
    sheet_name: str,
    row_iter: Iterable[list[Cell]],
    *,
    notice_provider: Callable[[], str | None] | None = None,
    row_number_col: int | None = None,
) -> bytes:
    """Render `row_iter` into a single-sheet workbook: bold bordered header
    row with filter dropdowns and frozen panes, thin borders on every data
    cell, and column widths autofitted to content (capped at
    `AUTOFIT_MAX_PX`; definition `width_px` values are deliberately ignored —
    on-screen widths are a display preference, the export always autofits).

    `notice_provider`, if given, is called AFTER `row_iter` is fully consumed
    (not before) — callers whose "should there be a notice" flag only settles
    once every lazily-evaluated cell has been visited (e.g. a script column's
    error flag) must defer that decision to this point rather than computing
    it up front. A truthy return appends one trailing single-cell row, OUTSIDE
    the autofilter range (a notice is not a data row to filter on).

    `row_number_col`, if given, is the OUTPUT COLUMN INDEX at which a 1-based
    row number is written. It is a position rather than a prepend flag because
    the export settings let the user drag the row-number entry anywhere in the
    column list. `headers` must already carry that column's header at this
    index, and each row from `row_iter` therefore carries one FEWER cell than
    `headers` has entries. Numbering follows export row order, which follows
    the requested sort."""
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(
        buf,
        {
            # Model property values are untrusted content. xlsxwriter's
            # defaults would otherwise (a) route any string matching
            # `^(ftp|http)s?://`/`mailto:`/`file://`/`(in|ex)ternal:` through
            # its hyperlink writer, which SILENTLY WRITES NOTHING (only a
            # discarded `warnings.warn`) past 65,530 URL cells per sheet or
            # for a URL longer than 2079 chars — a real reachable case at
            # this export's 50,000-row x 50-col ceiling — and (b) turn a
            # value starting with "=" into a live formula.
            "strings_to_urls": False,
            "strings_to_formulas": False,
        },
    )
    ws = wb.add_worksheet(_sheet_title(sheet_name))
    header_fmt = wb.add_format({"bold": True, "border": 1, "bottom": 2})
    cell_fmt = wb.add_format({"border": 1})

    for col, h in enumerate(headers):
        ws.write(0, col, h, header_fmt)
    ws.freeze_panes(1, 0)

    r = 0
    for r, row in enumerate(row_iter, start=1):
        cells = iter(row)
        for col in range(len(headers)):
            if col == row_number_col:
                ws.write_number(r, col, r, cell_fmt)
            else:
                ws.write(r, col, _cell_text(model, next(cells)), cell_fmt)

    if headers:
        ws.autofilter(0, 0, r, len(headers) - 1)

    # autofit measures whatever has been written so far, so it must run
    # BEFORE the notice row: the notice text (~130 chars) is not data and
    # must not drive column A's width to the AUTOFIT_MAX_PX cap regardless
    # of column A's actual content.
    ws.autofit(AUTOFIT_MAX_PX)

    if notice_provider is not None:
        text = notice_provider()
        if text:
            # Column 0 regardless of where the row-number column landed: a
            # notice is not a data row, so it always starts at the sheet's
            # left edge.
            ws.write(r + 1, 0, text)

    wb.close()
    return buf.getvalue()
