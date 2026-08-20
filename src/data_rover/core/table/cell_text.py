"""Display-text rendering for exported cells, shared by the xlsx writer
(`api/table_export.py`) and the CSV renderer (`core/table/csv_export.py`) so
the two formats cannot drift (spec §6 of the Exporter v2 design). Moved
verbatim out of the xlsx writer — plain cell-to-text is core's business;
only the xlsx machinery around it needs the API layer.
"""

from __future__ import annotations

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)


def _display(model: Model, eid: str) -> str:
    # shared case-insensitive `name` lookup — same label the grid displays
    return display_name(model.elements[eid])


def cell_text(model: Model, cell: Cell) -> object:
    """Map one core cell dataclass to the display value it should render as."""
    if isinstance(cell, ElementCell):
        return _display(model, cell.element_id) if cell.element_id else ""
    if isinstance(cell, ValueCell):
        return "" if not cell.present or cell.value is None else cell.value
    if isinstance(cell, ValuesCell):
        return "; ".join(str(v) for v in cell.values)
    if isinstance(cell, ErrorCell):
        return f"#ERROR: {cell.message}"
    if isinstance(cell, PendingCell):
        # Only reachable when exporting after a FAILED sweep: a completed
        # sweep leaves no pending cells, so this path is a last-resort
        # rendering rather than an expected export outcome.
        return "#ERROR: not computed"
    assert isinstance(cell, ElementsCell)
    return "; ".join(_display(model, e) for e in cell.element_ids)
