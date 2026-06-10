from __future__ import annotations

from collections.abc import Set
from typing import Iterable


class Scope:
    """The set of entity ids a validation run should consider.

    `Scope.all()` means "the whole model" (first-cut default). A bounded scope
    enables incremental validation later without changing validator code.

    Ordering: a bounded scope preserves the caller's insertion order (first
    occurrence wins, duplicates dropped) and iterating :attr:`ids` replays
    that order. This keeps scoped issue output deterministic across processes
    — a plain ``set`` would iterate in hash order, which is randomized per
    process by ``PYTHONHASHSEED``. Membership stays O(1).
    """

    def __init__(self, ids: Iterable[str] | None = None) -> None:
        # dict.fromkeys = ordered set: O(1) membership + insertion-order
        # iteration (see class docstring)
        self._ids: dict[str, None] | None = None if ids is None else dict.fromkeys(ids)

    @classmethod
    def all(cls) -> "Scope":
        return cls(None)

    @property
    def is_all(self) -> bool:
        return self._ids is None

    @property
    def ids(self) -> Set[str] | None:
        """The scoped entity ids, or None when the scope is the whole model.

        Iterates in the caller's insertion order. Returns a live internal
        view — do NOT mutate.
        """
        return None if self._ids is None else self._ids.keys()

    def includes(self, entity_id: str) -> bool:
        return self._ids is None or entity_id in self._ids
