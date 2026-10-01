"""The read keys a landed batch touches, as the commit-side invalidation of the
script cell cache computes them.

Each case applies one batch, through the server's applier, to a fresh copy of
one small model: an inheritance chain of element types, a containment
relationship type with a containment subtype, a plain one, and an element with
two containment parents. A case records its ops, the ids the batch touched and
``touched_keys`` of the result, sorted with ``None`` first. ``moves_containment``
is set when the batch creates, changes or deletes a containment relationship."""

from __future__ import annotations

from typing import Any

from pydantic import TypeAdapter

from data_rover.api.routes.ops import _apply_batch, _BatchResult
from data_rover.api.invalidation import touched_keys
from data_rover.api.schemas import ModelOpIn
from data_rover.api.serialize import iter_entity_lines
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model

from ..driver import scenario

METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {"name": "Building", "extends": "Thing"},
        {"name": "House", "extends": "Building"},
        {"name": "Person", "extends": "Thing"},
    ],
    "relationships": [
        {
            "name": "Contains",
            "containment": True,
            "source": "Thing",
            "target": "Thing",
            "properties": [{"name": "note", "datatype": "string"}],
        },
        {"name": "Holds", "extends": "Contains", "source": "Thing", "target": "Thing"},
        {
            "name": "Knows",
            "source": "Thing",
            "target": "Thing",
            "properties": [{"name": "since", "datatype": "integer"}],
        },
    ],
}

#: (id, type, properties), in insertion order
_ELEMENTS: list[tuple[str, str, dict[str, Any]]] = [
    ("b1", "Building", {"name": "Hall"}),
    ("h1", "House", {"name": "One"}),
    ("h2", "House", {"name": "Two"}),
    ("p1", "Person", {"name": "Ann"}),
    ("p2", "Person", {"name": "Bob"}),
    ("o1", "Building", {"name": "Annex"}),
]

#: (id, type, source, target, properties)
_RELATIONSHIPS: list[tuple[str, str, str, str, dict[str, Any]]] = [
    ("r1", "Contains", "b1", "h1", {}),
    ("r2", "Contains", "b1", "h2", {}),
    ("r3", "Knows", "p1", "p2", {"since": 2020}),
    ("r4", "Holds", "b1", "p1", {}),
    ("r5", "Contains", "o1", "h2", {}),
]

_OPS = TypeAdapter(list[ModelOpIn])


def _create(new_id: str, type_name: str, **properties: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{new_id}",
        "id": new_id,
        "type_name": type_name,
        "properties": properties,
    }


def _connect(
    new_id: str, type_name: str, source: str, target: str, **properties: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{new_id}",
        "id": new_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": properties,
    }


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


def _update_rel(rel_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_relationship", "id": rel_id, "properties_patch": patch}


def _delete(entity_id: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": entity_id}


def _delete_rel(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


_CASES: list[tuple[str, list[dict[str, Any]]]] = [
    ("update a property of a leaf element", [_update("p1", name="Anna")]),
    ("update an element with one containment parent", [_update("h1", name="Uno")]),
    ("update an element with two containment parents", [_update("h2", name="Due")]),
    ("update an element with no parent", [_update("o1", name="Wing")]),
    ("create a concrete subtype", [_create("n1", "House", name="New")]),
    ("create a root of the chain's middle", [_create("n1", "Building", name="Mid")]),
    ("delete a leaf with a plain relationship", [_delete("p2")]),
    ("delete an element with containment edges", [_delete("h1")]),
    ("delete a container", [_delete("b1")]),
    ("delete an element with two parents", [_delete("h2")]),
    ("create a plain relationship", [_connect("r9", "Knows", "p2", "p1", since=1)]),
    ("create a containment relationship", [_connect("r9", "Contains", "o1", "p2")]),
    ("create a containment subtype", [_connect("r9", "Holds", "o1", "h1")]),
    ("update a plain relationship", [_update_rel("r3", since=2021)]),
    ("update a containment relationship", [_update_rel("r1", note="x")]),
    ("update a containment subtype", [_update_rel("r4", note="y")]),
    ("delete a plain relationship", [_delete_rel("r3")]),
    ("delete a containment relationship", [_delete_rel("r1")]),
    ("delete a containment subtype", [_delete_rel("r4")]),
    (
        "re-parent by deleting and creating containment",
        [_delete_rel("r1"), _connect("r9", "Contains", "o1", "h1")],
    ),
    (
        "create an element and attach it",
        [
            _create("n1", "House", name="New"),
            _connect("r9", "Contains", "o1", "n1"),
            _connect("r10", "Knows", "n1", "p1"),
        ],
    ),
    (
        "mix every kind",
        [
            _update("p1", name="Anna"),
            _create("n1", "Person", name="Cy"),
            _connect("r9", "Knows", "n1", "p1"),
            _update_rel("r3", since=1),
            _delete_rel("r2"),
            _delete("p2"),
        ],
    ),
]


def _model() -> Model:
    model = Model(Metamodel.model_validate(METAMODEL))
    for eid, type_name, properties in _ELEMENTS:
        model.insert_element(eid, type_name, properties, 0)
    for rid, type_name, source, target, properties in _RELATIONSHIPS:
        model.insert_relationship(rid, type_name, source, target, properties, 0)
    return model


def _moves_containment(model: Model, res: _BatchResult) -> bool:
    metamodel = model.metamodel
    for rid in [*res.changed_relationship_ids, *res.deleted_relationship_ids]:
        rel = model.relationships.get(rid)
        before = res.before_relationships.get(rid)
        type_name = rel.type_name if rel is not None else None
        if type_name is None and before is not None:
            type_name = before.type_name
        if type_name is not None and metamodel.is_containment(type_name):
            return True
    return False


def _sorted(keys: frozenset[tuple[str, str | None]]) -> list[list[str | None]]:
    ordered = sorted(keys, key=lambda k: (k[0], k[1] is not None, k[1] or ""))
    return [[tag, ident] for tag, ident in ordered]


def _case(name: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
    model = _model()
    res = _apply_batch(model, list(_OPS.validate_python(ops)), restore=False)
    keys = touched_keys(model, model.metamodel, res)
    assert keys is not None, name
    return {
        "name": name,
        "ops": ops,
        "element_ids": [*res.changed_element_ids, *res.deleted_element_ids],
        "relationship_ids": [
            *res.changed_relationship_ids,
            *res.deleted_relationship_ids,
        ],
        "moves_containment": _moves_containment(model, res),
        "keys": _sorted(keys),
    }


@scenario("script_touched")
def script_touched() -> Any:
    model = _model()
    lines = list(iter_entity_lines(model))
    return {
        "metamodel": model.metamodel.model_dump(mode="json"),
        "elements": lines[: len(_ELEMENTS)],
        "relationships": lines[len(_ELEMENTS) :],
        "cases": [_case(name, ops) for name, ops in _CASES],
    }
