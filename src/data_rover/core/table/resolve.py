"""Inline navigation refs inside a `TableDefinition`.

The table core evaluator (`build_rows`/`order_rows`/`evaluate_cells`, Tasks
4-6) is deliberately ref-free: it assumes every `NavigationSource` it sees
either carries a resolved `.definition` with no `Operand.ref` anywhere in
its tree, or is EMPTY (unconfigured — evaluates to nothing). This module produces that shape from a possibly-ref-bearing
`TableDefinition`, via an injected `fetch` callable that loads + parses a
stored navigation artifact's payload (raising `LookupError` for an
unknown/foreign/non-navigation artifact — the API layer maps that to 422).

Every `NavigationSource` embedded in a table is inlined: the row source's
`.navigation` when it is a `NavigationRows`/`ChainRows`, and each
`NavigationColumn`'s `.navigation`. For each one, `core.navigation.resolve.
resolve_refs` runs over the definition EVEN WHEN the source was already
inline (`.definition` set, no top-level `.ref`) — an inline definition can
itself carry `Operand.ref`s inside its own set-expression operands, and
those must be inlined too so the result is fully ref-free, matching what
`build_rows`/`_navigation_row_keys` etc. assert (`defn is not None`, never a
lingering ref). Never mutates its input (same non-mutating `model_copy`
style as `core.navigation.resolve.resolve_refs`)."""

from __future__ import annotations

from data_rover.core.navigation.resolve import Fetch, resolve_refs

from .schema import (
    ChainRows,
    NavigationColumn,
    NavigationRows,
    NavigationSource,
    TableDefinition,
)


def _resolve_source(ns: NavigationSource, fetch: Fetch) -> NavigationSource:
    if ns.is_empty:
        return ns  # unconfigured: stays empty; evaluation reaches nothing
    if ns.ref is not None:
        base_def = fetch(ns.ref)  # LookupError propagates: unknown artifact
    else:
        assert ns.definition is not None  # schema: at most one of ref/definition
        base_def = ns.definition
    return NavigationSource(definition=resolve_refs(base_def, fetch))


def _resolve_table_navigation_refs(
    defn: TableDefinition, fetch: Fetch
) -> TableDefinition:
    """A copy of `defn` with every embedded `NavigationSource` fully inlined
    (ref-free, transitively, including refs nested inside an already-inline
    definition's own operands)."""
    rs = defn.row_source
    if isinstance(rs, (NavigationRows, ChainRows)):
        rs = rs.model_copy(update={"navigation": _resolve_source(rs.navigation, fetch)})

    columns = [
        col.model_copy(update={"navigation": _resolve_source(col.navigation, fetch)})
        if isinstance(col, NavigationColumn)
        else col
        for col in defn.columns
    ]
    return defn.model_copy(update={"row_source": rs, "columns": columns})
