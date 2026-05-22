import pytest

from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
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
