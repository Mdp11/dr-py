import pytest

from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.ids import SequentialIdGenerator
from data_rover.model.model import Model


def _model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="HasPart", containment=True,
                                        source="Block", target="Block")],
    )
    return Model(mm, id_generator=SequentialIdGenerator("x"))


def test_connect_creates_relationship():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    assert rel.source_id == a.id and rel.target_id == b.id
    assert model.get_relationship(rel.id) is rel


def test_connect_unknown_type_raises():
    model = _model()
    a = model.create_element("Block")
    with pytest.raises(KeyError):
        model.connect("Ghost", a.id, a.id)


def test_connect_missing_endpoint_raises():
    model = _model()
    a = model.create_element("Block")
    with pytest.raises(KeyError):
        model.connect("HasPart", a.id, "missing")


def test_disconnect_removes_relationship():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    model.disconnect(rel.id)
    assert rel.id not in model.relationships


def test_relationships_from_filters_by_source():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    assert model.relationships_from(a.id) == [rel]
    assert model.relationships_from(b.id) == []


def test_relationships_to_filters_by_target():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("HasPart", a.id, b.id)
    assert model.relationships_to(b.id) == [rel]
    assert model.relationships_to(a.id) == []


def test_disconnect_unknown_raises():
    import pytest
    model = _model()
    with pytest.raises(KeyError):
        model.disconnect("missing")
