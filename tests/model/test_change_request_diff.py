from __future__ import annotations

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.change_request import (
    apply_change_request,
    diff_models,
    invert_change_request,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="note", datatype="string"),
                ],
            ),
            ElementType(name="Other"),
        ],
        relationships=[
            RelationshipType(name="Link", source="Block", target="Block"),
            RelationshipType(name="Other", source="Block", target="Block"),
        ],
    )


def _model(elements: list[Element], relationships: list[Relationship]) -> Model:
    m = Model(_mm())
    for e in elements:
        m.elements[e.id] = e
    for r in relationships:
        m.relationships[r.id] = r
    m.indexes.rebuild()
    return m


def _el(eid: str, name: str, rev: int = 0, type_name: str = "Block", **props) -> Element:
    return Element(id=eid, type_name=type_name, properties={"name": name, **props}, rev=rev)


def _rel(rid: str, src: str, tgt: str, type_name: str = "Link", **props) -> Relationship:
    return Relationship(
        id=rid, type_name=type_name, source_id=src, target_id=tgt, properties=dict(props)
    )


def test_diff_models_partitions_added_modified_deleted_in_order() -> None:
    base = _model([_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "b")])
    other = _model(
        [_el("c", "C2"), _el("a", "A"), _el("d", "D")],
        [_rel("r2", "a", "c")],
    )
    cr = diff_models(base, other)
    assert [e.id for e in cr.elements_added] == ["d"]
    assert [(m.id, m.before.properties["name"], m.after.properties["name"]) for m in cr.elements_modified] == [
        ("c", "C", "C2")
    ]
    assert [e.id for e in cr.elements_deleted] == ["b"]
    assert [r.id for r in cr.relationships_added] == ["r2"]
    assert [r.id for r in cr.relationships_deleted] == ["r1"]


def test_diff_models_ignores_rev() -> None:
    base = _model([_el("a", "A", rev=1)], [])
    other = _model([_el("a", "A", rev=7)], [])
    cr = diff_models(base, other)
    assert cr.elements_modified == [] and cr.elements_added == [] and cr.elements_deleted == []


def test_diff_models_endpoint_or_type_change_is_modified() -> None:
    base = _model([_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "b")])
    other = _model(
        [_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "c", type_name="Other")]
    )
    cr = diff_models(base, other)
    assert len(cr.relationships_modified) == 1
    m = cr.relationships_modified[0]
    assert (m.before.target_id, m.after.target_id) == ("b", "c")
    assert (m.before.type_name, m.after.type_name) == ("Link", "Other")


def test_diff_models_retype_is_modified() -> None:
    base = _model([_el("a", "A")], [])
    other = _model([_el("a", "A", type_name="Other")], [])
    cr = diff_models(base, other)
    assert [(m.before.type_name, m.after.type_name) for m in cr.elements_modified] == [
        ("Block", "Other")
    ]


def test_diff_models_copies_entities() -> None:
    base = _model([], [])
    other = _model([_el("a", "A")], [])
    cr = diff_models(base, other)
    cr.elements_added[0].properties["name"] = "mutated"
    assert other.elements["a"].properties["name"] == "A"


def test_apply_then_invert_round_trips() -> None:
    base = _model([_el("a", "A"), _el("b", "B"), _el("c", "C")], [_rel("r1", "a", "b")])
    other = _model(
        [_el("c", "C2", note="n"), _el("a", "A"), _el("d", "D")],
        [_rel("r2", "a", "c"), _rel("r1", "a", "c")],
    )
    cr = diff_models(base, other)
    forward = apply_change_request(base, cr)
    assert diff_models(forward, other).elements_added == []
    assert diff_models(forward, other).relationships_modified == []
    back = apply_change_request(forward, invert_change_request(cr))
    empty = diff_models(back, base)
    assert (
        empty.elements_added,
        empty.elements_modified,
        empty.elements_deleted,
        empty.relationships_added,
        empty.relationships_modified,
        empty.relationships_deleted,
    ) == ([], [], [], [], [], [])
