"""Pure table evaluator over (metamodel, model). REF-FREE: navigation refs must
be resolved before calling (the API layer does this via resolve_refs).

Rows are tuples of bindings (RowKey). `build_rows` evaluates the row source and
every expand column across the WHOLE table (expansion determines the total, so
it can't be page-local); it is guarded by `max_rows`. Cell evaluation (Task 5)
runs per page. See core/table/schema.py for the binding model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Union

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
            reached = _expand_values(mm, model, defn, col, key, roots, limits)
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
    defn: TableDefinition,
    col: Column,
    key: RowKey,
    roots: list[str],
    limits: TableLimits,
) -> list[Binding]:
    if isinstance(col, NavigationColumn):
        return list(_navigation_reached(mm, model, col, roots, limits))
    # PropertyColumn expand: one row per property value. Single-binding source
    # guaranteed by schema; missing/scalar handled in Task 5's helper.
    from .cells import expand_property_values  # type: ignore[import-not-found]  # Task 5

    return expand_property_values(mm, model, col, roots)
