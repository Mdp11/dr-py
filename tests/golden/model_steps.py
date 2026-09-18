"""Runs steps against a real ``Model`` and records what happened.

A step is a JSON-ready dict: ``do`` names a method of the mutation boundary,
the other keys are its arguments (property values tagged, see ``tagged.py``).
After every step the recorder adds the outcome (``result`` or ``error``) and
what the step left behind: the state digest and a fingerprint of the entity
lines plus the index dump. Every ``full_every``-th step, and the last, carries
the lines and the dump themselves, so a mismatch can be read, not just seen. A
step that changed nothing says ``"unchanged": true`` instead. The engine's
golden runner replays the same steps and compares all of it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

from data_rover.api.serialize import iter_entity_lines
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from .index_dump import dump_indexes
from .tagged import tag


def fingerprint(state: list[str], indexes: str) -> str:
    """16 hex digits over the entity lines and the index dump text."""
    text = "\n".join(state) + "\n" + indexes
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def observe(model: Model) -> dict[str, Any]:
    """The state, index dump and digest of a model the oracle agrees with.

    The dump travels as compact JSON text: indented, its id lists would take
    a line per id and dwarf everything else in the fixture.
    """
    model.indexes.verify_consistent()
    state = list(iter_entity_lines(model))
    indexes = json.dumps(dump_indexes(model), separators=(",", ":"), ensure_ascii=False)
    return {
        "digest": model_digest(model),
        "fingerprint": fingerprint(state, indexes),
        "state": state,
        "indexes": indexes,
    }


def set_property(entity_id: str, prop: str, value: Any, **extra: Any) -> dict[str, Any]:
    """A ``set_property`` step. The raw value rides along under ``_value``;
    the recorder applies it and writes its tagged form."""
    return {
        "do": "set_property",
        "id": entity_id,
        "prop": prop,
        "_value": value,
        **extra,
    }


class Recorder:
    """One scenario in the making: a model with sequential ids, and its log."""

    def __init__(self, metamodel: Metamodel, *, full_every: int = 5) -> None:
        self.metamodel = metamodel
        self.model = Model(metamodel, SequentialIdGenerator())
        self._full_every = full_every
        self._steps: list[dict[str, Any]] = []
        self._last: dict[str, Any] | None = None

    def _entity(self, step: dict[str, Any]) -> Element | Relationship:
        detached = step.get("detached")
        if detached == "element":
            return Element(id=step["id"], type_name=step["type"])
        if detached == "relationship":
            return Relationship(
                id=step["id"], type_name=step["type"], source_id="", target_id=""
            )
        model = self.model
        entity = model.elements.get(step["id"]) or model.relationships.get(step["id"])
        if entity is None:
            raise AssertionError(f"scenario names an unknown entity {step['id']!r}")
        return entity

    def _apply(self, step: dict[str, Any]) -> Any:
        model = self.model
        match step["do"]:
            case "create_element":
                return model.create_element(step["type"]).id
            case "restore_element":
                return model.restore_element(step["id"], step["type"]).id
            case "get_element":
                return model.get_element(step["id"]).id
            case "get_relationship":
                return model.get_relationship(step["id"]).id
            case "set_property":
                model.set_property(self._entity(step), step["prop"], step["_value"])
                return None
            case "delete_property":
                model.delete_property(self._entity(step), step["prop"])
                return None
            case "connect":
                return model.connect(step["type"], step["source"], step["target"]).id
            case "restore_relationship":
                return model.restore_relationship(
                    step["id"], step["type"], step["source"], step["target"]
                ).id
            case "disconnect":
                model.disconnect(step["id"])
                return None
            case "delete_element":
                model.delete_element(step["id"])
                return None
            case "container_of":
                return model.container_of(step["id"])
            case "relationships_from":
                return sorted(r.id for r in model.relationships_from(step["id"]))
            case "relationships_to":
                return sorted(r.id for r in model.relationships_to(step["id"]))
        raise AssertionError(f"unknown step {step['do']!r}")

    def run(self, step: dict[str, Any]) -> Any:
        """Apply one step, log it, and return its result (``None`` on an error)."""
        entry = {key: item for key, item in step.items() if key != "_value"}
        if "_value" in step:
            entry["value"] = tag(step["_value"])
        try:
            entry["result"] = self._apply(step)
            entry["error"] = None
        except (KeyError, ValueError) as exc:
            entry["result"] = None
            entry["error"] = {
                "kind": "key" if isinstance(exc, KeyError) else "value",
                "message": exc.args[0],
            }
        seen = observe(self.model)
        if seen == self._last:
            entry["unchanged"] = True
        else:
            entry["digest"] = seen["digest"]
            entry["fingerprint"] = seen["fingerprint"]
            if len(self._steps) % self._full_every == 0:
                entry.update(seen)
        self._steps.append(entry)
        self._last = seen
        return entry["result"]

    def document(self) -> dict[str, Any]:
        """The scenario document: the metamodel as ``GET /metamodel`` serves
        it, then every step with its outcome and what it left behind."""
        # The last step that changed anything always carries the full state.
        for entry in reversed(self._steps):
            if "unchanged" not in entry:
                assert self._last is not None
                entry.update(self._last)
                break
        return {
            "metamodel": self.metamodel.model_dump(mode="json"),
            "steps": self._steps,
        }


def run_steps(
    metamodel: Metamodel, steps: Iterable[dict[str, Any]], *, full_every: int = 5
) -> dict[str, Any]:
    recorder = Recorder(metamodel, full_every=full_every)
    for step in steps:
        recorder.run(step)
    return recorder.document()
