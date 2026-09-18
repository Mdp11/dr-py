"""A seeded random walk of op batches: a few ops each, temp ids woven through
endpoints and reference values, refusals from stale ids and undeclared
properties, and undos of earlier batches that may themselves be refused."""

from __future__ import annotations

import random
from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import Recorder, batch

_SEED = 20260919
_STEPS = 160

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

_NAMES = ["", "a", "b", "B", "\U000000e9", "\U0001f600", "\U0000ffff"]
_NUMBERS = [0, 1, 1.0, True, False, -0.0, 2, 2.5]


class _Walk:
    def __init__(self) -> None:
        self.rng = random.Random(_SEED)
        self.recorder = Recorder(Metamodel.model_validate(_METAMODEL), full_every=40)
        self.temps = 0
        self.count = 0
        self.landed: list[int] = []

    def pick(self, items: list[Any]) -> Any:
        # rng.random() alone: its stream is stable across Python versions.
        return items[int(self.rng.random() * len(items))]

    def temp(self) -> str:
        self.temps += 1
        return f"tmp_{self.temps}"

    def ops(self) -> list[dict[str, Any]]:
        model = self.recorder.model
        parts = [e.id for e in model.elements.values() if e.type_name == "Part"]
        slots = [e.id for e in model.elements.values() if e.type_name == "Slot"]
        feeds = [r.id for r in model.relationships.values() if r.type_name == "Feeds"]
        rels = list(model.relationships)
        out: list[dict[str, Any]] = []
        for _ in range(1 + int(self.rng.random() * 4)):
            match self.pick(["create"] * 4 + ["update"] * 6 + ["connect"] * 5
                            + ["update_rel", "delete_rel", "delete", "stale", "undeclared"]):  # fmt: skip
                case "create":
                    temp = self.temp()
                    kind = self.pick(["Part", "Part", "Slot"])
                    (parts if kind == "Part" else slots).append(temp)
                    out.append(
                        {
                            "kind": "create_element",
                            "temp_id": temp,
                            "type_name": kind,
                            "properties": {"name": self.pick(_NAMES)},
                        }
                    )
                case "update" if parts or slots:
                    target = self.pick([*parts, *slots])
                    some = self.pick([*parts, *slots, "dangling"])
                    patch: dict[str, Any] = {"name": self.pick([*_NAMES, None])}
                    if target in slots:
                        patch["code"] = self.pick([*_NUMBERS, None])
                        patch["holder"] = some
                    else:
                        patch["size"] = self.pick([*_NUMBERS, None])
                        patch["peers"] = [some, self.pick([*parts, "dangling"])]
                    out.append(
                        {
                            "kind": "update_element",
                            "id": target,
                            "properties_patch": patch,
                        }
                    )
                case "connect" if parts:
                    kind = self.pick(["Owns", "Seats", "Feeds"])
                    sources, targets = {
                        "Owns": (parts, parts),
                        "Seats": (parts, slots),
                        "Feeds": (slots, slots),
                    }[kind]
                    if not sources or not targets:
                        continue
                    temp = self.temp()
                    op: dict[str, Any] = {
                        "kind": "create_relationship",
                        "temp_id": temp,
                        "type_name": kind,
                        "source_id": self.pick(sources),
                        "target_id": self.pick(targets),
                    }
                    if kind == "Feeds":
                        op["properties"] = {"via": self.pick([*parts, "dangling"])}
                        feeds.append(temp)
                    rels.append(temp)
                    out.append(op)
                case "update_rel" if feeds:
                    out.append(
                        {
                            "kind": "update_relationship",
                            "id": self.pick(feeds),
                            "properties_patch": {"via": self.pick([*parts, None])},
                        }
                    )
                case "delete_rel" if rels:
                    out.append({"kind": "delete_relationship", "id": self.pick(rels)})
                case "delete" if parts or slots:
                    out.append(
                        {"kind": "delete_element", "id": self.pick([*parts, *slots])}
                    )
                case "stale":
                    out.append({"kind": "delete_element", "id": "gone"})
                case "undeclared" if parts:
                    out.append(
                        {
                            "kind": "update_element",
                            "id": self.pick(parts),
                            "properties_patch": {"name": "x", "code": 1},
                        }
                    )
        return out

    def step(self) -> None:
        """One more step: mostly a batch, now and then the undo of a landed one."""
        if self.landed and self.rng.random() < 0.15:
            step: dict[str, Any] = {"do": "undo", "of": self.pick(self.landed)}
        else:
            step = batch(self.ops())
        if self.recorder.run(step) is not None:
            self.landed.append(self.count)
        self.count += 1


@scenario("ops_churn")
def ops_churn() -> Any:
    walk = _Walk()
    for _ in range(_STEPS):
        walk.step()
    return walk.recorder.document()
