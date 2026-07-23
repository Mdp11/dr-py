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
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from data_rover.core.script.embed import ScriptEvalContext

    from .cells import Cell

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.navigation.evaluate import (
    EvalLimits,
    PropertyValue,
    evaluate,
)

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
    ScriptColumn,
    TableDefinition,
)

#: One row-key slot. `PropertyValue` appears when a chains row source or an
#: expand navigation column ends in a scalar property step — the promoted
#: binding is the VALUE terminal, kept wrapped so a string value can never be
#: mistaken for an element id (RowSlot/ColumnRef reads gate on `isinstance(b,
#: str)`). Row keys never leave the process (cells are what serialize), so the
#: wrapper is safe to carry here.
Binding = str | int | float | bool | None | PropertyValue
RowKey = tuple[Binding, ...]


@dataclass(frozen=True)
class TableLimits:
    max_rows: int = 50_000
    max_cell_elements: int = 20
    #: Export-only: ignore each navigation column's per-column `cell_cap`
    #: display preference so a cell carries its COMPLETE reached set (bounded
    #: only by `max_cell_elements`). The interactive page path leaves this off.
    ignore_cell_caps: bool = False
    nav_limits: EvalLimits = field(default_factory=EvalLimits)


def _check_step_index(idx: int, chain_len: int) -> None:
    """Reject an out-of-range step index with a ValueError (the API maps it to
    422) instead of letting a raw IndexError escape as a 500. Python-style
    negative indexing is deliberate — the default is -1, "the last step"."""
    if not -chain_len <= idx < chain_len:
        raise ValueError(
            f"step_index {idx} out of range for a chain of {chain_len} steps"
        )


def _scope_row_keys(mm: Metamodel, model: Model, rs: ScopeRows) -> list[RowKey]:
    from data_rover.core.navigation.evaluate import _scope_ids  # reuse Stage 1
    from data_rover.core.navigation.schema import Scope

    scope = Scope(types=rs.types, criteria=rs.criteria)
    return [(eid,) for eid in _scope_ids(mm, model, scope)]


