"""Inline navigation and snippet refs inside a `TableDefinition`.

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
style as `core.navigation.resolve.resolve_refs`).

`ScriptColumn.snippet.ref`s are inlined too, via an independently injected
`snippet_fetch`, and threaded into every embedded navigation's resolution so
a `ScriptStep` nested inside a table's navigation gets its snippet inlined as
well. A dangling `ScriptColumn.snippet.ref` — like a dangling `ScriptStep`
ref — is left in place rather than raising: it degrades to error cells at
evaluation time instead of 422ing the whole table (unlike a dangling
navigation ref, which DOES raise: a table pointed at a nonexistent
navigation artifact has nothing sensible to evaluate)."""

from __future__ import annotations

from data_rover.core.navigation.resolve import (
    Fetch,
    SnippetFetch,
    navigation_has_script,
    resolve_refs,
)
from data_rover.core.navigation.schema import NavigationDefinition
from data_rover.core.script.schema import SnippetSource

from .schema import (
    ChainRows,
    NavigationColumn,
    NavigationRows,
    NavigationSource,
    ScriptColumn,
    TableDefinition,
)


def _resolve_source(
    ns: NavigationSource, fetch: Fetch, snippet_fetch: SnippetFetch | None
) -> NavigationSource:
    if ns.is_empty:
        return ns  # unconfigured: stays empty; evaluation reaches nothing
    if ns.ref is not None:
        base_def = fetch(ns.ref)  # LookupError propagates: unknown artifact
    else:
        assert ns.definition is not None  # schema: at most one of ref/definition
        base_def = ns.definition
    return NavigationSource(
        definition=resolve_refs(base_def, fetch, snippet_fetch=snippet_fetch)
    )


def _resolve_snippet_source(
    ss: SnippetSource, snippet_fetch: SnippetFetch | None
) -> SnippetSource:
    """Inline a ScriptColumn's snippet ref; a LookupError leaves the ref in
    place (dangling marker → error cells, not a 422)."""
    if ss.ref is None or snippet_fetch is None:
        return ss
    try:
        sd = snippet_fetch(ss.ref)
    except LookupError:
        return ss
    return SnippetSource(definition=sd)


def resolve_table_refs(
    defn: TableDefinition, fetch: Fetch, snippet_fetch: SnippetFetch | None = None
) -> TableDefinition:
    """A copy of `defn` with every embedded `NavigationSource` fully inlined
    (ref-free, transitively, including refs nested inside an already-inline
    definition's own operands) and every `ScriptColumn.snippet.ref` inlined
    (dangling snippet refs stay in place — see module docstring)."""
    rs = defn.row_source
    if isinstance(rs, (NavigationRows, ChainRows)):
        rs = rs.model_copy(
            update={"navigation": _resolve_source(rs.navigation, fetch, snippet_fetch)}
        )

    columns = [
        col.model_copy(
            update={"navigation": _resolve_source(col.navigation, fetch, snippet_fetch)}
        )
        if isinstance(col, NavigationColumn)
        else col.model_copy(
            update={"snippet": _resolve_snippet_source(col.snippet, snippet_fetch)}
        )
        if isinstance(col, ScriptColumn)
        else col
        for col in defn.columns
    ]
    return defn.model_copy(update={"row_source": rs, "columns": columns})


def table_has_script(defn: TableDefinition) -> bool:
    """True when evaluating `defn` may invoke a snippet: a ScriptColumn with a
    non-empty snippet, or any embedded navigation containing a ScriptStep."""
    for col in defn.columns:
        if isinstance(col, ScriptColumn) and not col.snippet.is_empty:
            return True
    navs: list[NavigationDefinition] = []
    rs = defn.row_source
    if (
        isinstance(rs, (NavigationRows, ChainRows))
        and rs.navigation.definition is not None
    ):
        navs.append(rs.navigation.definition)
    navs.extend(
        col.navigation.definition
        for col in defn.columns
        if isinstance(col, NavigationColumn) and col.navigation.definition is not None
    )
    return any(navigation_has_script(nd) for nd in navs)
