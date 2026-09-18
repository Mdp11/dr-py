"""An entity deleted and created again under its own id, unchanged in type
and ends, within one batch. The applier's bookkeeping is what is on show: the
first before-image stays, the id leaves the deleted set, and the entity moves
to the end of the state order. No delta can say so, which is why this scenario
is kept apart from the ones a replica follows."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps

_METAMODEL = {
    "elements": [
        {"name": "Node", "properties": [{"name": "name", "datatype": "string"}]}
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Node", "target": "Node"},
        {"name": "Link", "source": "Node", "target": "Node"},
    ],
}


def _node(temp_id: str, name: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": {"name": name},
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


_STEPS: list[dict[str, Any]] = [
    # id-1 a, id-2 b, id-3 c, id-4 a holds b, id-5 b links c, id-6 a links c
    batch(
        [
            _node("tmp_a", "a"),
            _node("tmp_b", "b"),
            _node("tmp_c", "c"),
            _rel("tmp_h", "Holds", "tmp_a", "tmp_b"),
            _rel("tmp_l", "Link", "tmp_b", "tmp_c"),
            _rel("tmp_m", "Link", "tmp_a", "tmp_c"),
        ]
    ),
    # the element, and with it the relationship its cascade took
    batch(
        [
            {"kind": "delete_element", "id": "id-2"},
            _node("tmp_x", "b", id="id-2"),
            _rel("tmp_y", "Link", "tmp_x", "id-3", id="id-5"),
        ]
    ),
    # the relationship alone
    batch(
        [
            {"kind": "delete_relationship", "id": "id-6"},
            _rel("tmp_z", "Link", "id-1", "id-3", id="id-6"),
        ]
    ),
    {"do": "undo", "of": 1},
]


@scenario("ops_recreate")
def ops_recreate() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
