import pytest

from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef, RelationshipType
from data_rover.model.model import Model


def _mm():
    return Metamodel(elements=[
        ElementType(name="Block", properties=[
            PropertyDef(name="name", datatype="string"),
        ]),
    ])


def test_set_known_property_stores_and_bumps_rev():
    model = Model(_mm())
    el = model.create_element("Block")
    before = el.rev
    model.set(el, "name", "Engine")
    assert el.properties["name"] == "Engine"
    assert el.rev == before + 1


def test_set_unknown_property_raises():
    model = Model(_mm())
    el = model.create_element("Block")
    with pytest.raises(KeyError):
        model.set(el, "ghost", 1)


def test_set_does_not_validate_value_type():
    # mutation is permissive; the validation pipeline catches type errors later
    model = Model(_mm())
    el = model.create_element("Block")
    model.set(el, "name", 123)  # wrong type, but allowed
    assert el.properties["name"] == 123


def test_set_on_relationship_target():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="Link", source="Block", target="Block",
                                        properties=[PropertyDef(name="label", datatype="string")])],
    )
    model = Model(mm)
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Link", a.id, b.id)
    model.set(rel, "label", "wire")
    assert rel.properties["label"] == "wire"
    assert rel.rev == 1
