"""The indexes under churn: root order and display names, uniqueness with and
without a key, owner changes, numeric collisions, references, and where a
restored entity lands in state order."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import run_steps, set_property

_NAME_PROPS = [
    {"name": "name", "datatype": "string", "multiplicity": "0..*"},
    {"name": "Name", "datatype": "string"},
    {"name": "NAME", "datatype": "string"},
]

_METAMODEL = {
    "elements": [
        {"name": "Named", "abstract": True, "properties": _NAME_PROPS},
        {
            "name": "Loose",
            "extends": "Named",
            "properties": [
                {"name": "a", "datatype": "float"},
                {"name": "b", "datatype": "string"},
            ],
        },
        {
            "name": "Keyed",
            "extends": "Named",
            "properties": [{"name": "code", "datatype": "integer"}],
            "key": ["code", "out:Tags", "in:Tags"],
        },
        {
            "name": "Holder",
            "extends": "Named",
            "properties": [
                {"name": "one", "datatype": "Keyed"},
                {"name": "many", "datatype": "Named", "multiplicity": "0..*"},
                {"name": "plain", "datatype": "string"},
            ],
            "key": ["plain"],
        },
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Named", "target": "Named"},
        {
            "name": "Tags",
            "source": "Keyed",
            "target": "Keyed",
            "properties": [{"name": "via", "datatype": "Loose"}],
        },
        {"name": "SubTags", "extends": "Tags", "source": "Keyed", "target": "Keyed"},
    ],
}


def _create(type_name: str) -> dict[str, Any]:
    return {"do": "create_element", "type": type_name}


def _connect(rel_type: str, source: str, target: str) -> dict[str, Any]:
    return {"do": "connect", "type": rel_type, "source": source, "target": target}


_ROOT_NAMES: list[Any] = [
    "b", "a", "B", "", "\u00e9", "e\u0301", "\ue000", "\uffff", "\U0001f600", "\U00010000",
    "a", ["", "zeta"], [], 5, None,
]  # fmt: skip

_STEPS: list[dict[str, Any]] = [
    # --- root order: names by code point, ties by id, fallbacks to the id ---
    *[_create("Loose") for _ in _ROOT_NAMES],  # id-1 .. id-15
    *[set_property(f"id-{i + 1}", "name", name) for i, name in enumerate(_ROOT_NAMES)],
    # another casing counts only when the exact `name` yields nothing
    set_property("id-4", "NAME", "upper"),
    set_property("id-4", "Name", "title"),
    set_property("id-1", "Name", "ignored"),
    {"do": "delete_property", "id": "id-4", "prop": "NAME"},
    set_property("id-2", "name", "zz"),
    {"do": "delete_property", "id": "id-2", "prop": "name"},
    # a contained element is no root; renaming it moves nothing
    _connect("Owns", "id-1", "id-2"),  # id-16
    set_property("id-2", "name", "inner"),
    _connect("Owns", "id-3", "id-2"),  # id-17
    {"do": "disconnect", "id": "id-16"},
    {"do": "disconnect", "id": "id-17"},
    # --- state order: a restored entity lands last ---
    _connect("Owns", "id-1", "id-2"),  # id-18
    {"do": "delete_element", "id": "id-5"},
    {"do": "restore_element", "id": "id-5", "type": "Loose"},
    {"do": "disconnect", "id": "id-18"},
    {"do": "restore_relationship", "id": "id-18", "type": "Owns", "source": "id-1", "target": "id-2"},
    # --- uniqueness without a key: every property, numbers by value ---
    *[_create("Loose") for _ in range(8)],  # id-19 .. id-26
    set_property("id-19", "a", 1),
    set_property("id-20", "a", 1.0),
    set_property("id-21", "a", True),
    set_property("id-22", "a", 0),
    set_property("id-23", "a", -0.0),
    set_property("id-24", "a", False),
    set_property("id-25", "a", 2**53),
    set_property("id-26", "a", float(2**53)),
    set_property("id-25", "a", 2**53 + 1),
    set_property("id-19", "a", "1"),
    # key order inside a value and property order do not matter; list order does
    set_property("id-19", "a", {"x": 1, "y": [1, 2]}),
    set_property("id-20", "a", {"y": [1.0, 2.0], "x": True}),
    set_property("id-21", "a", {"y": [2, 1], "x": 1}),
    set_property("id-22", "b", "same"),
    set_property("id-22", "a", 7),
    set_property("id-23", "a", 7),
    set_property("id-23", "b", "same"),
    # an explicit null is a property like any other
    set_property("id-24", "a", None),
    {"do": "delete_property", "id": "id-24", "prop": "a"},
    # --- the owner is part of the identity ---
    _connect("Owns", "id-1", "id-22"),  # id-27
    _connect("Owns", "id-3", "id-23"),  # id-28
    {"do": "disconnect", "id": "id-28"},
    _connect("Owns", "id-1", "id-23"),  # id-29
    # only the FIRST containment parent counts
    _connect("Owns", "id-3", "id-23"),  # id-30
    {"do": "disconnect", "id": "id-29"},
    # --- uniqueness with a key: properties, then edges of exactly that type ---
    *[_create("Keyed") for _ in range(4)],  # id-31 .. id-34
    set_property("id-31", "code", 1),
    set_property("id-32", "code", 1.0),
    set_property("id-31", "name", "not part of the key"),
    set_property("id-33", "code", None),
    _connect("Tags", "id-31", "id-33"),  # id-35: out of id-31, in of id-33
    _connect("Tags", "id-32", "id-33"),  # id-36
    _connect("Tags", "id-32", "id-34"),  # id-37
    {"do": "disconnect", "id": "id-37"},
    _connect("SubTags", "id-32", "id-34"),  # id-38: a subtype edge is not in the key
    _connect("Tags", "id-31", "id-33"),  # id-39: a parallel edge counts twice
    {"do": "disconnect", "id": "id-39"},
    {"do": "delete_element", "id": "id-33"},
    # --- references: scalar, list, dangling, on a relationship ---
    *[_create("Holder") for _ in range(2)],  # id-40, id-41
    set_property("id-40", "one", "id-31"),
    set_property("id-40", "many", ["id-31", "id-32", 5, None, "id-31", "nowhere"]),
    set_property("id-41", "many", "id-31"),
    set_property("id-41", "one", 12),
    set_property("id-40", "plain", "id-32"),
    _connect("Tags", "id-31", "id-32"),  # id-42
    set_property("id-42", "via", "id-19"),
    set_property("id-42", "via", ["id-20", "id-40"]),
    set_property("id-40", "many", ["id-32"]),
    {"do": "delete_element", "id": "id-31"},
    {"do": "delete_property", "id": "id-40", "prop": "one"},
    {"do": "restore_element", "id": "nowhere", "type": "Loose"},
    {"do": "delete_element", "id": "id-40"},
]  # fmt: skip


@scenario("model_indexes")
def model_indexes() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
