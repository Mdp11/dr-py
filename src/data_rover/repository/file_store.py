from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

import yaml

from ..metamodel.schema import Metamodel
from ..model.element import Element
from ..model.model import Model
from ..model.relationship import Relationship


class FileRepository:
    """Persists metamodels and models as YAML files in a directory."""

    def __init__(self, directory: str | Path) -> None:
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str, kind: str) -> Path:
        return self._dir / f"{name}.{kind}.yaml"

    def save_metamodel(self, name: str, metamodel: Metamodel) -> None:
        text = yaml.safe_dump(metamodel.model_dump(), sort_keys=False)
        self._path(name, "metamodel").write_text(text, encoding="utf-8")

    def load_metamodel(self, name: str) -> Metamodel:
        path = self._path(name, "metamodel")
        if not path.exists():
            raise KeyError(f"No metamodel file for {name!r}")
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return Metamodel.model_validate(data)

    def save_model(
        self, name: str, model: Model, expected_rev: int | None = None
    ) -> int:
        data = {
            "elements": [asdict(e) for e in model.elements.values()],
            "relationships": [asdict(r) for r in model.relationships.values()],
        }
        self._path(name, "model").write_text(
            yaml.safe_dump(data, sort_keys=False), encoding="utf-8"
        )
        # Optimistic-concurrency rev tracking is deferred for the file adapter
        # (see design spec §6/§8); expected_rev is accepted to satisfy the port
        # but not yet enforced here.
        return 1

    def load_model(self, name: str, metamodel: Metamodel) -> Model:
        path = self._path(name, "model")
        if not path.exists():
            raise KeyError(f"No model file for {name!r}")
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        model = Model(metamodel)
        for e in data.get("elements", []):
            element = Element(**e)
            model.elements[element.id] = element
        for r in data.get("relationships", []):
            rel = Relationship(**r)
            model.relationships[rel.id] = rel
        return model
