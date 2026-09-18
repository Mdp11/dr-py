"""Op batches through the server's applier: every op kind, temp ids, id
hints, restore mode, undo, and the detail text of every refusal."""

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
            "name": "City",
            "extends": "Thing",
            "properties": [
                {"name": "population", "datatype": "integer"},
                {"name": "area", "datatype": "float"},
                {"name": "mayor", "datatype": "Person"},
                {"name": "twins", "datatype": "City", "multiplicity": "0..*"},
                {"name": "extra", "datatype": "string"},
            ],
        },
        {"name": "District", "extends": "Thing"},
        {"name": "Person", "extends": "Thing"},
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Thing", "target": "Thing"},
        {
            "name": "Knows",
            "source": "Person",
            "target": "Person",
            "properties": [
                {"name": "since", "datatype": "integer"},
                {"name": "via", "datatype": "Person"},
            ],
        },
    ],
}


def _element(temp_id: str, type_name: str, **properties: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": type_name,
        "properties": properties,
    }


def _rel(
    temp_id: str, type_name: str, source: str, target: str, **properties: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
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


_STEPS: list[dict[str, Any]] = [
    # 0: temp ids resolve in endpoints and in property values (a string, a
    # list, a nested list); an unknown temp id passes through; a dict does not
    # resolve. id-1 Rome, id-2 Ann, id-3 Bob, id-4 Owns, id-5 Knows.
    batch(
        [
            _element(
                "tmp_rome", "City", name="Rome", population=2_800_000, area=1285.0
            ),
            _element("tmp_ann", "Person", name="Ann"),
            _element("tmp_bob", "Person", name="Bob"),
            _update(
                "tmp_rome",
                mayor="tmp_ann",
                twins=["tmp_rome", "tmp_nowhere", ["tmp_ann"]],
                extra={"who": "tmp_ann"},
            ),
            _rel("tmp_owns", "Owns", "tmp_rome", "tmp_ann"),
            _rel("tmp_k", "Knows", "tmp_ann", "tmp_bob", since=2020, via="tmp_bob"),
        ]
    ),
    # 1: a temp id means nothing in a later batch
    batch([_update("tmp_rome", name="x")]),
    # 2: merge patch: replace, the same value again, null deletes, null for an
    # absent key, a new key; the inverse restores each prior value
    batch([_update("id-1", name="Roma", population=2_800_000, area=None, extra=None)]),
    batch([_update("id-2", name=None), _update("id-2", name=None)]),
    batch(
        [_update_rel("id-5", since=None, via="id-2"), _update_rel("id-5", since=1999)]
    ),
    # 5: an empty patch touches the entity and changes nothing
    batch([_update("id-3"), _update_rel("id-5")]),
    # 6: an empty batch
    batch([]),
    # 7: values keep their kind: bool, int, float, big int, negative zero
    batch(
        [
            _update("id-1", population=True),
            _update("id-1", area=-0.0),
            _update("id-1", population=2**70, area=1e22),
            _update("id-1", twins=[1, 1.0, True, None, "id-1", {"k": [1.5]}]),
        ]
    ),
    # 8: first-touch order; an entity deleted after a change leaves the changed
    # set; created and deleted in one batch, it never existed before
    batch(
        [
            _update("id-3", name="Bobby"),
            _update("id-2", name="Annie"),
            _update("id-3", name="Bob"),
            _element("tmp_d", "District", name="Centro"),
            _rel("tmp_o", "Owns", "id-1", "tmp_d"),
            _update("tmp_d", name="Centro storico"),
            _delete("tmp_d"),
            _delete_rel("id-5"),
        ]
    ),
    # 9: undo the batch above, then the first one's update of Rome
    {"do": "undo", "of": 8},
    {"do": "undo", "of": 2},
    # 11: id hints, on elements and relationships
    batch(
        [
            _element("tmp_m", "City", name="Milan") | {"id": "city-milan"},
            _rel("tmp_t", "Owns", "tmp_m", "id-3") | {"id": "owns-milan-bob"},
            _update("tmp_m", mayor="tmp_t"),
        ]
    ),
    batch([_element("tmp_x", "City") | {"id": "city-milan"}]),
    batch([_element("tmp_x", "City") | {"id": "owns-milan-bob"}]),
    batch([_rel("tmp_x", "Knows", "id-2", "id-3") | {"id": "city-milan"}]),
    batch([_element("tmp_x", "City") | {"id": "tmp_taken"}]),
    batch([_rel("tmp_x", "Knows", "id-2", "id-3") | {"id": "tmp_taken"}]),
    # 17: a temp id without the prefix is refused, and is an exact id in
    # restore mode
    batch([_element("plain", "City")]),
    batch([_rel("plain", "Knows", "id-2", "id-3")]),
    batch(
        [
            _element("plain", "City", name="Plain"),
            _rel("plain-knows", "Knows", "id-2", "id-3", since=1),
            _element("tmp_still", "Person", name="Minted"),
        ],
        restore=True,
    ),
    batch([_element("plain", "City")], restore=True),
    # 21: a cascade: Rome owns Ann (id-4), who owns a child, and a district
    # that owns a person who knows herself. The closure is walked from a
    # stack; the inverse recreates elements first, then relationships.
    batch(
        [
            _element("tmp_d", "District", name="Trastevere"),
            _rel("tmp_o1", "Owns", "id-1", "tmp_d"),
            _element("tmp_p", "Person", name="Eve"),
            _rel("tmp_o2", "Owns", "tmp_d", "tmp_p"),
            _rel("tmp_self", "Knows", "tmp_p", "tmp_p"),
            _rel("tmp_in", "Knows", "id-3", "tmp_p", since=5),
            _element("tmp_kid", "Person", name="Kid"),
            _rel("tmp_o3", "Owns", "id-2", "tmp_kid"),
            _update("city-milan", twins=["id-1"]),
        ]
    ),
    batch([_delete("id-1")]),
    {"do": "undo", "of": 22},
    # 24: a rewire keeps the id and changes the ends
    batch(
        [
            _delete_rel("plain-knows"),
            _rel("tmp_r", "Knows", "id-3", "id-2", since=2) | {"id": "plain-knows"},
        ]
    ),
    # 25: the same id under another type
    batch(
        [_delete("plain"), _element("tmp_r", "Person", name="Plain") | {"id": "plain"}]
    ),
    # 26: refusals; each leaves no trace. A create fails at its third property.
    batch([_element("tmp_a", "City", name="a"), _element("tmp_b", "Nope")]),
    batch([_element("tmp_a", "Thing")]),
    batch([_element("tmp_a", "City", name="a", population=1, nope=2)]),
    batch([_update("id-3", name="kept?"), _update("id-3", nope=1)]),
    batch([_delete("id-3"), _update("ghost")]),
    batch([_delete("ghost")]),
    batch([_delete_rel("ghost")]),
    batch([_update_rel("ghost")]),
    batch([_update_rel("plain-knows", nope=1)]),
    batch([_update("plain-knows")]),
    batch([_delete("plain-knows")]),
    batch([_delete_rel("id-3")]),
    batch([_rel("tmp_x", "Nope", "id-2", "id-3")]),
    batch([_rel("tmp_x", "Knows", "ghost", "id-3")]),
    batch([_rel("tmp_x", "Knows", "id-2", "ghost")]),
    batch([_rel("tmp_x", "Knows", "id-2", "id-3", since=1, nope=2)]),
    # the detail of a missing key loses the quotes at its ends, whichever they are
    batch([_delete("it's")]),
    batch([_delete('say "hi"')]),
    batch([_delete('it\'s "both"')]),
    batch([_delete("'")]),
    # an undo across a type change, and one whose entities are gone
    {"do": "undo", "of": 25},
    {"do": "undo", "of": 21},
    {"do": "undo", "of": 21},
]


@scenario("ops_batches")
def ops_batches() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
