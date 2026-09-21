"""The read routes the engine ports, by id and by page: elements, a type
filter, incident relationships and the summary — before and after churn, so
state order after a restore and a type that empties are held too."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, read_step, run_steps

METAMODEL = {
    "elements": [
        {
            "name": "Node",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "note", "datatype": "string"},
                {"name": "weight", "datatype": "float"},
                {"name": "tags", "datatype": "string", "multiplicity": "0..*"},
                {"name": "peer", "datatype": "Node"},
            ],
        },
        {"name": "Leaf", "extends": "Node"},
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Node", "target": "Node"},
        {
            "name": "Links",
            "source": "Node",
            "target": "Node",
            "properties": [{"name": "label", "datatype": "string"}],
        },
    ],
}

#: elements id-1 .. id-30; ids 10, 20, 25 and 30 are the leaves
_LEAVES = {10, 20, 25, 30}

_SPECIAL: dict[int, dict[str, Any]] = {
    2: {"weight": 1.0},
    3: {"weight": 2**53 + 1, "tags": ["x", "y"]},
    4: {"note": {"z": 1, "a": {"y": 2, "b": [3, 1.5]}}},
    5: {"name": ["", "listed", "second"]},
    6: {"peer": "id-1", "note": "café \U0001f600"},
}


def _element(i: int) -> dict[str, Any]:
    properties: dict[str, Any] = {"name": f"node {i:02d}"}
    properties.update(_SPECIAL.get(i, {}))
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{i}",
        "type_name": "Leaf" if i in _LEAVES else "Node",
        "properties": properties,
    }


def _rel(i: int, kind: str, source: int, target: int, **props: Any) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_r{i}",
        "type_name": kind,
        "source_id": f"id-{source}",
        "target_id": f"id-{target}",
        "properties": props,
    }


#: relationships id-31 ..: id-1 owns 7, 8 and 9 and links out to 11, 12, 13
#: and in from 14; 15 links to itself; 16 links twice to 17
_RELATIONSHIPS = [
    _rel(1, "Owns", 1, 7),
    _rel(2, "Owns", 1, 8),
    _rel(3, "Owns", 1, 9),
    _rel(4, "Links", 1, 11, label="b"),
    _rel(5, "Links", 1, 12),
    _rel(6, "Links", 1, 13, label="a"),
    _rel(7, "Links", 14, 1),
    _rel(8, "Links", 15, 15, label="self"),
    _rel(9, "Links", 16, 17),
    _rel(10, "Links", 16, 17, label="parallel"),
    _rel(11, "Owns", 7, 18),
]


def _reads() -> list[dict[str, Any]]:
    return [
        read_step("getElement", id="id-1"),
        *[read_step("getElement", id=f"id-{i}") for i in sorted(_SPECIAL)],
        read_step("getElement", id="ghost"),
        read_step("getElementsBatch", ids=["id-3", "id-1", "id-3", "ghost", "id-2"]),
        read_step("getElementsBatch", ids=[]),
        read_step("getElementsBatch", ids=["id-1"] * 501),
        read_step("listElementsPage"),
        *[read_step("listElementsPage", limit=7, offset=o) for o in (0, 7, 28, 35)],
        read_step("listElementsPage", type="Leaf"),
        read_step("listElementsPage", type="Node", limit=5, offset=20),
        read_step("listElementsPage", type="Nope"),
        read_step("listElementsPage", type="Leaf", offset=4),
        *[
            read_step("listElementRelationships", id="id-15", direction=d)
            for d in ("both", "in", "out")
        ],
        read_step("listElementRelationships", id="id-1", limit=2),
        read_step("listElementRelationships", id="id-1", limit=2, offset=2),
        read_step("listElementRelationships", id="id-1", direction="out", offset=5),
        read_step("listElementRelationships", id="id-16", direction="out"),
        read_step("listElementRelationships", id="id-17", direction="in"),
        read_step("listElementRelationships", id="id-29"),
        read_step("listElementRelationships", id="ghost"),
        read_step("getModelSummary"),
    ]


_STEPS: list[dict[str, Any]] = [
    batch([_element(i) for i in range(1, 31)]),
    batch(_RELATIONSHIPS),
    *_reads(),
    # churn: a cascade and a restore, a type emptied, a rename
    batch([{"kind": "delete_element", "id": "id-1"}]),
    {"do": "restore_element", "id": "id-1", "type": "Node"},
    batch([{"kind": "delete_element", "id": f"id-{i}"} for i in sorted(_LEAVES)]),
    batch(
        [
            {
                "kind": "update_element",
                "id": "id-15",
                "properties_patch": {"name": "renamed"},
            }
        ]
    ),
    *_reads(),
]


@scenario("read_pages")
def read_pages() -> Any:
    return run_steps(Metamodel.model_validate(METAMODEL), _STEPS)
