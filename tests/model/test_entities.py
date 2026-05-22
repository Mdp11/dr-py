from data_rover.model.element import Element
from data_rover.model.relationship import Relationship


def test_element_identity_is_by_id_not_value():
    a = Element(id="1", type_name="Block", properties={"name": "x"})
    b = Element(id="2", type_name="Block", properties={"name": "x"})
    assert a != b
    assert a == Element(id="1", type_name="Block", properties={"name": "x"})


def test_element_defaults():
    a = Element(id="1", type_name="Block")
    assert a.properties == {}
    assert a.rev == 0


def test_relationship_holds_endpoints():
    r = Relationship(id="r1", type_name="HasPart", source_id="1", target_id="2")
    assert r.source_id == "1"
    assert r.target_id == "2"
    assert r.rev == 0
