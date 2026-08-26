"""Per-PASS memo of navigation results for the table evaluator.

`build_rows_ex` emits an expand column's split rows contiguously per base
row, so every later per-row consumer that re-navigates from the row's source
(`resolve_source_elements`'s step-index branch, `_sort_value`, the collapse
navigation cell) evaluates the SAME navigation from the SAME roots once per
split row. `NavMemo` collapses that to once per distinct `(column, roots)`.

Scope is the whole guarantee: each public pass (`build_rows_ex`,
`order_rows`, `evaluate_cells`) constructs its own memo and discards it on
return — never a parameter of a public entry point, never stored on a
session or a `ScriptEvalContext`. That is what keeps a result computed under
`ScriptEvalContext.cache_only` (build/sort) from ever being served to the
live window pass. Belt and braces, a navigation containing a `ScriptStep`
bypasses the memo altogether (`scripted`): its `evaluate()` calls carry
per-call side effects (`pending_misses`, warning deltas) a cache would skip.

Bounded LRU: split rows are contiguous, so a build/sort pass needs one live
entry; a sorted window of at most a few hundred rows still repeats roots.
Entries hold an immutable tuple of chain tuples, never the `ChainResult`.

Keys use `id(col)`: the memo lives inside one pass whose `TableDefinition`
stays alive throughout, so a column's id cannot be recycled mid-pass."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass

from data_rover.core.navigation.evaluate import ChainNode
from data_rover.core.navigation.resolve import navigation_has_script

from .schema import NavigationColumn

MemoKey = tuple[int, tuple[str, ...]]

DEFAULT_MAX_ENTRIES = 64


@dataclass(frozen=True)
class MemoEntry:
    chains: tuple[tuple[ChainNode, ...], ...]
    truncated: bool


class NavMemo:
    def __init__(self, max_entries: int = DEFAULT_MAX_ENTRIES) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self.max_entries = max_entries
        self._entries: OrderedDict[MemoKey, MemoEntry] = OrderedDict()
        self._scripted: dict[int, bool] = {}

    def get(self, key: MemoKey) -> MemoEntry | None:
        hit = self._entries.get(key)
        if hit is not None:
            self._entries.move_to_end(key)
        return hit

    def put(self, key: MemoKey, entry: MemoEntry) -> None:
        self._entries[key] = entry
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)

    def scripted(self, col: NavigationColumn) -> bool:
        """True when `col`'s navigation may invoke a snippet — such a
        navigation is never memoized. Answered once per column object."""
        cached = self._scripted.get(id(col))
        if cached is not None:
            return cached
        defn = col.navigation.definition
        answer = defn is not None and navigation_has_script(defn)
        self._scripted[id(col)] = answer
        return answer

    def __len__(self) -> int:
        return len(self._entries)
