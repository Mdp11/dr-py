from __future__ import annotations

import copy

from ..metamodel.schema import Metamodel
from ..model.element import Element
from ..model.model import Model
from ..model.relationship import Relationship
from .repository import ConflictError


class InMemoryRepository:
    def __init__(self) -> None:
        self._metamodels: dict[str, Metamodel] = {}
        self._models: dict[str, tuple[int, list[Element], list[Relationship]]] = {}

    def save_metamodel(self, name: str, metamodel: Metamodel) -> None:
        self._metamodels[name] = metamodel.model_copy(deep=True)

    def load_metamodel(self, name: str) -> Metamodel:
        if name not in self._metamodels:
            raise KeyError(f"No metamodel named {name!r}")
        return self._metamodels[name].model_copy(deep=True)

    def save_model(
        self, name: str, model: Model, expected_rev: int | None = None
    ) -> int:
        current_rev = self._models[name][0] if name in self._models else 0
        if expected_rev is not None and expected_rev != current_rev:
            raise ConflictError(
                f"Stale write to {name!r}: expected rev {expected_rev}, "
                f"current {current_rev}"
            )
        new_rev = current_rev + 1
        self._models[name] = (
            new_rev,
            copy.deepcopy(list(model.elements.values())),
            copy.deepcopy(list(model.relationships.values())),
        )
        return new_rev

    def load_model(self, name: str, metamodel: Metamodel) -> Model:
        if name not in self._models:
            raise KeyError(f"No model named {name!r}")
        _, elements, relationships = self._models[name]
        model = Model(metamodel)
        for el in copy.deepcopy(elements):
            model.elements[el.id] = el
        for rel in copy.deepcopy(relationships):
            model.relationships[rel.id] = rel
        return model
