"""Reads the frozen golden fixtures against the Python core.

A fixture is a recorded run: the steps, what each answered and the state it
left behind. ``replay`` runs the steps on a real ``Model`` and returns the same
entries, so a test asserts they equal the fixture's. ``observe`` dumps a
model's state and digest; ``index_dump`` renders its indexes canonically
(everything a set holds sorted, every mapping a list of pairs, so the text
depends on the model's state alone).
"""

from __future__ import annotations

import copy
import hashlib
import json
import struct
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, TypeAdapter

from data_rover.api.routes.ops import _apply_batch, _BatchResult
from data_rover.api.schemas import ElementOut, IssueOut, ModelOpIn, RelationshipOut
from data_rover.api.serialize import iter_entity_lines
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.validation.pipeline import ValidationPipeline, default_validators
from data_rover.core.validation.scope import Scope

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "engine" / "fixtures" / "golden"

_MODEL_OPS: TypeAdapter[list[ModelOpIn]] = TypeAdapter(list[ModelOpIn])


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8"))


def untag(node: dict[str, Any]) -> Any:
    """The value a tagged fixture node stands for: ints as decimal text,
    floats as IEEE-754 bits, dicts as ordered pairs."""
    match node["t"]:
        case "null":
            return None
        case "bool" | "str":
            return node["v"]
        case "int":
            return int(node["v"])
        case "float":
            return struct.unpack(">d", bytes.fromhex(node["hex"]))[0]
        case "list":
            return [untag(item) for item in node["v"]]
        case "dict":
            return {key: untag(item) for key, item in node["v"]}
    raise ValueError(f"unknown tag {node['t']!r}")


def tag(value: Any) -> dict[str, Any]:
    """``untag``'s inverse: a rendering that keeps ``1`` apart from ``1.0``."""
    if value is None:
        return {"t": "null"}
    if isinstance(value, bool):
        return {"t": "bool", "v": value}
    if isinstance(value, int):
        return {"t": "int", "v": str(value)}
    if isinstance(value, float):
        return {"t": "float", "hex": struct.pack(">d", value).hex()}
    if isinstance(value, str):
        return {"t": "str", "v": value}
    if isinstance(value, list):
        return {"t": "list", "v": [tag(item) for item in value]}
    if isinstance(value, dict):
        return {"t": "dict", "v": [[key, tag(item)] for key, item in value.items()]}
    raise TypeError(f"cannot tag {type(value).__name__}")


class Ids:
    """``id-1``, ``id-2``, … with a counter a refused batch puts back."""

    def __init__(self) -> None:
        self.drawn = 0

    def new_id(self) -> str:
        self.drawn += 1
        return f"id-{self.drawn}"


