"""Per-cell evaluation. Core produces element IDS (not `TreeItem` — that is an
API-layer projection over the API's own tree-item shape); the route maps ids to
`TreeItem`. Cell kind is derived from column kind x mode x source arity:

| column     | mode     | source arity | cell                                    |
|------------|----------|---------------|-----------------------------------------|
| element    | n/a      | single        | `ElementCell`                           |
| property   | collapse | single        | `ValueCell` (editable iff declared)     |
| property   | collapse | many          | `ValuesCell` (read-only, joined)        |
| property   | expand   | single (req.) | `ValueCell` (read-only — see below)     |
| navigation | collapse | any           | `ElementsCell` (capped for display)     |
| navigation | expand   | single (req.) | `ElementCell` (one binding per row)     |

An `expand` column already promoted its value(s) into a `RowKey` slot back in
`build_rows` (Task 4) — one row per value. Re-deriving that slot's value here
(rather than re-navigating/re-reading the property) is what makes an expand
cell agree with the row it belongs to, including for `keep_empty` rows whose
slot is `None`. `_expand_slot_of` (the SAME helper `build_rows` and
`resolve_source_elements` use — there is exactly one slot-arithmetic
implementation, in `evaluate.py`) finds that slot from the column's own index.

`present`/`editable` for a (collapse, single-element) property cell:
- `present=False`: the source element's TYPE does not declare the property —
  greyed in the UI, never editable (there is nothing to edit).
- `present=True, value=None`: the type declares it but this element has not
  set it — editable (the user can fill it in).
- `editable` is `True` only when the source is single-binding, collapse mode,
  AND the property is present; an `expand` cell is never editable (its slot's
  value came from a promoted binding, not this row's single element in the
  sense the edit UI needs — editing it would mean editing a different row's
  worth of expansion), and a many-element collapse cell is a read-only joined
  view of everyone's values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from data_rover.core.script.embed import ScriptEvalContext

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.navigation.evaluate import PropertyValue

from .evaluate import (
    Binding,
    RowKey,
    TableLimits,
    _expand_slot_of,
    _navigation_reached,
    resolve_source_elements,
)
from .schema import (
    ElementColumn,
    NavigationColumn,
    PropertyColumn,
    ScriptColumn,
    TableDefinition,
)


@dataclass
class ElementCell:
    element_id: str | None


@dataclass
class ValueCell:
    present: bool
    value: object
    element_id: str | None
    editable: bool


@dataclass
class ValuesCell:
    present: bool
    values: list[object]
    total: int
    truncated: bool


@dataclass
class ElementsCell:
    element_ids: list[str]
    total: int
    truncated: bool


@dataclass
class ErrorCell:
    """A script cell that failed (snippet raised, timed out, budget spent,
    runner unavailable, dangling ref). `message` is short; `traceback` (guest
    frames only) rides along for hover detail. Sorts with empties (last)."""

    message: str
    traceback: str | None = None


@dataclass
class PendingCell:
    """A script cell whose value is not computed yet (cache-only miss, spec
    §4.2): a background sweep is filling it. Renders as a placeholder, never
    as an error; sorts with empties; exports as #ERROR only in the
    failed-sweep path (a completed sweep leaves no pending cells)."""


Cell = ElementCell | ValueCell | ValuesCell | ElementsCell | ErrorCell | PendingCell


def _prop_present(mm: Metamodel, type_name: str, prop: str) -> bool:
    return any(pd.name == prop for pd in mm.effective_element_properties(type_name))


def expand_property_values(
    model: Model, col: PropertyColumn, roots: list[str]
) -> list[Binding]:
    """Values an `expand` property column contributes for ONE row's roots.

    The schema guarantees an expand property column has a single-binding
    source, so `roots` holds at most one element id here.

    A single-valued (or undeclared) property is NOT an error: its scalar value
    expands to exactly one row, so mixed scopes (some types multi-valued, some
    single) and stale configs keep evaluating instead of 422-ing the whole
    table. The UI additionally greys the split toggle out when it can prove no
    scoped type is multi-valued — this is the tolerant evaluation half.
    """
    if not roots:
        return []
    eid = roots[0]
    el = model.elements[eid]
    raw = el.properties.get(col.name)
    if raw is None:
        return []
    return list(raw) if isinstance(raw, (list, tuple)) else [raw]


def _element_cell(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ElementColumn,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> ElementCell:
    els = resolve_source_elements(
        mm, model, defn, key, col.source, base_slots, limits, script=script
    )
    return ElementCell(element_id=els[0] if els else None)


def _property_cell(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: PropertyColumn,
    col_index: int,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> Cell:
    els = resolve_source_elements(
        mm, model, defn, key, col.source, base_slots, limits, script=script
    )
    if col.mode == "expand":
        # The value already sits in this row's key slot (build_rows promoted
        # it); read it back rather than re-deriving it, so a `keep_empty` row
        # (slot == None) and a genuine value agree with the row they're in.
        slot = _expand_slot_of(defn, base_slots, col_index)
        val = key[slot]
        eid = els[0] if els else None
        present = eid is not None and _prop_present(
            mm, model.elements[eid].type_name, col.name
        )
        return ValueCell(present=present, value=val, element_id=eid, editable=False)
    if not els:
        return ValueCell(present=False, value=None, element_id=None, editable=False)
    if len(els) == 1:
        eid = els[0]
        el = model.elements[eid]
        present = _prop_present(mm, el.type_name, col.name)
        val = el.properties.get(col.name) if present else None
        return ValueCell(present=present, value=val, element_id=eid, editable=present)
    # many-element collapse → joined read-only values (undeclared-on-some-types
    # elements simply contribute nothing, rather than failing the whole cell)
    vals: list[object] = []
    for eid in els:
        el = model.elements[eid]
        if not _prop_present(mm, el.type_name, col.name):
            continue
        v = el.properties.get(col.name)
        if isinstance(v, (list, tuple)):
            vals.extend(v)
        elif v is not None:
            vals.append(v)
    return ValuesCell(present=True, values=vals, total=len(vals), truncated=False)


def _navigation_cell(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: NavigationColumn,
    col_index: int,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> Cell:
    if col.mode == "expand":
        slot = _expand_slot_of(defn, base_slots, col_index)
        b = key[slot]
        if isinstance(b, PropertyValue):
            # The promoted binding is a scalar-property-step terminal: render
            # the VALUE (read-only — it belongs to the element the navigation
            # stepped through, not to this row's single source element).
            return ValueCell(
                present=True, value=b.value, element_id=None, editable=False
            )
        return ElementCell(element_id=b if isinstance(b, str) else None)
    roots = resolve_source_elements(
        mm, model, defn, key, col.source, base_slots, limits, script=script
    )
    reached = _navigation_reached(mm, model, col, roots, limits)
    # `cell_cap` is a per-column display preference; `max_cell_elements` is the
    # server-wide ceiling, so the effective cap is whichever is stricter. An
    # export sets `ignore_cell_caps` so the workbook carries the COMPLETE
    # reached set — a display preference must not drop exported data.
    cap = (
        limits.max_cell_elements
        if limits.ignore_cell_caps
        else min(col.cell_cap, limits.max_cell_elements)
    )
    if any(isinstance(n, PropertyValue) for n in reached):
        # The projected step is a scalar property step: the cell shows VALUES.
        # A mixed frontier (the same property name element-typed on one type,
        # scalar on another) degrades element nodes to their display names so
        # nothing silently drops.
        vals: list[object] = [
            n.value if isinstance(n, PropertyValue) else display_name(model.elements[n])
            for n in reached
        ]
        return ValuesCell(
            present=True,
            values=vals[:cap],
            total=len(vals),
            truncated=len(vals) > cap,
        )
    ids = [n for n in reached if isinstance(n, str)]
    return ElementsCell(element_ids=ids[:cap], total=len(ids), truncated=len(ids) > cap)


def _script_cell(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    col_index: int,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
) -> Cell:
    """Cell for one row of a `ScriptColumn`. `expand` reads back the binding
    `build_rows` already promoted into this row's key slot (never re-calls
    `value()`, mirroring `_navigation_cell`/`_property_cell`'s expand
    branches); `collapse` calls fresh (memoized by `script`, so this agrees
    bit-for-bit with any earlier collapse-filter/chaining call made against
    the same `(code, entry, roots)` during `build_rows_ex`)."""
    if col.mode == "expand":
        # The binding already sits in this row's key slot (build_rows promoted
        # it): PropertyValue = a returned scalar; str = a returned element id;
        # None = keep_empty row OR the single error row _expand_values left —
        # re-derive from the memoized call to tell the two apart.
        slot = _expand_slot_of(defn, base_slots, col_index)
        b = key[slot]
        if isinstance(b, PropertyValue):
            return ValueCell(
                present=True, value=b.value, element_id=None, editable=False
            )
        if isinstance(b, str):
            return ElementCell(element_id=b)
        if col.snippet.ref is not None:
            return ErrorCell(message=f"snippet artifact {col.snippet.ref!r} not found")
        if col.snippet.definition is not None and script is not None:
            roots = resolve_source_elements(
                mm, model, defn, key, col.source, base_slots, limits, script=script
            )
            if roots:
                # Force cache-only: the row shape is unknown here (this is a
                # re-derive, not the original build-time call), so a live call
                # could not change the single-row rendering anyway; recomputing
                # it live would also bypass sweep accounting.
                res = script.call(
                    col.snippet.definition.code, "value", roots, cache_only=True
                )
                if res.error is not None:
                    if res.error.kind == "pending":
                        return PendingCell()
                    return ErrorCell(
                        message=res.error.message, traceback=res.error.traceback
                    )
        return ValueCell(present=False, value=None, element_id=None, editable=False)

    if col.snippet.ref is not None:  # post-resolve: dangling ref
        return ErrorCell(message=f"snippet artifact {col.snippet.ref!r} not found")
    if col.snippet.definition is None:  # unconfigured ({}): empty, like an
        # unconfigured navigation/property source
        return ValueCell(present=False, value=None, element_id=None, editable=False)
    els = resolve_source_elements(
        mm, model, defn, key, col.source, base_slots, limits, script=script
    )
    if not els:
        return ValueCell(present=False, value=None, element_id=None, editable=False)
    if script is None:
        # Defensive: routes always supply a context when table_has_script().
        return ErrorCell(message="script runner unavailable")
    res = script.call(col.snippet.definition.code, "value", els)
    if res.error is not None:
        if res.error.kind == "pending":
            return PendingCell()
        return ErrorCell(message=res.error.message, traceback=res.error.traceback)
    p = res.value
    assert p is not None  # CallResult invariant: value xor error
    if p["kind"] == "scalar":
        if p["value"] is None:
            return ValueCell(present=False, value=None, element_id=None, editable=False)
        return ValueCell(
            present=True, value=p["value"], element_id=None, editable=False
        )
    if p["kind"] == "scalars":
        vals = p["values"]
        cap = limits.max_cell_elements
        return ValuesCell(
            present=True, values=vals[:cap], total=len(vals), truncated=len(vals) > cap
        )
    if p["kind"] == "element":
        eid = p["id"]
        return ElementCell(element_id=eid if eid in model.elements else None)
    ids = [i for i in dict.fromkeys(p["ids"]) if i in model.elements]
    cap = limits.max_cell_elements
    return ElementsCell(element_ids=ids[:cap], total=len(ids), truncated=len(ids) > cap)


def evaluate_cells(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    keys: list[RowKey],
    limits: TableLimits = TableLimits(),
    script: ScriptEvalContext | None = None,
) -> list[list[Cell]]:
    """Evaluate every cell for every row. Runs per page (unlike `build_rows`,
    which must see the whole table because expansion determines row count).

    `script` is the shared per-request `ScriptEvalContext` — `None` for
    callers with no script columns in play (every existing caller)."""
    expand_count = sum(
        1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
    )
    # Correct here (unlike mid-`build_rows`) because `keys` is the FULL,
    # already-built set: base_slots = total slots minus one per expand column.
    base_slots = (len(keys[0]) - expand_count) if keys else 1

    rows: list[list[Cell]] = []
    for key in keys:
        row: list[Cell] = []
        for i, col in enumerate(defn.columns):
            if isinstance(col, ElementColumn):
                row.append(
                    _element_cell(mm, model, defn, key, col, base_slots, limits, script)
                )
            elif isinstance(col, PropertyColumn):
                row.append(
                    _property_cell(
                        mm, model, defn, key, col, i, base_slots, limits, script
                    )
                )
            elif isinstance(col, ScriptColumn):
                row.append(
                    _script_cell(
                        mm, model, defn, key, col, i, base_slots, limits, script
                    )
                )
            else:
                # NavigationColumn — the last Column-union member.
                assert isinstance(col, NavigationColumn)
                row.append(
                    _navigation_cell(
                        mm, model, defn, key, col, i, base_slots, limits, script
                    )
                )
        rows.append(row)
    return rows
