"""Pure table evaluator over (metamodel, model). REF-FREE: navigation refs must
be resolved before calling (the API layer does this via resolve_refs).

Rows are tuples of bindings (RowKey). `build_rows` evaluates the row source and
every expand column across the WHOLE table (expansion determines the total, so
it can't be page-local); it is guarded by `max_rows`. Cell evaluation (Task 5)
runs per page. See core/table/schema.py for the binding model.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Union

if TYPE_CHECKING:
    from .cells import Cell

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import EvalLimits, evaluate

from .schema import (
    ChainRows,
    Column,
    ColumnSource,
    ElementColumn,
    NavigationColumn,
    NavigationRows,
    PropertyColumn,
    RowSlot,
    ScopeRows,
    TableDefinition,
)

Binding = Union[str, int, float, bool, None]
RowKey = tuple[Binding, ...]


@dataclass(frozen=True)
class TableLimits:
    max_rows: int = 50_000
    max_sort_rows: int = 20_000
    max_cell_elements: int = 20
    nav_limits: EvalLimits = field(default_factory=EvalLimits)


def _scope_row_keys(mm: Metamodel, model: Model, rs: ScopeRows) -> list[RowKey]:
    from data_rover.core.navigation.evaluate import _scope_ids  # reuse Stage 1
    from data_rover.core.navigation.schema import Scope

    scope = Scope(types=rs.types, criteria=rs.criteria)
    return [(eid,) for eid in _scope_ids(mm, model, scope)]


def _navigation_row_keys(
    mm: Metamodel, model: Model, rs: NavigationRows, limits: TableLimits
) -> list[RowKey]:
    defn = rs.navigation.definition
    assert defn is not None
    result = evaluate(mm, model, defn, limits.nav_limits)
    idx = rs.step_index if rs.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in result.chains:
        seen[chain[idx]] = None
    return [(eid,) for eid in seen]


def _chain_row_keys(
    mm: Metamodel, model: Model, rs: ChainRows, limits: TableLimits
) -> list[RowKey]:
    defn = rs.navigation.definition
    assert defn is not None
    result = evaluate(mm, model, defn, limits.nav_limits)
    return [tuple(chain) for chain in result.chains]


def _base_row_keys(
    mm: Metamodel, model: Model, defn: TableDefinition, limits: TableLimits
) -> list[RowKey]:
    rs = defn.row_source
    if isinstance(rs, ScopeRows):
        return _scope_row_keys(mm, model, rs)
    if isinstance(rs, NavigationRows):
        return _navigation_row_keys(mm, model, rs, limits)
    return _chain_row_keys(mm, model, rs, limits)


def _expand_slot_of(defn: TableDefinition, base_slots: int, col_index: int) -> int:
    """Key slot holding the binding produced by the expand column at
    `col_index`: base slots + the number of expand columns strictly before it.

    Correct for BOTH a fully-built key and a partial key mid-`build_rows`,
    because a column's source can only reference EARLIER columns (schema
    guarantee), so the referenced expand slot is always already present."""
    before = sum(
        1
        for i, c in enumerate(defn.columns)
        if i < col_index and getattr(c, "mode", "collapse") == "expand"
    )
    return base_slots + before


def resolve_source_elements(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    source: ColumnSource,
    base_slots: int,
    limits: TableLimits,
) -> list[str]:
    """Ordered element ids a column source resolves to for ONE row.

    `base_slots` is the number of leading row-source slots (1 for scope/nav; the
    chain length for chains) — passed explicitly because a partial key mid-build
    can't reveal it. A RowSlot reads key[chain_index]. A ColumnRef resolves per
    the referenced column: an element column passes its own source through; an
    EXPAND column (navigation or property) already put one binding per row, so we
    read that row's key slot directly (this is what makes source-from-another-cell
    row-correct); a COLLAPSE navigation column is re-evaluated from its source.
    """
    if isinstance(source, RowSlot):
        b = key[source.chain_index]
        return [b] if isinstance(b, str) else []
    ref_col = defn.columns[source.index]
    if getattr(ref_col, "mode", "collapse") == "expand":
        b = key[_expand_slot_of(defn, base_slots, source.index)]
        return [b] if isinstance(b, str) else []
    if ref_col.kind == "element":
        return resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits
        )
    if ref_col.kind == "navigation":
        roots = resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits
        )
        return _navigation_reached(mm, model, ref_col, roots, limits)
    return []  # property columns are not element-producing (schema rejects this)


def _navigation_reached(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
) -> list[str]:
    defn = col.navigation.definition
    assert defn is not None
    if not roots:
        return []
    result = evaluate(mm, model, defn, limits.nav_limits, row_elements=roots)
    idx = col.step_index if col.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in result.chains:
        seen[chain[idx]] = None
    return list(seen)


def _row_source_base_slots(defn: TableDefinition, base_keys: list[RowKey]) -> int:
    """1 for scope/navigation; the chain length for chains (read off any key)."""
    if defn.row_source.kind != "chains":
        return 1
    return len(base_keys[0]) if base_keys else 1


def build_rows(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    limits: TableLimits = TableLimits(),
) -> tuple[list[RowKey], bool]:
    keys = _base_row_keys(mm, model, defn, limits)
    base_slots = _row_source_base_slots(defn, keys)
    truncated = False
    # apply each expand column in declaration order, extending the key tuple
    for col in defn.columns:
        if isinstance(col, ElementColumn) or col.mode != "expand":
            continue
        new_keys: list[RowKey] = []
        for key in keys:
            roots = resolve_source_elements(
                mm, model, defn, key, col.source, base_slots, limits
            )
            reached = _expand_values(mm, model, col, roots, limits)
            if not reached:
                if col.keep_empty:
                    new_keys.append((*key, None))
            else:
                for v in reached:
                    new_keys.append((*key, v))
            if len(new_keys) > limits.max_rows:
                truncated = True
                new_keys = new_keys[: limits.max_rows]
                break
        keys = new_keys
        if truncated:
            break
    if len(keys) > limits.max_rows:
        keys = keys[: limits.max_rows]
        truncated = True
    return keys, truncated


def _expand_values(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn | PropertyColumn,
    roots: list[str],
    limits: TableLimits,
) -> list[Binding]:
    if isinstance(col, NavigationColumn):
        return list(_navigation_reached(mm, model, col, roots, limits))
    # PropertyColumn expand: one row per property value. Single-binding source
    # guaranteed by schema; missing/scalar handled by cells.expand_property_values.
    # Function-local import: cells.py imports FROM evaluate.py (resolve_source_
    # elements, _expand_slot_of, ...), so a module-level import here would cycle.
    from .cells import expand_property_values

    return expand_property_values(mm, model, col, roots)


# ---- sorting (Task 6) --------------------------------------------------------
#
# Missing/empty values ALWAYS sort last, in BOTH directions — not the usual
# nulls-first-on-desc SQL behaviour. `_sort_value` returns an `(is_empty,
# comparable)` pair; `order_rows` partitions decorated rows into non-empty vs
# empty, sorts (with `reverse=`) only the non-empty partition, then appends the
# empty partition unsorted (in `build_rows`' own deterministic order, since
# Python's sort is stable and we never touch that partition). This is simpler
# and cheaper than sentinel-value tricks that have to fight `reverse=True`.
#
# A binding column (the element column, or ANY `expand` column) already has its
# value sitting in the RowKey — sorting it is O(n log n) with no extra model
# work. A COLLAPSE navigation/property column has no such slot: sorting it means
# re-resolving + re-navigating/re-reading a property for every row, so it is
# guarded by `TableLimits.max_sort_rows` and raises `SortTooLargeError` (a
# `ValueError` subclass, so the API route's blanket `except ValueError` maps it
# to 422) rather than silently doing unbounded work.


class SortTooLargeError(ValueError):
    """A COLLAPSE navigation/property sort column would need a full extra
    evaluation pass over more rows than `TableLimits.max_sort_rows` allows.
    Never raised for a binding column (element / any `expand` column) — those
    sort straight off the already-built `RowKey` regardless of row count."""


@dataclass(frozen=True)
class SortSpec:
    column: int
    direction: Literal["asc", "desc"]


def _display_name(model: Model, eid: str) -> str:
    """The label used to order elements: their `name` property if set, else
    their id (so ordering is still total and deterministic)."""
    el = model.elements[eid]
    name = el.properties.get("name")
    return str(name) if name is not None else el.id


def _property_is_numeric(
    mm: Metamodel, defn: TableDefinition, col: PropertyColumn
) -> bool:
    """True only if EVERY scoped type declaring `col.name` gives it an
    integer/float datatype — a single conflicting type falls back to casefold
    string sort so mixed-type tables never silently misorder.

    Only meaningful for a `scope` row source, where the candidate type set is
    known upfront; a navigation/chain row source has no such fixed set (the
    reached elements can be of any type), so property sort there is always
    string, per spec."""
    if defn.row_source.kind != "scope":
        return False
    declaring = [
        pd.datatype
        for t in defn.row_source.types
        for pd in mm.effective_element_properties(t)
        if pd.name == col.name
    ]
    return bool(declaring) and all(dt in ("integer", "float") for dt in declaring)


def _needs_full_eval(col: Column) -> bool:
    """A COLLAPSE navigation/property column has no value already sitting in
    the RowKey, so sorting it means a full extra evaluation pass (guarded by
    `max_sort_rows`). An element column, or any `expand` column (its value was
    already promoted into a key slot by `build_rows`), is a cheap binding sort."""
    return col.kind != "element" and getattr(col, "mode", "collapse") != "expand"


def _sort_value(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: Column,
    col_index: int,
    base_slots: int,
    limits: TableLimits,
) -> tuple[int, Any]:
    """`(is_empty, comparable)` for one row's sort column. `is_empty=1` always
    sorts last (see `order_rows`); the comparable half is only ever compared
    within its own empty/non-empty partition (and always against another row's
    SAME column, so its concrete shape — str/int/tuple — is consistent within
    one `order_rows` call even though it varies across column kinds; typed
    `Any` here rather than a comparable-union so `list.sort` accepts the key).

    An `expand` property/navigation column reads its value straight back out of
    the RowKey slot `build_rows` already promoted it into (same trick as
    `cells.py`'s `_expand_slot_of` use) — re-deriving it via
    resolve_source_elements/re-navigation would collapse every row sharing the
    same root back onto that root's WHOLE reached set, losing the per-row value
    that made it a binding column in the first place."""
    if isinstance(col, ElementColumn):
        els = resolve_source_elements(
            mm, model, defn, key, col.source, base_slots, limits
        )
        if not els:
            return (1, "")
        return (0, (_display_name(model, els[0]).casefold(), els[0]))
    if isinstance(col, PropertyColumn):
        numeric = _property_is_numeric(mm, defn, col)
        if col.mode == "expand":
            v = key[_expand_slot_of(defn, base_slots, col_index)]
            if v is None:
                return (1, ())
            return (0, (float(v),)) if numeric else (0, (str(v).casefold(),))  # type: ignore[arg-type]
        els = resolve_source_elements(
            mm, model, defn, key, col.source, base_slots, limits
        )
        vals: list[Binding] = []
        for eid in els:
            v = model.elements[eid].properties.get(col.name)
            if v is None:
                continue
            vals.extend(v if isinstance(v, list) else [v])
        if not vals:
            return (1, ())
        if numeric:
            return (0, tuple(float(v) for v in vals))  # type: ignore[arg-type]
        return (0, tuple(str(v).casefold() for v in vals))
    # NavigationColumn. `expand` already put ONE reached element per row into
    # the RowKey (read it straight back); COLLAPSE needs a full re-navigation.
    # `value` sorts on the tuple of reached display names (name-sorted, so two
    # rows with the same multiset of reached names compare equal regardless of
    # discovery order); `count` sorts on cardinality.
    if col.mode == "expand":
        b = key[_expand_slot_of(defn, base_slots, col_index)]
        if not isinstance(b, str):
            return (1, "")
        return (0, (_display_name(model, b).casefold(), b))
    roots = resolve_source_elements(
        mm, model, defn, key, col.source, base_slots, limits
    )
    reached = _navigation_reached(mm, model, col, roots, limits)
    if not reached:
        return (1, 0 if col.sort_mode == "count" else ())
    if col.sort_mode == "count":
        return (0, len(reached))
    return (0, tuple(sorted(_display_name(model, e).casefold() for e in reached)))


def order_rows(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    keys: list[RowKey],
    sort: SortSpec | None,
    limits: TableLimits = TableLimits(),
) -> list[RowKey]:
    """Stable-sort `keys` by one column; `sort=None` returns a new list in the
    input order. Missing/empty values sort last in BOTH directions (see the
    module docstring above `_sort_value`). Ties fall back to `build_rows`' own
    deterministic order, since Python's sort is stable — giving a total order
    without needing every value to be independently unique.

    `base_slots` is derived from the FULL key set exactly as in
    `evaluate_cells` (Task 5): `keys` here is always the complete, already-built
    row set (never a partial key mid-`build_rows`), so `len(keys[0])` minus one
    slot per `expand` column recovers the row-source's own slot count."""
    if sort is None:
        return list(keys)
    col = defn.columns[sort.column]
    if _needs_full_eval(col) and len(keys) > limits.max_sort_rows:
        raise SortTooLargeError(
            f"sorting {len(keys)} rows by a computed column exceeds "
            f"max_sort_rows={limits.max_sort_rows}"
        )
    expand_count = sum(
        1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
    )
    base_slots = (len(keys[0]) - expand_count) if keys else 1
    decorated: list[tuple[int, Any, RowKey]] = [
        (*_sort_value(mm, model, defn, k, col, sort.column, base_slots, limits), k)
        for k in keys
    ]
    # empties always last, in BOTH directions: partition first, sort (with
    # `reverse=`) only the non-empty half, then append the empty half untouched.
    non_empty = [d for d in decorated if d[0] == 0]
    empty = [d for d in decorated if d[0] == 1]
    non_empty.sort(key=lambda d: d[1], reverse=(sort.direction == "desc"))
    return [d[2] for d in non_empty] + [d[2] for d in empty]


# ---- export (Task 10) --------------------------------------------------------
#
# The interactive route (`/tables/evaluate`) evaluates one PAGE of `keys` at a
# time; export needs the WHOLE (already built+ordered) row set, which can be up
# to `max_rows` long. `iter_export_rows` re-slices `keys` into `chunk`-sized
# windows and evaluates each through the SAME `evaluate_cells` the page route
# uses, so export cells agree with interactive cells bit-for-bit (module-local
# import of `.cells`, matching the existing `_expand_values` pattern in this
# file: `cells.py` imports FROM `evaluate.py`, so a module-level import here
# would cycle). This is a generator purely to bound peak memory for a large
# export — it does NOT change what gets exported (the caller still owns the
# full, uncapped `TableLimits` used for every chunk). Core stays xlsx-free:
# this function only orchestrates cell evaluation, never touches openpyxl —
# the writer lives in `api/table_export.py`.


def iter_export_rows(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    keys: list[RowKey],
    limits: TableLimits = TableLimits(),
    chunk: int = 1000,
) -> Iterator[list["Cell"]]:
    """Yield evaluated cell rows for `keys`, in order, `chunk` rows at a time."""
    from .cells import evaluate_cells

    for i in range(0, len(keys), chunk):
        yield from evaluate_cells(mm, model, defn, keys[i : i + chunk], limits)
