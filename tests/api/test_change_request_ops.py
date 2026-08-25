from __future__ import annotations

import pytest

from data_rover.api.change_request_ops import UnsupportedChangeError, ops_for_change
from data_rover.core.model.change_request import (
    ChangeRequest,
    ModifiedElement,
    ModifiedRelationship,
)
from data_rover.core.model.element import Element
from data_rover.core.model.relationship import Relationship


def _el(eid: str, type_name: str = "Item", **props) -> Element:
    return Element(id=eid, type_name=type_name, properties=dict(props))


def _rel(rid: str, src: str, tgt: str, type_name: str = "Links", **props) -> Relationship:
    return Relationship(
        id=rid, type_name=type_name, source_id=src, target_id=tgt, properties=dict(props)
    )


def _dump(ops) -> list[dict]:
    return [op.model_dump() for op in ops]


def test_creates_carry_id_hint_and_batch_temp_ids() -> None:
    cr = ChangeRequest(
        elements_added=[_el("n1", name="N1"), _el("n2", name="N2")],
        relationships_added=[_rel("r1", "n1", "n2", weight=3)],
    )
    ops = _dump(ops_for_change(cr))
    assert ops == [
        {
            "kind": "create_element",
            "temp_id": "tmp_1",
            "id": "n1",
            "type_name": "Item",
            "properties": {"name": "N1"},
        },
        {
            "kind": "create_element",
            "temp_id": "tmp_2",
            "id": "n2",
            "type_name": "Item",
            "properties": {"name": "N2"},
        },
        {
            "kind": "create_relationship",
            "temp_id": "tmp_3",
            "id": "r1",
            "type_name": "Links",
            # endpoints on same-CR additions reference the TEMP id, so the
            # client stages them lock-free and id_map resolves them
            "source_id": "tmp_1",
            "target_id": "tmp_2",
            "properties": {"weight": 3},
        },
    ]


def test_relationship_to_existing_element_keeps_real_endpoint() -> None:
    cr = ChangeRequest(relationships_added=[_rel("r1", "a", "b")])
    [op] = _dump(ops_for_change(cr))
    assert (op["source_id"], op["target_id"]) == ("a", "b")


def test_modified_becomes_merge_patch_with_null_for_removed_keys() -> None:
    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(
                id="a",
                before=_el("a", name="A", note="old", keep="k"),
                after=_el("a", name="A2", keep="k"),
            )
        ],
        relationships_modified=[
            ModifiedRelationship(
                id="r1", before=_rel("r1", "a", "b", weight=1), after=_rel("r1", "a", "b", weight=2)
            )
        ],
    )
    assert _dump(ops_for_change(cr)) == [
        {"kind": "update_element", "id": "a", "properties_patch": {"name": "A2", "note": None}},
        {"kind": "update_relationship", "id": "r1", "properties_patch": {"weight": 2}},
    ]


def test_unchanged_properties_emit_no_update() -> None:
    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(id="a", before=_el("a", name="A"), after=_el("a", name="A"))
        ]
    )
    assert ops_for_change(cr) == []


def test_phase_order_deletes_relationships_before_elements() -> None:
    cr = ChangeRequest(
        elements_added=[_el("n1", name="N")],
        elements_modified=[
            ModifiedElement(id="a", before=_el("a", name="A"), after=_el("a", name="A2"))
        ],
        elements_deleted=[_el("p", name="P"), _el("ch", name="CH")],
        relationships_added=[_rel("r-new", "n1", "a")],
        relationships_deleted=[_rel("r-pch", "p", "ch", type_name="Contains")],
    )
    kinds = [(op.kind, getattr(op, "id", None)) for op in ops_for_change(cr)]
    assert kinds == [
        ("create_element", "n1"),
        ("create_relationship", "r-new"),
        ("update_element", "a"),
        ("delete_relationship", "r-pch"),
        ("delete_element", "p"),
        ("delete_element", "ch"),
    ]


def test_rewire_is_delete_then_create_with_same_id() -> None:
    cr = ChangeRequest(
        elements_added=[_el("n1", name="N")],
        relationships_modified=[
            ModifiedRelationship(
                id="r1", before=_rel("r1", "a", "b", weight=1), after=_rel("r1", "a", "n1", weight=1)
            )
        ],
        relationships_deleted=[_rel("r9", "a", "b")],
    )
    ops = _dump(ops_for_change(cr))
    assert [op["kind"] for op in ops] == [
        "create_element",
        "delete_relationship",  # plain deletes first...
        "delete_relationship",  # ...then the rewire pair
        "create_relationship",
    ]
    assert ops[1]["id"] == "r9"
    assert ops[2]["id"] == "r1"
    assert ops[3]["id"] == "r1" and ops[3]["temp_id"] == "tmp_2"
    assert ops[3]["target_id"] == "tmp_1"


def test_relationship_type_change_is_a_rewire() -> None:
    cr = ChangeRequest(
        relationships_modified=[
            ModifiedRelationship(
                id="r1", before=_rel("r1", "a", "b"), after=_rel("r1", "a", "b", type_name="Other")
            )
        ]
    )
    assert [op.kind for op in ops_for_change(cr)] == ["delete_relationship", "create_relationship"]


def test_element_type_change_is_unsupported() -> None:
    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(id="a", before=_el("a", "Item", name="A"), after=_el("a", "Other", name="A"))
        ]
    )
    with pytest.raises(UnsupportedChangeError, match="'a'"):
        ops_for_change(cr)
