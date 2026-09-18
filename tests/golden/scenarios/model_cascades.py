"""``delete_element`` cascading through containment: nested, shared, cyclic,
self-contained, parallel and inherited containment, and what it leaves alone."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import run_steps, set_property

_METAMODEL = {
    "elements": [
        {"name": "Node", "properties": [{"name": "name", "datatype": "string"}]}
    ],
    "relationships": [
        {"name": "Contains", "containment": True, "source": "Node", "target": "Node"},
        # containment is inherited from the parent relationship type
        {"name": "Holds", "extends": "Contains", "source": "Node", "target": "Node"},
        {"name": "Refers", "source": "Node", "target": "Node"},
    ],
}


def _nodes(*names: str) -> list[dict[str, Any]]:
    return [{"do": "restore_element", "id": name, "type": "Node"} for name in names]


def _edge(rel_id: str, rel_type: str, source: str, target: str) -> dict[str, Any]:
    return {
        "do": "restore_relationship",
        "id": rel_id,
        "type": rel_type,
        "source": source,
        "target": target,
    }


_STEPS: list[dict[str, Any]] = [
    # nested: a > b > c, with edges to and from an outsider
    *_nodes("a", "b", "c", "out"),
    _edge("a-b", "Contains", "a", "b"),
    _edge("b-c", "Holds", "b", "c"),
    _edge("c-out", "Refers", "c", "out"),
    _edge("out-b", "Refers", "out", "b"),
    set_property("c", "name", "deep"),
    {"do": "delete_element", "id": "a"},
    # shared: x has two containment parents; deleting either takes x along
    *_nodes("p", "q", "x"),
    _edge("p-x", "Contains", "p", "x"),
    _edge("q-x", "Contains", "q", "x"),
    {"do": "container_of", "id": "x"},
    {"do": "disconnect", "id": "p-x"},
    {"do": "container_of", "id": "x"},
    _edge("p-x", "Contains", "p", "x"),
    {"do": "container_of", "id": "x"},
    {"do": "delete_element", "id": "p"},
    # cyclic containment, and an element containing itself
    *_nodes("m", "n", "self"),
    _edge("m-n", "Contains", "m", "n"),
    _edge("n-m", "Contains", "n", "m"),
    _edge("self-self", "Contains", "self", "self"),
    _edge("self-loop", "Refers", "self", "self"),
    {"do": "delete_element", "id": "m"},
    {"do": "delete_element", "id": "self"},
    # parallel containment edges keep relationship order when one goes
    *_nodes("u", "v", "w"),
    _edge("u-w-1", "Contains", "u", "w"),
    _edge("v-w", "Contains", "v", "w"),
    _edge("u-w-2", "Contains", "u", "w"),
    {"do": "disconnect", "id": "u-w-1"},
    {"do": "container_of", "id": "w"},
    {"do": "delete_element", "id": "w"},
    {"do": "delete_element", "id": "u"},
]


@scenario("model_cascades")
def model_cascades() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
