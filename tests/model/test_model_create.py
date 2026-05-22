import pytest

from data_rover.metamodel.schema import ElementType, Metamodel
from data_rover.model.ids import SequentialIdGenerator
from data_rover.model.model import Model


def _mm():
    return Metamodel(elements=[
        ElementType(name="Abstract", abstract=True),
        ElementType(name="Block"),
    ])


def test_create_element_assigns_id_and_stores():
    model = Model(_mm(), id_generator=SequentialIdGenerator("e"))
    el = model.create_element("Block")
    assert el.id == "e-1"
    assert el.type_name == "Block"
    assert model.get_element("e-1") is el


def test_create_unknown_type_raises():
    model = Model(_mm())
    with pytest.raises(KeyError):
        model.create_element("Ghost")


def test_create_abstract_type_raises():
    model = Model(_mm())
    with pytest.raises(ValueError):
        model.create_element("Abstract")


def test_get_missing_element_raises():
    model = Model(_mm())
    with pytest.raises(KeyError):
        model.get_element("nope")
