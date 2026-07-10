"""Typed facade over ``sortedcontainers.SortedList`` for (str, str) pairs.

sortedcontainers ships no type information, so this module owns the single
``type: ignore`` and exposes the narrow, fully-typed surface the IndexSet
order indexes need: O(sqrt n)-amortized add/remove, O(log n + k) paging.
"""

from __future__ import annotations

from typing import Any, Iterable, Iterator

from sortedcontainers import SortedList  # type: ignore[import-untyped]

Pair = tuple[str, str]


class SortedPairs:
    """A sorted multiset of (sort_key, id) pairs."""

    def __init__(self, items: Iterable[Pair] = ()) -> None:
        self._sl: Any = SortedList(items)

    def add(self, pair: Pair) -> None:
        self._sl.add(pair)

    def remove(self, pair: Pair) -> None:
        """Remove one occurrence; raises ValueError if absent (a desync bug)."""
        self._sl.remove(pair)

    def clear(self) -> None:
        self._sl.clear()

    def __len__(self) -> int:
        return len(self._sl)

    def page(self, offset: int, limit: int) -> list[Pair]:
        return list(self._sl.islice(offset, offset + limit))

    def iter_all(self) -> Iterator[Pair]:
        return iter(self._sl)

    def as_list(self) -> list[Pair]:
        return list(self._sl)
