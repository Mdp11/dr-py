from __future__ import annotations

from typing import Protocol

from ..metamodel.schema import Metamodel
from ..model.model import Model


class ConflictError(Exception):
    """Raised when an optimistic-concurrency expected revision does not match."""


class Repository(Protocol):
    def save_metamodel(self, name: str, metamodel: Metamodel) -> None: ...
    def load_metamodel(self, name: str) -> Metamodel: ...
    def save_model(
        self, name: str, model: Model, expected_rev: int | None = None
    ) -> int: ...
    def load_model(self, name: str, metamodel: Metamodel) -> Model: ...
    def exists(self, name: str) -> bool: ...
