from __future__ import annotations

from collections.abc import Set
from typing import Iterable


class Scope:
    """The set of entity ids a validation run should consider.

    `Scope.all()` means "the whole model" (first-cut default). A bounded scope
    enables incremental validation later without changing validator code.
    """

    def __init__(self, ids: Iterable[str] | None = None) -> None:
        self._ids: set[str] | None = None if ids is None else set(ids)

    @classmethod
    def all(cls) -> "Scope":
        return cls(None)

    @property
    def is_all(self) -> bool:
        return self._ids is None

    @property
    def ids(self) -> Set[str] | None:
        """The scoped entity ids, or None when the scope is the whole model.

        Returns a live internal view — do NOT mutate.
        """
        return self._ids

    def includes(self, entity_id: str) -> bool:
        return self._ids is None or entity_id in self._ids
