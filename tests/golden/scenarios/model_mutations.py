"""Every method of the mutation boundary, with the text of every error."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import run_steps, set_property

_METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "City",
            "extends": "Thing",
            "properties": [
                {"name": "population", "datatype": "integer"},
                {"name": "mayor", "datatype": "Person"},
            ],
        },
        {"name": "Person", "extends": "Thing"},
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "City", "target": "Person"},
        {
            "name": "Knows",
            "source": "Person",
            "target": "Person",
            "properties": [{"name": "since", "datatype": "integer"}],
        },
    ],
}

_STEPS: list[dict[str, Any]] = [
    # create_element
    {"do": "create_element", "type": "City"},  # id-1
    {"do": "create_element", "type": "Thing"},
    {"do": "create_element", "type": "Nope"},
    {"do": "create_element", "type": "Person"},  # id-2: a failed create mints no id
    {"do": "create_element", "type": "Person"},  # id-3
    # set_property: every write bumps rev, the same value included
    set_property("id-1", "name", "Rome"),
    set_property("id-1", "name", "Rome"),
    set_property("id-1", "population", 2_800_000),
    set_property("id-1", "nope", 1),
    set_property("ghost", "name", "x", detached="element", type="City"),
    set_property("id-1", "name", "x", detached="element", type="City"),
    # delete_property: an absent key is a no-op, a present one bumps rev
    {"do": "delete_property", "id": "id-2", "prop": "name"},
    {"do": "delete_property", "id": "id-1", "prop": "population"},
    {"do": "delete_property", "id": "id-1", "prop": "nope"},
    {"do": "delete_property", "id": "ghost", "prop": "name", "detached": "element", "type": "City"},
    # connect
    {"do": "connect", "type": "Owns", "source": "id-1", "target": "id-2"},  # id-4
    {"do": "connect", "type": "Knows", "source": "id-2", "target": "id-3"},  # id-5
    {"do": "connect", "type": "Nope", "source": "id-1", "target": "id-2"},
    {"do": "connect", "type": "Knows", "source": "nobody", "target": "id-2"},
    {"do": "connect", "type": "Knows", "source": "id-2", "target": "nobody"},
    set_property("id-5", "since", 2020),
    set_property("id-5", "name", "x"),
    set_property("ghost", "since", 1, detached="relationship", type="Knows"),
    {"do": "delete_property", "id": "id-5", "prop": "since"},
    # queries
    {"do": "get_element", "id": "id-1"},
    {"do": "get_element", "id": "nobody"},
    {"do": "get_element", "id": "it's"},
    {"do": "get_element", "id": "id-4"},
    {"do": "get_relationship", "id": "id-4"},
    {"do": "get_relationship", "id": "id-1"},
    {"do": "container_of", "id": "id-2"},
    {"do": "container_of", "id": "id-1"},
    {"do": "container_of", "id": "nobody"},
    {"do": "relationships_from", "id": "id-2"},
    {"do": "relationships_to", "id": "id-2"},
    {"do": "relationships_from", "id": "nobody"},
    # restore_element: the type guards come before the id guard
    {"do": "restore_element", "id": "id-1", "type": "Nope"},
    {"do": "restore_element", "id": "id-1", "type": "Thing"},
    {"do": "restore_element", "id": "id-1", "type": "City"},
    {"do": "restore_element", "id": "id-4", "type": "City"},
    {"do": "restore_element", "id": "kept", "type": "City"},
    # restore_relationship: type, source, target, then the id
    {"do": "restore_relationship", "id": "id-4", "type": "Nope", "source": "x", "target": "y"},
    {"do": "restore_relationship", "id": "id-4", "type": "Knows", "source": "x", "target": "id-2"},
    {"do": "restore_relationship", "id": "id-4", "type": "Knows", "source": "id-2", "target": "y"},
    {"do": "restore_relationship", "id": "id-4", "type": "Knows", "source": "id-2", "target": "id-3"},
    {"do": "restore_relationship", "id": "id-1", "type": "Knows", "source": "id-2", "target": "id-3"},
    {"do": "restore_relationship", "id": "link", "type": "Knows", "source": "id-3", "target": "id-2"},
    # disconnect, delete_element
    {"do": "disconnect", "id": "nobody"},
    {"do": "disconnect", "id": "id-1"},
    {"do": "disconnect", "id": "id-5"},
    {"do": "delete_element", "id": "nobody"},
    {"do": "delete_element", "id": "id-4"},
    {"do": "delete_element", "id": "id-3"},
    # a deleted id is free again, and a fresh create keeps counting
    {"do": "restore_element", "id": "id-3", "type": "Person"},
    {"do": "create_element", "type": "Person"},  # id-6
]  # fmt: skip


@scenario("model_mutations")
def model_mutations() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
