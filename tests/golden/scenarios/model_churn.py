"""A seeded random walk over the mutation boundary: creates, writes, edges,
cascading deletes and restores, in an order no hand-written scenario would
think of. Values come from small pools so that names tie, keys collide and
references dangle."""

from __future__ import annotations

import random
from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import Recorder, set_property

_SEED = 20260918
_STEPS = 240

_METAMODEL = {
    "elements": [
        {
            "name": "Part",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "size", "datatype": "float"},
                {"name": "peers", "datatype": "Part", "multiplicity": "0..*"},
            ],
        },
        {
            "name": "Slot",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "code", "datatype": "integer"},
                {"name": "holder", "datatype": "Part"},
            ],
            "key": ["code", "out:Feeds", "in:Feeds"],
        },
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Part", "target": "Part"},
        {"name": "Seats", "extends": "Owns", "source": "Part", "target": "Slot"},
        {
            "name": "Feeds",
            "source": "Slot",
            "target": "Slot",
            "properties": [{"name": "via", "datatype": "Part"}],
        },
    ],
}

_NAMES = ["", "a", "b", "B", "\u00e9", "\U0001f600", "\uffff"]
_NUMBERS = [0, 1, 1.0, True, False, -0.0, 2, 2.5, None]


class _Walk:
    def __init__(self) -> None:
        self.rng = random.Random(_SEED)
        self.recorder = Recorder(Metamodel.model_validate(_METAMODEL), full_every=40)
        self.deleted_elements: list[tuple[str, str]] = []
        self.deleted_relationships: list[tuple[str, str, str, str]] = []

    def pick(self, items: list[Any]) -> Any:
        # rng.random() alone: its stream is stable across Python versions.
        return items[int(self.rng.random() * len(items))]

    def elements(self, type_name: str | None = None) -> list[str]:
        return [
            e.id
            for e in self.recorder.model.elements.values()
            if type_name is None or e.type_name == type_name
        ]

    def some_id(self) -> str:
        return self.pick([*self.elements(), "dangling"])

    def step(self) -> dict[str, Any] | None:
        model = self.recorder.model
        parts, slots = self.elements("Part"), self.elements("Slot")
        rels = list(model.relationships)
        match self.pick(["create"] * 3 + ["write"] * 6 + ["connect"] * 4
                        + ["unset", "disconnect", "delete", "restore", "restore_rel"]):  # fmt: skip
            case "create":
                return {
                    "do": "create_element",
                    "type": self.pick(["Part", "Part", "Slot"]),
                }
            case "write" if parts or slots:
                target = self.pick([*parts, *slots, *rels])
                if target in rels:
                    if model.relationships[target].type_name != "Feeds":
                        return None
                    return set_property(target, "via", self.some_id())
                if target in slots:
                    prop = self.pick(["name", "code", "holder"])
                else:
                    prop = self.pick(["name", "size", "peers"])
                value: Any
                if prop == "name":
                    value = self.pick(_NAMES)
                elif prop == "holder":
                    value = self.some_id()
                elif prop == "peers":
                    value = [self.some_id() for _ in range(int(self.rng.random() * 3))]
                else:
                    value = self.pick(_NUMBERS)
                return set_property(target, prop, value)
            case "unset" if parts or slots:
                target = self.pick([*parts, *slots])
                prop = self.pick(["name", "code" if target in slots else "size"])
                return {"do": "delete_property", "id": target, "prop": prop}
            case "connect" if parts:
                kind = self.pick(["Owns", "Seats", "Feeds"])
                sources, targets = {
                    "Owns": (parts, parts),
                    "Seats": (parts, slots),
                    "Feeds": (slots, slots),
                }[kind]
                if not sources or not targets:
                    return None
                return {
                    "do": "connect",
                    "type": kind,
                    "source": self.pick(sources),
                    "target": self.pick(targets),
                }
            case "disconnect" if rels:
                rel = model.relationships[self.pick(rels)]
                self.deleted_relationships.append(
                    (rel.id, rel.type_name, rel.source_id, rel.target_id)
                )
                return {"do": "disconnect", "id": rel.id}
            case "delete" if parts or slots:
                target = self.pick([*parts, *slots])
                self.deleted_elements.append((target, model.elements[target].type_name))
                return {"do": "delete_element", "id": target}
            case "restore" if self.deleted_elements:
                eid, type_name = self.pick(self.deleted_elements)
                return {"do": "restore_element", "id": eid, "type": type_name}
            case "restore_rel" if self.deleted_relationships:
                rid, type_name, source, target = self.pick(self.deleted_relationships)
                return {
                    "do": "restore_relationship",
                    "id": rid,
                    "type": type_name,
                    "source": source,
                    "target": target,
                }
        return None


@scenario("model_churn")
def model_churn() -> Any:
    walk = _Walk()
    done = 0
    while done < _STEPS:
        step = walk.step()
        if step is not None:
            walk.recorder.run(step)
            done += 1
    return walk.recorder.document()
