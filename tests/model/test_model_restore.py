"""Tests for the undo-support mutation-boundary methods (Phase C1):
``Model.delete_property``, ``Model.restore_element``,
``Model.restore_relationship``. All three must fire the same index hooks as
their create/set counterparts, verified via ``IndexSet.verify_consistent``.
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
                    PropertyDef(name="note", datatype="string"),
                    PropertyDef(name="ref", datatype="Item"),
                ],
            ),
            ElementType(name="Ghost", abstract=True),
        ],
        relationships=[
            RelationshipType(
                name="Link",
                source="Item",
                target="Item",
                properties=[PropertyDef(name="label", datatype="string")],
            )
        ],
    )


# --- delete_property -------------------------------------------------------


def test_delete_property_removes_key_and_bumps_rev():
    model = Model(_mm())
    el = model.create_element("Item")
    model.set_property(el, "note", "hi")
    before = el.rev
    model.delete_property(el, "note")
    assert "note" not in el.properties
    assert el.rev == before + 1
    model.indexes.verify_consistent()


def test_delete_property_updates_property_driven_indexes():
    model = Model(_mm())
    a = model.create_element("Item")
    b = model.create_element("Item")
    model.set_property(a, "ref", b.id)
    assert a.id in model.indexes.referencers_of(b.id)
    model.set_property(a, "name", "A")  # key property feeds the uniq index
    model.delete_property(a, "ref")
    assert a.id not in model.indexes.referencers_of(b.id)
    model.delete_property(a, "name")
    model.indexes.verify_consistent()


def test_delete_property_absent_key_is_noop():
    model = Model(_mm())
    el = model.create_element("Item")
    before = el.rev
    model.delete_property(el, "note")  # never set: merge-patch no-op
    assert el.rev == before


def test_delete_property_unknown_property_raises():
    model = Model(_mm())
    el = model.create_element("Item")
    with pytest.raises(KeyError):
        model.delete_property(el, "ghost")


def test_delete_property_detached_entity_raises():
    model = Model(_mm())
    el = model.create_element("Item")
    model.delete_element(el.id)
    with pytest.raises(KeyError):
        model.delete_property(el, "note")


def test_delete_property_on_relationship():
    model = Model(_mm())
    a = model.create_element("Item")
    b = model.create_element("Item")
    rel = model.connect("Link", a.id, b.id)
    model.set_property(rel, "label", "wire")
    model.delete_property(rel, "label")
    assert "label" not in rel.properties
    assert rel.rev == 2
    model.indexes.verify_consistent()


# --- restore_element -------------------------------------------------------


def test_restore_element_reinstates_exact_id():
    model = Model(_mm())
    el = model.create_element("Item")
    old_id = el.id
    model.delete_element(old_id)
    restored = model.restore_element(old_id, "Item")
    assert restored.id == old_id
    assert model.get_element(old_id).type_name == "Item"
    model.indexes.verify_consistent()


def test_restore_element_id_in_use_raises():
    model = Model(_mm())
    el = model.create_element("Item")
    with pytest.raises(ValueError):
        model.restore_element(el.id, "Item")
    a = model.create_element("Item")
    b = model.create_element("Item")
    rel = model.connect("Link", a.id, b.id)
    with pytest.raises(ValueError):
        model.restore_element(rel.id, "Item")  # rel ids count as in use too


def test_restore_element_type_guards():
    model = Model(_mm())
    with pytest.raises(KeyError):
        model.restore_element("x", "Nope")
    with pytest.raises(ValueError):
        model.restore_element("x", "Ghost")  # abstract


# --- restore_relationship --------------------------------------------------


def test_restore_relationship_reinstates_exact_id():
    model = Model(_mm())
    a = model.create_element("Item")
    b = model.create_element("Item")
    rel = model.connect("Link", a.id, b.id)
    old_id = rel.id
    model.disconnect(old_id)
    restored = model.restore_relationship(old_id, "Link", a.id, b.id)
    assert restored.id == old_id
    assert model.get_relationship(old_id).source_id == a.id
    assert rel.id in model.indexes.outgoing_ids(a.id)
    model.indexes.verify_consistent()


def test_restore_relationship_guards():
    model = Model(_mm())
    a = model.create_element("Item")
    b = model.create_element("Item")
    rel = model.connect("Link", a.id, b.id)
    with pytest.raises(ValueError):
        model.restore_relationship(rel.id, "Link", a.id, b.id)  # id in use
    with pytest.raises(KeyError):
        model.restore_relationship("r2", "Nope", a.id, b.id)  # unknown type
    with pytest.raises(KeyError):
        model.restore_relationship("r2", "Link", "missing", b.id)  # no source
    with pytest.raises(KeyError):
        model.restore_relationship("r2", "Link", a.id, "missing")  # no target