def _navigation_row_keys(
    mm: Metamodel,
    model: Model,
    rs: NavigationRows,
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> tuple[list[RowKey], bool]:
    """(row keys, navigation-truncated). The second half matters: a navigation
    that hit its own `max_chains`/`max_visited` budget yields an INCOMPLETE row
    set even though `build_rows`' `max_rows` check never fires — swallowing it
    would let the API report `truncated: false` over missing rows."""
    defn = rs.navigation.definition
    if defn is None:  # unconfigured ({}) source: no rows, nothing truncated
        return [], False
    result = evaluate(mm, model, defn, limits.nav_limits, script=script)
    idx = rs.step_index if rs.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in result.chains:
        _check_step_index(idx, len(chain))
        node = chain[idx]
        # Rows are ELEMENTS: a PropertyValue terminal at the projected step
        # cannot seed a row (nothing downstream could resolve it).
        if isinstance(node, str):
            seen[node] = None
    return [(eid,) for eid in seen], result.truncated


def _chain_row_keys(
    mm: Metamodel,
    model: Model,
    rs: ChainRows,
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> tuple[list[RowKey], bool]:
    defn = rs.navigation.definition
    if defn is None:  # unconfigured ({}) source: no rows, nothing truncated
        return [], False
    result = evaluate(mm, model, defn, limits.nav_limits, script=script)
    # Chains may end in a PropertyValue terminal; it rides along as a RowKey
    # slot (see Binding) so a RowSlot column can never misread it as an id.
    keys: list[RowKey] = [tuple(chain) for chain in result.chains]
    return keys, result.truncated


def _base_row_keys(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> tuple[list[RowKey], bool]:
    rs = defn.row_source
    if isinstance(rs, ScopeRows):
        return _scope_row_keys(mm, model, rs), False
    if isinstance(rs, NavigationRows):
        return _navigation_row_keys(mm, model, rs, limits, script=script)
    return _chain_row_keys(mm, model, rs, limits, script=script)


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
    script: ScriptEvalContext | None = None,
) -> list[str]:
    """Ordered element ids a column source resolves to for ONE row.

    `base_slots` is the number of leading row-source slots (1 for scope/nav; the
    chain length for chains) — passed explicitly because a partial key mid-build
    can't reveal it. A RowSlot reads key[chain_index]. A ColumnRef resolves per
    the referenced column: an element column passes its own source through; an
    EXPAND column (navigation or property) already put one binding per row, so we
    read that row's key slot directly (this is what makes source-from-another-cell
    row-correct); a COLLAPSE navigation column is re-evaluated from its source.

    A ColumnRef with `step_index` set overrides ALL of the above for a
    navigation-column reference: instead of the referenced column's own
    projected step, it re-navigates from the referenced column's OWN source
    and reads the requested chain step. Off an `expand` navigation column this
    row is pinned to one projected element (read back from the expand slot),
    so only chains whose projection matches it contribute — otherwise a
    step-index cell would mix in other rows' chains.

    `script` is the shared per-request `ScriptEvalContext` (memoized calls,
    one budget) — required to resolve a COLLAPSE script column as a source,
    AND threaded through to every navigation `evaluate()` call this function
    reaches (directly or via `_navigation_reached`/`_navigation_step_elements`)
    so a `ScriptStep` inside that navigation can run too; `None` (the default,
    for callers with no script work in play) makes a script-column reference
    resolve to nothing (same as an unconfigured snippet) and makes any
    `ScriptStep` inside a reached navigation prune silently (same as an
    unconfigured navigation source).
    """
    if isinstance(source, RowSlot):
        # Static validation only pins chain_index for NON-chains row sources;
        # against a chains source the upper bound is the resolved chain length,
        # only knowable here. ValueError (not IndexError) so the API 422s.
        if source.chain_index >= base_slots:
            raise ValueError(
                f"chain_index {source.chain_index} out of range "
                f"(row source has {base_slots} slots)"
            )
        b = key[source.chain_index]
        return [b] if isinstance(b, str) else []
    ref_col = defn.columns[source.index]
    if ref_col.kind == "navigation" and source.step_index is not None:
        # Step-override reference: re-evaluate the navigation and read the
        # requested chain step. Off an EXPAND column the row is pinned to one
        # projected element, so only chains projecting to it count.
        roots = resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits, script=script
        )
        match: str | None = None
        if ref_col.mode == "expand":
            b = key[_expand_slot_of(defn, base_slots, source.index)]
            if not isinstance(b, str):
                return []
            match = b
        return _navigation_step_elements(
            mm,
            model,
            ref_col,
            roots,
            limits,
            step=source.step_index,
            match_projected=match,
            script=script,
        )
    if getattr(ref_col, "mode", "collapse") == "expand":
        b = key[_expand_slot_of(defn, base_slots, source.index)]
        return [b] if isinstance(b, str) else []
    if ref_col.kind == "element":
        return resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits, script=script
        )
    if ref_col.kind == "navigation":
        roots = resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits, script=script
        )
        reached = _navigation_reached(mm, model, ref_col, roots, limits, script=script)
        # element-producing by contract: PropertyValue terminals contribute none
        return [n for n in reached if isinstance(n, str)]
    if ref_col.kind == "script":
        # Collapse script column as a source: evaluate (memoized) and bind the
        # returned ELEMENT ids; scalar results bind nothing (runtime-tolerant
        # arity — see schema._source_arity). Expand script columns never reach
        # here: the generic expand-slot read above already returned.
        if ref_col.snippet.definition is None or script is None:
            return []
        roots = resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits, script=script
        )
        if not roots:
            return []
        res = script.call(ref_col.snippet.definition.code, "value", roots)
        if res.error is not None or res.value is None:
            return []
        p = res.value
        if p["kind"] == "element":
            return [p["id"]] if p["id"] in model.elements else []
        if p["kind"] == "elements":
            return [i for i in dict.fromkeys(p["ids"]) if i in model.elements]
        return []
    return []  # property columns are not element-producing (schema rejects this)


