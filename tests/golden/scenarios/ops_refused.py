"""Batches refused midway, after each kind of touch: an update, a cascade,
a create left half made, an entity created again under its id, a rewire, a
restore-mode batch. The recorder fails the run when one leaves a trace, so
what the fixture holds is that none does — every ``rev``, every place in
insertion order and every index as it was — with landed batches in between to
show the state carries on from there."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps

_METAMODEL = {
    "elements": [
        {
            "name": "Node",
            "key": ["name"],
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "note", "datatype": "string"},
                {"name": "peer", "datatype": "Node"},
            ],
        }
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Node", "target": "Node"},
        {
            "name": "Link",
            "source": "Node",
            "target": "Node",
            "properties": [{"name": "label", "datatype": "string"}],
        },
    ],
}


def _node(temp_id: str, name: str, **extra: Any) -> dict[str, Any]:
    properties = {"name": name, **extra.pop("properties", {})}
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": properties,
        **extra,
    }


def _rel(
    temp_id: str, kind: str, source: str, target: str, **extra: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": kind,
        "source_id": source,
        "target_id": target,
        **extra,
    }


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


def _update_rel(rel_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_relationship", "id": rel_id, "properties_patch": patch}


def _delete(entity_id: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": entity_id}


def _disconnect(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


#: the op every refused batch ends on
_GHOST = _update("ghost", note="never")

_STEPS: list[dict[str, Any]] = [
    # id-1 a, id-2 b, id-3 c, id-4 d (peer: c); id-5 a holds c, id-6 b holds c
    # (c's first parent is a), id-7 c links d, id-8 d links a
    batch(
        [
            _node("tmp_a", "a"),
            _node("tmp_b", "b"),
            _node("tmp_c", "c"),
            _node("tmp_d", "d", properties={"peer": "tmp_c"}),
            _rel("tmp_h1", "Holds", "tmp_a", "tmp_c"),
            _rel("tmp_h2", "Holds", "tmp_b", "tmp_c"),
            _rel("tmp_l1", "Link", "tmp_c", "tmp_d", properties={"label": "x"}),
            _rel("tmp_l2", "Link", "tmp_d", "tmp_a"),
        ]
    ),
    # revs apart from one another, so a rev put back wrong shows
    batch([_update("id-2", note="n"), _update_rel("id-7", label="y")]),
    # updates: properties and rev go back, a key removed comes back
    batch(
        [
            _update("id-3", name="c2", note="new"),
            _update("id-2", note=None),
            _update_rel("id-7", label="z"),
            _GHOST,
        ]
    ),
    # an update that made a duplicate of a, and moved a root
    batch([_update("id-2", name="a"), _GHOST]),
    # a cascade: a takes c with it, and with them every relationship there is
    batch([_delete("id-1"), _GHOST]),
    # the relationship that makes a the FIRST parent of c, alone
    batch([_disconnect("id-5"), _GHOST]),
    # new entities, one of them holding an old one; then a create that fails
    # on its second property, its element already made
    batch(
        [
            _node("tmp_x", "x"),
            _rel("tmp_hx", "Holds", "tmp_x", "id-4"),
            _rel("tmp_lx", "Link", "tmp_x", "id-1", properties={"label": "new"}),
            _node("tmp_y", "y", properties={"nope": 1}),
        ]
    ),
    # b takes c with it; both are created again under their ids, and so is
    # the relationship between them
    batch(
        [
            _delete("id-2"),
            _node("tmp_b2", "b again", id="id-2"),
            _node("tmp_c2", "c again", id="id-3"),
            _rel("tmp_h3", "Holds", "tmp_b2", "tmp_c2", id="id-6"),
            _GHOST,
        ]
    ),
    # a rewire: the relationship created again under its id, at other ends
    batch(
        [
            _disconnect("id-7"),
            _rel("tmp_l3", "Link", "id-4", "id-3", id="id-7"),
            _GHOST,
        ]
    ),
    # refused for a value, not a key
    batch(
        [
            _update("id-1", note="gone again"),
            {"kind": "create_element", "temp_id": "bare", "type_name": "Node"},
        ]
    ),
    # a restore-mode batch reinstates an exact id, then fails
    batch(
        [
            {"kind": "create_element", "temp_id": "id-40", "type_name": "Node"},
            _delete("id-4"),
            _GHOST,
        ],
        restore=True,
    ),
    # the state carries on: id-9 is the next id, and goes last
    batch([_node("tmp_e", "e"), _rel("tmp_le", "Link", "tmp_e", "id-2")]),
    batch([_delete("id-2")]),
    {"do": "undo", "of": 12},
    # an undone delete left b and its relationships last; refuse over that
    batch([_update("id-2", note="m"), _delete("id-3"), _delete("id-9"), _GHOST]),
]


@scenario("ops_refused")
def ops_refused() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS, full_every=1)
