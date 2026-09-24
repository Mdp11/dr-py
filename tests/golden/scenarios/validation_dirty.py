"""Dirty sets: what the server's applier collects for each op kind, in order,
over a model where every hook has something to add — uniqueness groups of
two or more, referencers, containment re-parenting, a cascade three levels
deep with relationships at every level, several keys in one update, a create
whose properties move it through two groups, id hints and restore mode, and a
relationship type named in a key, which re-keys its ends when it is connected,
disconnected or deleted with a cascade."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps

_METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Node",
            "extends": "Thing",
            "properties": [
                {"name": "code", "datatype": "string"},
                {"name": "note", "datatype": "string"},
                {"name": "ref", "datatype": "Node"},
                {"name": "refs", "datatype": "Node", "multiplicity": "0..*"},
            ],
            "key": ["code"],
        },
        # keyed on its wires as well: connecting one re-keys both ends
        {
            "name": "Port",
            "extends": "Thing",
            "properties": [{"name": "code", "datatype": "string"}],
            "key": ["code", "out:Wire", "in:Wire"],
        },
        # keyless: every property is its identity
        {
            "name": "Tag",
            "extends": "Thing",
            "properties": [
                {"name": "v", "datatype": "string"},
                {"name": "w", "datatype": "integer"},
            ],
        },
    ],
    "relationships": [
        {"name": "Has", "containment": True, "source": "Thing", "target": "Thing"},
        {"name": "Wire", "source": "Port", "target": "Port"},
        {
            "name": "Link",
            "source": "Node",
            "target": "Node",
            "properties": [
                {"name": "lbl", "datatype": "string"},
                {"name": "n", "datatype": "integer"},
                {"name": "to", "datatype": "Node"},
            ],
        },
    ],
}


def _el(entity_id: str | None, type_name: str, **properties: Any) -> dict[str, Any]:
    """A create; without an id the server mints one."""
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{entity_id or type_name}",
        "id": entity_id,
        "type_name": type_name,
        "properties": properties,
    }


def _rel(
    entity_id: str | None, type_name: str, source: str, target: str, **properties: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{entity_id or type_name}",
        "id": entity_id,
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


def _dirty(ops: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return batch(ops, record_dirty=True, **extra)


_ELEMENTS = [
    _el("r-1", "Node", code="R1"),
    _el("r-2", "Node", code="R2"),
    # no code: the group of every code-less top-level Node
    _el("n-0", "Node", name="zero"),
    # three of a kind, then one alone
    _el("n-1", "Node", code="A"),
    _el("n-2", "Node", code="A"),
    _el("n-3", "Node", code="A"),
    _el("n-4", "Node", code="B"),
    # referencers, one of them naming an id nothing holds yet
    _el("n-5", "Node", code="C", ref="n-1"),
    _el("n-6", "Node", code="D", refs=["n-1", "n-2"]),
    _el("n-7", "Node", code="E", ref="n-new"),
    # a-1 shares n-1's key until r-1 contains it
    _el("a-1", "Node", code="A"),
    # the cascade: c-1 > c-2 > {c-3, c-4}, c-3 and c-4 identical under c-2
    _el("c-1", "Node", code="C1"),
    _el("c-2", "Node", code="C2"),
    _el("c-3", "Node", code="X"),
    _el("c-4", "Node", code="X"),
    _el("n-8", "Node", code="F", ref="c-2"),
    _el("n-9", "Node", code="G", refs=["c-3", "c-4"]),
    _el("t-0", "Tag"),
    _el("t-1", "Tag", v="x"),
    _el("t-2", "Tag", v="x"),
    _el("t-3", "Tag", v="x", w=1),
    _el("t-9", "Tag", v="x", w=1),
]

_RELATIONSHIPS = [
    _rel("h-1", "Has", "r-1", "a-1"),
    _rel("h-2", "Has", "c-1", "c-2"),
    _rel("h-3", "Has", "c-2", "c-3"),
    _rel("h-4", "Has", "c-2", "c-4"),
    _rel("h-5", "Has", "n-4", "t-9"),
    # relationships at every level of the cascade, and a self-loop
    _rel("l-1", "Link", "c-1", "n-4", lbl="a"),
    _rel("l-2", "Link", "n-1", "c-2"),
    _rel("l-3", "Link", "c-3", "n-2", lbl="b", n=1, to="c-1"),
    _rel("l-4", "Link", "c-4", "c-4"),
    _rel("l-5", "Link", "c-3", "c-4"),
    # a minted id
    _rel(None, "Link", "n-4", "n-5"),
]

_STEPS: list[dict[str, Any]] = [
    _dirty(_ELEMENTS),
    _dirty(_RELATIONSHIPS),
    # empty props, then v, then w: three groups; a hint that heals n-7's ref
    _dirty(
        [
            _el(None, "Tag", v="x", w=1),
            _el("n-new", "Node", code="A", name="new"),
        ]
    ),
    # several keys, one removing a key that is not there
    _dirty([_update("n-2", code="B", note="moved", ref="n-3", name=None)]),
    _dirty([_update("t-1", w=1), _update("n-5", ref=None)]),
    # re-parenting into r-1's group, a second parent, a link with properties
    _dirty(
        [
            _rel("h-6", "Has", "r-1", "n-3"),
            _rel("h-7", "Has", "r-2", "n-3"),
            _rel("l-6", "Link", "n-1", "n-5", lbl="c", n=2, to="n-4"),
        ]
    ),
    _dirty([_update_rel("l-3", lbl="d", n=None, to="n-1")]),
    # n-3 falls back to its second parent's group
    _dirty([_delete_rel("h-6"), _delete_rel("l-6")]),
    _dirty([_delete("c-1")]),
    # restore mode: the cascade comes back, n-8's reference heals
    {"do": "undo", "of": 8, "record_dirty": True},
    _dirty([_delete("n-1"), _delete("t-9")]),
    # restore mode on a batch of its own
    _dirty(
        [
            {
                "kind": "create_element",
                "temp_id": "n-1",
                "type_name": "Node",
                "properties": {"code": "A"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "l-7",
                "type_name": "Has",
                "source_id": "r-2",
                "target_id": "n-1",
                "properties": {},
            },
        ],
        restore=True,
    ),
    # a-1 leaves r-1 for the top level, where n-new shares its key
    _dirty([_delete_rel("h-1")]),
    # ports: p-1 and p-2 alike, p-4 alike to p-3 but inside a box
    _dirty(
        [
            _el("p-1", "Port", code="a"),
            _el("p-2", "Port", code="a"),
            _el("p-3", "Port", code="z"),
            _el("p-5", "Port", code="z"),
            _el("box", "Tag", v="box"),
            _el("p-4", "Port", code="z"),
            _rel("h-9", "Has", "box", "p-4"),
        ]
    ),
    # a wire takes p-1 out of p-2's group and p-3 out of p-5's
    _dirty([_rel("w-1", "Wire", "p-1", "p-3")]),
    # and back
    _dirty([_delete_rel("w-1")]),
    _dirty([_rel("w-2", "Wire", "p-2", "p-4")]),
    # the box goes with p-4 and its wire: p-2 rejoins p-1's group
    _dirty([_delete("box")]),
]


@scenario("validation_dirty")
def validation_dirty() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
