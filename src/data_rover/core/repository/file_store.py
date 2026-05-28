from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import yaml

from ..metamodel.schema import Metamodel
from ..model.element import Element
from ..model.model import Model
from ..model.relationship import Relationship
from .repository import ConflictError


class FileRepository:
    """Persists metamodels and models as YAML files in a directory."""

    def __init__(self, directory: str | Path) -> None:
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str, kind: str, ext: str) -> Path:
        return self._dir / f"{name}.{kind}.{ext}"

    def save_metamodel(self, name: str, metamodel: Metamodel) -> None:
        text = yaml.safe_dump(metamodel.model_dump(), sort_keys=False)
        self._path(name, "metamodel", "yaml").write_text(text, encoding="utf-8")

    def load_metamodel(self, name: str) -> Metamodel:
        path = self._path(name, "metamodel", "yaml")
        if not path.exists():
            raise KeyError(f"No metamodel file for {name!r}")
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return Metamodel.model_validate(data)

    def current_rev(self, name: str) -> int:
        """Return the current persisted rev for a model, or 0 if absent."""
        path = self._path(name, "model", "json")
        if not path.exists():
            return 0
        try:
            data = json.loads(path.read_text(encoding="utf-8")) or {}
        except json.JSONDecodeError:
            return 0
        return int(data.get("rev", 0))

    def exists(self, name: str) -> bool:
        """Return True if a persisted model JSON file exists for `name`."""
        return self._path(name, "model", "json").exists()

    def save_model(
        self, name: str, model: Model, expected_rev: int | None = None
    ) -> int:
        current = self.current_rev(name)
        if expected_rev is not None and expected_rev != current:
            raise ConflictError(
                f"Stale write to {name!r}: expected rev {expected_rev}, "
                f"current {current}"
            )
        new_rev = current + 1
        data = {
            "rev": new_rev,
            "elements": [asdict(e) for e in model.elements.values()],
            "relationships": [asdict(r) for r in model.relationships.values()],
        }
        path = self._path(name, "model", "json")
        # Atomic write: stage to a temp file in the same directory, then rename.
        # A crash mid-write leaves the previous model JSON intact, preventing
        # `current_rev` from silently falling back to 0 on corruption.
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(path)
        return new_rev

    def load_model(self, name: str, metamodel: Metamodel) -> Model:
        path = self._path(name, "model", "json")
        if not path.exists():
            raise KeyError(f"No model file for {name!r}")
        data = json.loads(path.read_text(encoding="utf-8")) or {}
        model = Model(metamodel)
        for e in data.get("elements", []):
            element = Element(**e)
            model.elements[element.id] = element
        for r in data.get("relationships", []):
            rel = Relationship(**r)
            model.relationships[rel.id] = rel
        return model