def line(doc: BaseModel) -> str:
    """One op or entity as the compact JSON text the server writes."""
    return json.dumps(
        doc.model_dump(), separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def fingerprint(state: list[str], indexes: str) -> str:
    """16 hex digits over the entity lines and the index dump text."""
    text = "\n".join(state) + "\n" + indexes
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _pairs(mapping: Mapping[str, Iterable[str]]) -> list[list[Any]]:
    return [[key, sorted(mapping[key])] for key in sorted(mapping)]


def _counts(counter: Mapping[tuple[str, str], int]) -> list[list[Any]]:
    return [[eid, rel_type, n] for (eid, rel_type), n in sorted(counter.items())]


def index_dump(model: Model) -> dict[str, Any]:
    ix = model.indexes
    return {
        "by_type": _pairs(ix.elements_by_type),
        "out": _pairs(ix.out_rels),
        "in": _pairs(ix.in_rels),
        "out_count": _counts(ix.out_count),
        "in_count": _counts(ix.in_count),
        # parents and their relationships keep relationship-insertion order
        "parents": [
            [child, list(parents), list(ix._containment_rel_ids[child])]
            for child, parents in sorted(ix.containment_parents.items())
        ],
        "refs": _pairs(ix._refs_of),
        "referencers": _pairs(ix.ref_targets),
        "uniq_groups": sorted(sorted(group) for group in ix.uniq_groups.values()),
        "duplicates": sorted(sorted(ix.uniq_groups[key]) for key in ix.duplicate_keys),
        "roots": [[name, eid] for name, eid in ix.roots_order.as_list()],
    }


def observe(model: Model) -> dict[str, Any]:
    """The state, index dump and digest of a model. The dump is compact JSON
    text, as the fixtures hold it."""
    model.indexes.verify_consistent()
    state = list(iter_entity_lines(model))
    indexes = json.dumps(index_dump(model), separators=(",", ":"), ensure_ascii=False)
    return {
        "digest": model_digest(model),
        "fingerprint": fingerprint(state, indexes),
        "state": state,
        "indexes": indexes,
    }


def outcome(model: Model, res: _BatchResult) -> dict[str, Any]:
    """What a landed batch reports, and the delta a replica would be sent."""
    return {
        "id_map": [[temp, real] for temp, real in res.id_map.items()],
        "changed_element_ids": list(res.changed_element_ids),
        "changed_relationship_ids": list(res.changed_relationship_ids),
        "deleted_element_ids": list(res.deleted_element_ids),
        "deleted_relationship_ids": list(res.deleted_relationship_ids),
        "recreated_element_ids": list(res.recreated_element_ids),
        "recreated_relationship_ids": list(res.recreated_relationship_ids),
        "before_elements": [
            [eid, None if before is None else line(before)]
            for eid, before in res.before_elements.items()
        ],
        "before_relationships": [
            [rid, None if before is None else line(before)]
            for rid, before in res.before_relationships.items()
        ],
        "inverse_ops": [line(op) for op in res.inverse_ops()],
        "changed_elements": [
            line(ElementOut.from_core(model.elements[eid]))
            for eid in res.changed_element_ids
        ],
        "changed_relationships": [
            line(RelationshipOut.from_core(model.relationships[rid]))
            for rid in res.changed_relationship_ids
        ],
    }


class Replay:
    """A recorded run's steps applied to a model with sequential ids."""

    def __init__(self, metamodel: Metamodel) -> None:
        self.metamodel = metamodel
        self.ids = Ids()
        self.model = Model(metamodel, self.ids)
        self._landed: dict[int, _BatchResult] = {}
        self._last: dict[str, Any] | None = None
        self.entries: list[dict[str, Any]] = []

    def _batch(
        self, ops: list[ModelOpIn], *, restore: bool, record_dirty: bool
    ) -> dict[str, Any]:
        drawn = self.ids.drawn
        try:
            res = _apply_batch(self.model, ops, restore=restore)
        except HTTPException:
            self.ids.drawn = drawn
            raise
        self._landed[len(self.entries)] = res
        done = outcome(self.model, res)
        if record_dirty:
            done["dirty"] = list(res.dirty.ids)
        return done

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
            raise AssertionError(f"fixture names an unknown entity {step['id']!r}")
        return entity

    def _apply(self, step: dict[str, Any]) -> Any:
        model = self.model
        match step["do"]:
            case "batch":
                ops = _MODEL_OPS.validate_python(
                    [json.loads(text) for text in step["ops"]]
                )
                return self._batch(
                    ops,
                    restore=bool(step.get("restore", False)),
                    record_dirty=bool(step.get("record_dirty", False)),
                )
            case "undo":
                return self._batch(
                    self._landed[step["of"]].inverse_ops(),
                    restore=True,
                    record_dirty=bool(step.get("record_dirty", False)),
                )
            case "validate":
                scope = step["scope"]
                ids = (
                    [*model.elements, *model.relationships]
                    if scope == "all_ids"
                    else scope
                )
                pipeline = ValidationPipeline(default_validators())
                issues = pipeline.validate(model, Scope(ids))
                return [IssueOut.from_core(i).model_dump(mode="json") for i in issues]
            case "create_element":
                return model.create_element(step["type"]).id
            case "restore_element":
                return model.restore_element(step["id"], step["type"]).id
            case "insert_element":
                return model.insert_element(
                    step["id"],
                    step["type"],
                    copy.deepcopy(untag(step["value"])),
                    step["rev"],
                ).id
            case "insert_relationship":
                return model.insert_relationship(
                    step["id"],
                    step["type"],
                    step["source"],
                    step["target"],
                    copy.deepcopy(untag(step["value"])),
                    step["rev"],
                ).id
            case "get_element":
                return model.get_element(step["id"]).id
            case "get_relationship":
                return model.get_relationship(step["id"]).id
            case "set_property":
                model.set_property(
                    self._entity(step), step["prop"], untag(step["value"])
                )
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

    def run(self, step: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
        """Apply one recorded step and return its entry as the fixture holds
        it: the outcome, and what the step left behind. The state and index
        dump appear where ``expected`` carries them."""
        entry: dict[str, Any] = {}
        try:
            entry["result"] = self._apply(step)
            entry["error"] = None
        except (KeyError, ValueError) as exc:
            entry["result"] = None
            entry["error"] = {
                "kind": "key" if isinstance(exc, KeyError) else "value",
                "message": exc.args[0],
            }
        except HTTPException as exc:
            entry["result"] = None
            entry["error"] = {"status": exc.status_code, "detail": exc.detail}
        seen = observe(self.model)
        if entry["error"] is not None and "status" in entry["error"]:
            before = self._last or observe(Model(self.metamodel))
            assert seen == before, "a refused batch left a trace"
        if seen == self._last:
            entry["unchanged"] = True
        else:
            entry["digest"] = seen["digest"]
            entry["fingerprint"] = seen["fingerprint"]
            if "state" in expected:
                entry["state"] = seen["state"]
                entry["indexes"] = seen["indexes"]
        self._last = seen
        self.entries.append(entry)
        return entry


def replay(doc: dict[str, Any]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Every step of a recorded run as ``(recorded, replayed)`` pairs, the
    recorded one cut down to the keys a replay produces."""
    run = Replay(Metamodel.model_validate(doc["metamodel"]))
    keys = ("result", "error", "unchanged", "digest", "fingerprint", "state", "indexes")
    pairs = []
    for step in doc["steps"]:
        replayed = run.run(step, step)
        pairs.append(({k: step[k] for k in keys if k in step}, replayed))
    return pairs