def _navigation_reached_ex(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> tuple[list[str | PropertyValue], bool]:
    """(reached nodes, navigation-truncated) — the flag is consumed by
    `build_rows`' expand loop; display-only callers use `_navigation_reached`.
    Nodes are element ids, except `PropertyValue` terminals when the projected
    step is a scalar property step — the cell layer renders those as VALUES
    (ValuesCell/ValueCell); callers that need elements filter on
    `isinstance(node, str)`.

    `script` backs a `ScriptStep` inside `col`'s navigation the same way it
    backs a `ScriptColumn` — see `resolve_source_elements`'s docstring."""
    defn = col.navigation.definition
    if defn is None:  # unconfigured ({}) column: reaches nothing
        return [], False
    if not roots:
        return [], False
    result = evaluate(mm, model, defn, limits.nav_limits, row_elements=roots, script=script)
    idx = col.step_index if col.step_index is not None else -1
    seen: dict[str | PropertyValue, None] = {}
    for chain in result.chains:
        _check_step_index(idx, len(chain))
        seen[chain[idx]] = None
    return list(seen), result.truncated


def _navigation_reached(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> list[str | PropertyValue]:
    return _navigation_reached_ex(mm, model, col, roots, limits, script=script)[0]


def _navigation_step_elements(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
    *,
    step: int,
    match_projected: str | None,
    script: ScriptEvalContext | None = None,
) -> list[str]:
    """Elements at chain step `step` of `col`'s navigation, evaluated from
    `roots`. With `match_projected` set (the expand-column case) only chains
    whose OWN projection — the column's `step_index` — equals it contribute,
    keeping the reference row-correct. Mirrors `_navigation_reached_ex`'s
    dedup-preserving-order and its ValueError-on-out-of-range (API → 422)."""
    defn = col.navigation.definition
    if defn is None or not roots:
        return []
    result = evaluate(mm, model, defn, limits.nav_limits, row_elements=roots, script=script)
    proj = col.step_index if col.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in result.chains:
        _check_step_index(step, len(chain))
        if match_projected is not None:
            _check_step_index(proj, len(chain))
            if chain[proj] != match_projected:
                continue
        node = chain[step]
        # element-producing by contract: skip PropertyValue terminals
        if isinstance(node, str):
            seen[node] = None
    return list(seen)


def _row_source_base_slots(defn: TableDefinition, base_keys: list[RowKey]) -> int:
    """1 for scope/navigation; the chain length for chains (read off any key)."""
    if defn.row_source.kind != "chains":
        return 1
    return len(base_keys[0]) if base_keys else 1


@dataclass(frozen=True)
class RowBuild:
    keys: list[RowKey]
    truncated: bool
    #: Rows the row source produced BEFORE expand columns multiplied them and
    #: before collapse keep_empty filtering dropped any — for a scope source,
    #: the scope size. The UI shows it next to `len(keys)` so a split table
    #: reads "N elements -> M rows".
    base_total: int


def build_rows(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    limits: TableLimits = TableLimits(),
    script: ScriptEvalContext | None = None,
) -> tuple[list[RowKey], bool]:
    """(row keys, truncated) — thin compatibility wrapper over `build_rows_ex`
    for callers that don't need `base_total`."""
    result = build_rows_ex(mm, model, defn, limits, script=script)
    return result.keys, result.truncated


def build_rows_ex(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    limits: TableLimits = TableLimits(),
    script: ScriptEvalContext | None = None,
) -> RowBuild:
    """Full row build. `truncated` is set when the row set is INCOMPLETE for
    any reason: `max_rows` was hit, OR an underlying navigation (row source /
    expand column) hit its own `max_chains`/`max_visited` budget and silently
    produced fewer chains than exist.

    Columns are applied in declaration order: an `expand` column multiplies
    rows (extending the key tuple; empty reached sets follow `keep_empty`),
    and a COLLAPSE column with `keep_empty=False` filters rows whose cell
    would be empty without splitting anything ("Keep rows with no value"
    works with or without the split).

    `script` is `None` for callers with no script work in play (every existing
    caller); passed through to `resolve_source_elements`/`_collapse_has_value`/
    `_expand_values`/`_base_row_keys` so a `ScriptColumn` — collapse OR expand
    — goes through the SAME machinery every other column kind does, calling
    `value()` (memoized) exactly where a collapse/expand navigation or
    property column would re-navigate/re-read, AND so any `ScriptStep` inside
    a navigation (row source, navigation column, or a `ColumnRef`'s
    step-index re-navigation) rides the same context rather than pruning to
    nothing."""
    keys, truncated = _base_row_keys(mm, model, defn, limits, script=script)
    base_total = len(keys)
    base_slots = _row_source_base_slots(defn, keys)
    for col in defn.columns:
        if isinstance(col, ElementColumn):
            continue
        if col.mode != "expand":
            if col.keep_empty:
                continue
            # collapse + keep_empty=False: drop rows whose cell is empty.
            kept: list[RowKey] = []
            for key in keys:
                roots = resolve_source_elements(
                    mm, model, defn, key, col.source, base_slots, limits, script=script
                )
                has_value, nav_truncated = _collapse_has_value(
                    mm, model, col, roots, limits, script=script
                )
                if nav_truncated:
                    truncated = True
                if has_value:
                    kept.append(key)
            keys = kept
            continue
        capped = False
        new_keys: list[RowKey] = []
        for key in keys:
            roots = resolve_source_elements(
                mm, model, defn, key, col.source, base_slots, limits, script=script
            )
            reached, nav_truncated = _expand_values(
                mm, model, col, roots, limits, script=script
            )
            if nav_truncated:
                truncated = True
            if not reached:
                if col.keep_empty:
                    new_keys.append((*key, None))
            else:
                for v in reached:
                    new_keys.append((*key, v))
            if len(new_keys) > limits.max_rows:
                truncated = True
                capped = True
                new_keys = new_keys[: limits.max_rows]
                break
        keys = new_keys
        if capped:
            break
    if len(keys) > limits.max_rows:
        keys = keys[: limits.max_rows]
        truncated = True
    return RowBuild(keys=keys, truncated=truncated, base_total=base_total)


def _collapse_has_value(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn | PropertyColumn | ScriptColumn,
    roots: list[str],
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> tuple[bool, bool]:
    """(cell would be non-empty, navigation-truncated) for one row of a
    COLLAPSE column — the `keep_empty=False` filter in `build_rows_ex`.
    Mirrors what `cells.py` renders: a navigation cell is empty when nothing
    is reached; a property cell is empty when no source element carries a
    non-None (and, for lists, non-empty) value; a script cell is empty when
    the call returns an empty/None result — EXCEPT a call error, which counts
    as having a value (the row must stay visible so the cell can show the
    error) same as a dangling snippet ref. A `pending` result (Task 5:
    cache-only miss) is an error kind too, so a pending row is also KEPT — a
    background sweep is expected to fill it in, not hide it."""
    if isinstance(col, ScriptColumn):
        # keep_empty=False filter for a collapse script column. ERRORS COUNT
        # AS VALUES (this includes `pending`): dropping an errored/pending row
        # would hide the failure/placeholder.
        if col.snippet.ref is not None:
            return True, False  # dangling ref → error cell stays
        if col.snippet.definition is None or script is None or not roots:
            return False, False
        res = script.call(col.snippet.definition.code, "value", roots)
        if res.error is not None or res.value is None:
            return True, False
        p = res.value
        if p["kind"] == "scalar":
            return p["value"] is not None, False
        if p["kind"] == "scalars":
            return any(v is not None for v in p["values"]), False
        if p["kind"] == "element":
            return p["id"] in model.elements, False
        return any(i in model.elements for i in p["ids"]), False
    if isinstance(col, NavigationColumn):
        reached, truncated = _navigation_reached_ex(
            mm, model, col, roots, limits, script=script
        )
        return bool(reached), truncated
    for eid in roots:
        raw = model.elements[eid].properties.get(col.name)
        if raw is None:
            continue
        if isinstance(raw, (list, tuple)):
            if len(raw) > 0:
                return True, False
        else:
            return True, False
    return False, False


def _expand_values(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn | PropertyColumn | ScriptColumn,
    roots: list[str],
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
) -> tuple[list[Binding], bool]:
    """(values, navigation-truncated) an expand column contributes for one row."""
    if isinstance(col, ScriptColumn):
        # Expand promotion: element ids promote raw (str); SCALARS promote
        # wrapped in PropertyValue so a scalar string can never be mistaken
        # for an element id (the Binding invariant); None scalars are skipped.
        # A call ERROR (including the synthetic `pending` kind, Task 5:
        # cache-only miss) promotes the single binding None — exactly one row
        # survives regardless of keep_empty, and the cell layer re-derives
        # the error/pending result with a forced cache-only call (never
        # from a memo — `pending` results are deliberately never memoized).
        if col.snippet.ref is not None:
            return [None], False  # dangling ref → one error row
        if col.snippet.definition is None or script is None or not roots:
            return [], False
        res = script.call(col.snippet.definition.code, "value", roots)
        if res.error is not None or res.value is None:
            return [None], False
        p = res.value
        if p["kind"] == "element":
            return ([p["id"]] if p["id"] in model.elements else []), False
        if p["kind"] == "elements":
            return [i for i in dict.fromkeys(p["ids"]) if i in model.elements], False
        if p["kind"] == "scalar":
            return (
                [PropertyValue(p["value"])] if p["value"] is not None else []
            ), False
        return [PropertyValue(v) for v in p["values"] if v is not None], False
    if isinstance(col, NavigationColumn):
        reached, truncated = _navigation_reached_ex(
            mm, model, col, roots, limits, script=script
        )
        # PropertyValue terminals ride into the RowKey as-is (see Binding);
        # cells.py renders them back as read-only ValueCells.
        bindings: list[Binding] = list(reached)
        return bindings, truncated
    # PropertyColumn expand: one row per property value. Single-binding source
    # guaranteed by schema; missing/scalar handled by cells.expand_property_values.
    # Function-local import: cells.py imports FROM evaluate.py (resolve_source_
    # elements, _expand_slot_of, ...), so a module-level import here would cycle.
    from .cells import expand_property_values

    return expand_property_values(model, col, roots), False


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
# re-resolving + re-navigating/re-reading a property for every row. That extra
# pass is deliberately unbounded — no row cap: `build_rows`' own `max_rows`
# already bounds the key set, and the API layer caches the ordered row list per
# (definition, sort, model_rev), so the expensive pass runs once per sort
# request, not once per page.


@dataclass(frozen=True)
class SortSpec:
    column: int
    direction: Literal["asc", "desc"]


def _display_name(model: Model, eid: str) -> str:
    """The label used to order elements: the shared case-insensitive `name`
    property lookup (``core.model.naming.display_name``), else their id (so
    ordering is still total and deterministic). Must stay in lock-step with the
    frontend's ``elementDisplayName`` — sorting by a label the grid does not
    display reads as a broken sort."""
    return display_name(model.elements[eid])


def _script_sort_atom(model: Model, item: object) -> tuple[int, float, str]:
    """One uniformly-comparable sort atom for a script result item. Rank
    numbers (incl. bools) first, then strings, then elements — uniform
    `(rank, number, string)` triples so a column whose rows return DIFFERENT
    result kinds still sorts without a cross-type TypeError."""
    if isinstance(item, bool) or isinstance(item, (int, float)):
        return (0, float(item), "")
    if isinstance(item, str) and item in model.elements:
        return (2, 0.0, _display_name(model, item).casefold() + "\x00" + item)
    return (1, 0.0, str(item).casefold())


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


def _sort_value(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: Column,
    col_index: int,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
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
    if isinstance(col, ScriptColumn):
        if col.mode == "expand":
            b = key[_expand_slot_of(defn, base_slots, col_index)]
            if isinstance(b, PropertyValue):
                return (0, (_script_sort_atom(model, b.value),))
            if isinstance(b, str):
                return (0, (_script_sort_atom(model, b),))
            return (1, ())  # keep_empty row, error row, or pending row
        if col.snippet.definition is None or script is None:
            return (1, ())
        els = resolve_source_elements(
            mm, model, defn, key, col.source, base_slots, limits, script=script
        )
        if not els:
            return (1, ())
        res = script.call(col.snippet.definition.code, "value", els)
        if res.error is not None or res.value is None:
            return (1, ())  # errors AND pending sort with empties
        p = res.value
        if p["kind"] == "scalar":
            if p["value"] is None:
                return (1, ())
            return (0, (_script_sort_atom(model, p["value"]),))
        if p["kind"] == "scalars":
            vals = [v for v in p["values"] if v is not None]
            if not vals:
                return (1, ())
            return (0, tuple(_script_sort_atom(model, v) for v in vals))
        if p["kind"] == "element":
            eid = p["id"]
            if eid not in model.elements:
                return (1, ())
            return (0, (_script_sort_atom(model, eid),))
        atoms = sorted(
            _script_sort_atom(model, i) for i in p["ids"] if i in model.elements
        )
        return (0, tuple(atoms)) if atoms else (1, ())
    # NavigationColumn. `expand` already put ONE reached binding per row into
    # the RowKey (read it straight back); COLLAPSE needs a full re-navigation.
    # `value` sorts on the tuple of reached labels — display names for element
    # nodes, the value's string form for PropertyValue terminals — (name-
    # sorted, so two rows with the same multiset of labels compare equal
    # regardless of discovery order); `count` sorts on cardinality.
    if col.mode == "expand":
        b = key[_expand_slot_of(defn, base_slots, col_index)]
        if isinstance(b, PropertyValue):
            return (0, (str(b.value).casefold(), ""))
        if not isinstance(b, str):
            return (1, "")
        return (0, (_display_name(model, b).casefold(), b))
    roots = resolve_source_elements(
        mm, model, defn, key, col.source, base_slots, limits
    )
    reached = _navigation_reached(mm, model, col, roots, limits, script=script)
    if not reached:
        return (1, 0 if col.sort_mode == "count" else ())
    if col.sort_mode == "count":
        return (0, len(reached))
    labels = [
        _display_name(model, n) if isinstance(n, str) else str(n.value) for n in reached
    ]
    return (0, tuple(sorted(label.casefold() for label in labels)))


def order_rows(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    keys: list[RowKey],
    sort: SortSpec | None,
    limits: TableLimits = TableLimits(),
    script: ScriptEvalContext | None = None,
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
    expand_count = sum(
        1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
    )
    base_slots = (len(keys[0]) - expand_count) if keys else 1
    decorated: list[tuple[int, Any, RowKey]] = [
        (
            *_sort_value(
                mm, model, defn, k, col, sort.column, base_slots, limits, script=script
            ),
            k,
        )
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
    script: ScriptEvalContext | None = None,
) -> Iterator[list[Cell]]:
    """Yield evaluated cell rows for `keys`, in order, `chunk` rows at a time."""
    from .cells import evaluate_cells

    for i in range(0, len(keys), chunk):
        yield from evaluate_cells(
            mm, model, defn, keys[i : i + chunk], limits, script=script
        )
