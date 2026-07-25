"""JSON renderer for table export. Pure over (model, definition, row keys,
cells) — no API imports, unlike `api/table_export.py`, which lives in the API
layer only because core stays xlsx-free. JSON needs no dependency at all, so
the whole thing is unit-testable against a plain `Model`.

Spec: docs/superpowers/specs/2026-07-25-table-json-export-design.md
"""

from __future__ import annotations

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import (
    NOT_COMPUTED_MESSAGE,
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)
from .schema import Column, TableDefinition


def resolve_json_keys(defn: TableDefinition) -> list[str | None]:
    """One JSON key per definition column, positionally aligned; `None` for a
    hidden column (evaluated, because a visible column may reference it, but
    never emitted).

    Derivation, in order: an explicit `json_export.key`, else the column
    `header`, else `"<kind>_<index>"`. On a collision the FIRST occurrence keeps
    the name and later ones take `_2`, `_3`, ... The map is GLOBAL rather than
    per nesting level so a column carries the same key wherever it appears in
    the document — a reader can then rely on one key meaning one column.

    A hidden column consumes no name: its key is never emitted, so reserving one
    would push a visible column onto a `_2` suffix for no reason.
    """
    out: list[str | None] = []
    used: set[str] = set()
    for i, col in enumerate(defn.columns):
        if col.hidden:
            out.append(None)
            continue
        opts = col.json_export
        base = (opts.key if opts is not None else "") or col.header or f"{col.kind}_{i}"
        key = base
        n = 2
        # Loop rather than a single suffix: the `_2` a collision produces can
        # itself collide with a literal "Mass_2" header earlier in the table.
        while key in used:
            key = f"{base}_{n}"
            n += 1
        used.add(key)
        out.append(key)
    return out


def _element_json(model: Model, eid: str, mode: str) -> object:
    """One element reference rendered per the column's `json_export.value`.

    A DANGLING id (the element was deleted between evaluation and render)
    yields an error marker rather than raising: the xlsx path tolerates the
    same case, and a whole export must not 500 over one stale reference.
    """
    el = model.elements.get(eid)
    if el is None:
        return {"$error": f"unknown element {eid}"}
    if mode == "id":
        return el.id
    if mode == "object":
        return {"id": el.id, "name": display_name(el), "type": el.type_name}
    return display_name(el)


def render_cell(model: Model, cell: Cell, mode: str) -> object:
    """One evaluated cell as a JSON-serializable value.

    Both "the type does not declare this property" and "declared but unset"
    render `null`: JSON has one absence, and the distinction the grid draws
    (greyed vs editable) is an editing affordance with no export meaning.

    A failed or uncomputed cell becomes `{"$error": ...}` rather than `null`.
    Nulling it would make a failure indistinguishable from an empty value for
    a programmatic consumer; the marker is the JSON analogue of the xlsx
    `#ERROR:` text, and it deliberately breaks type uniformity for that key.
    """
    if isinstance(cell, ValueCell):
        return None if not cell.present else cell.value
    if isinstance(cell, ValuesCell):
        # Always a list, length 1 included: a consumer must not have to
        # branch on arity to read a multi-source column.
        return list(cell.values)
    if isinstance(cell, ElementCell):
        return None if cell.element_id is None else _element_json(model, cell.element_id, mode)
    if isinstance(cell, ElementsCell):
        return [_element_json(model, e, mode) for e in cell.element_ids]
    if isinstance(cell, ErrorCell):
        return {"$error": cell.message}
    assert isinstance(cell, PendingCell)
    return {"$error": NOT_COMPUTED_MESSAGE}


def _mode_of(col: Column) -> str:
    return col.json_export.value if col.json_export is not None else "name"
