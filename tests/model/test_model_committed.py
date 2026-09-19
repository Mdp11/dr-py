"""Tests for the committed-state methods of the mutation boundary:
``Model.insert_element``, ``Model.insert_relationship``, ``Model.overwrite``
and ``Model.settle_order``. They put an entity back exactly as it was — type
unchecked, ``rev`` given, place in insertion order included — and fire the
same index hooks as the methods that create one.
"""

import pytest

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Item",
                key=["name"],
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="ref", datatype="Item"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Holds", containment=True, source="Item", target="Item"
            ),
            RelationshipType(
                name="Link",
                source="Item",
                target="Item",
                properties=[PropertyDef(name="label", datatype="string")],
            ),
        ],
    )


def _items(model: Model, *names: str) -> list[str]:
    ids = []
    for name in names:
        element = model.create_element("Item")
        model.set_property(element, "name", name)
        ids.append(element.id)
    return ids


# ---------------------------------------------------------------------------
# insert_element
# ---------------------------------------------------------------------------


def test_insert_element_takes_properties_and_rev_as_given():
    model = Model(_mm())
    props = {"name": "a"}
    element = model.insert_element("e1", "Item", props, 7)
    assert model.elements["e1"] is element
    assert element.properties is props
    assert element.rev == 7
    assert model.indexes.roots_page(0, 10) == ["e1"]
    model.indexes.verify_consistent()


def test_insert_element_checks_no_type():
    model = Model(_mm())
    element = model.insert_element("e1", "Gone", {"anything": 1}, 3)
    assert element.type_name == "Gone"
    model.indexes.verify_consistent()


def test_insert_element_refuses_an_id_in_use():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    rel = model.connect("Link", a, b)
    with pytest.raises(ValueError, match="already in use"):
        model.insert_element(a, "Item", {}, 0)
    with pytest.raises(ValueError, match="already in use"):
        model.insert_element(rel.id, "Item", {}, 0)


def test_restore_element_still_guards_the_type():
    model = Model(_mm())
    with pytest.raises(KeyError, match="Unknown element type"):
        model.restore_element("e1", "Gone")
    restored = model.restore_element("e1", "Item")
    assert (restored.properties, restored.rev) == ({}, 0)


# ---------------------------------------------------------------------------
# insert_relationship
# ---------------------------------------------------------------------------


def test_insert_relationship_takes_properties_and_rev_as_given():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    rel = model.insert_relationship("r1", "Link", a, b, {"label": "x"}, 4)
    assert model.relationships["r1"] is rel
    assert (rel.properties, rel.rev) == ({"label": "x"}, 4)
    assert model.indexes.outgoing_ids(a) == {"r1"}
    model.indexes.verify_consistent()


def test_insert_relationship_checks_ends_and_id_but_no_type():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    with pytest.raises(KeyError, match="No source element"):
        model.insert_relationship("r1", "Link", "ghost", b, {}, 0)
    with pytest.raises(KeyError, match="No target element"):
        model.insert_relationship("r1", "Link", a, "ghost", {}, 0)
    with pytest.raises(ValueError, match="already in use"):
        model.insert_relationship(a, "Link", a, b, {}, 0)
    assert model.insert_relationship("r1", "Gone", a, b, {}, 0).type_name == "Gone"
    model.indexes.verify_consistent()


# ---------------------------------------------------------------------------
# overwrite
# ---------------------------------------------------------------------------


def test_overwrite_replaces_properties_and_rev_and_reindexes():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    element = model.elements[a]
    model.set_property(element, "ref", b)
    assert model.indexes.ref_targets == {b: {a}}

    props = {"name": "z"}
    model.overwrite(element, props, 1)
    assert element.properties is props
    assert element.rev == 1
    assert model.indexes.ref_targets == {}
    assert model.indexes.roots_page(0, 10) == [b, a]  # "b" < "z"
    model.indexes.verify_consistent()


def test_overwrite_refuses_a_detached_entity():
    model = Model(_mm())
    (a,) = _items(model, "a")
    element = model.elements[a]
    model.delete_element(a)
    with pytest.raises(KeyError, match="not part of this model"):
        model.overwrite(element, {}, 0)


# ---------------------------------------------------------------------------
# place in insertion order
# ---------------------------------------------------------------------------


def test_an_element_put_back_under_its_number_returns_to_its_place():
    model = Model(_mm())
    a, b, c = _items(model, "a", "b", "c")
    number = model.indexes.element_order[b]
    model.delete_element(b)

    model.insert_element(b, "Item", {"name": "b"}, 1, number)
    assert list(model.elements) == [a, c, b]  # last, until the order is settled
    before = model.elements
    model.settle_order()
    assert list(model.elements) == [a, b, c]
    assert model.elements is not before  # replaced, never refilled in place
    assert list(before) == [a, c, b]
    assert model.indexes.element_order[b] == number
    model.indexes.verify_consistent()

    # a new element still goes last, past every number handed out so far
    (d,) = _items(model, "d")
    assert list(model.elements) == [a, b, c, d]
    model.indexes.verify_consistent()


def test_settle_order_leaves_a_dict_in_order_alone():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    number = model.indexes.element_order[b]
    model.delete_element(b)
    model.insert_element(b, "Item", {"name": "b"}, 1, number)  # was last, is last
    elements, relationships = model.elements, model.relationships
    model.settle_order()
    assert model.elements is elements
    assert model.relationships is relationships
    assert list(model.elements) == [a, b]
    model.indexes.verify_consistent()


def test_a_relationship_put_back_under_its_number_returns_to_its_place():
    model = Model(_mm())
    a, b = _items(model, "a", "b")
    r1 = model.connect("Link", a, b).id
    r2 = model.connect("Link", b, a).id
    number = model.indexes.relationship_order[r1]
    model.disconnect(r1)

    model.insert_relationship(r1, "Link", a, b, {}, 0, number)
    assert list(model.relationships) == [r2, r1]
    model.settle_order()
    assert list(model.relationships) == [r1, r2]
    model.indexes.verify_consistent()


def test_a_containment_relationship_put_back_is_the_first_parent_again():
    model = Model(_mm())
    p1, p2, child = _items(model, "p1", "p2", "child")
    h1 = model.connect("Holds", p1, child).id
    model.connect("Holds", p2, child)
    assert model.container_of(child) == p1
    number = model.indexes.relationship_order[h1]
    model.disconnect(h1)
    assert model.container_of(child) == p2

    model.insert_relationship(h1, "Holds", p1, child, {}, 0, number)
    model.settle_order()
    assert model.container_of(child) == p1
    assert model.indexes.containment_parents[child] == [p1, p2]
    model.indexes.verify_consistent()
