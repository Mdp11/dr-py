from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.containment import ContainmentValidator


def _model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[RelationshipType(name="HasPart", containment=True,
                                        source="Block", target="Block")],
    )
    return Model(mm)


def test_tree_is_valid():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("HasPart", a.id, b.id)
    assert ContainmentValidator().validate(model, Scope.all()) == []


def test_two_parents_is_error():
    model = _model()
    p1 = model.create_element("Block")
    p2 = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("HasPart", p1.id, child.id)
    model.connect("HasPart", p2.id, child.id)
    issues = ContainmentValidator().validate(model, Scope.all())
    assert any("parent" in i.message.lower() for i in issues)


def test_cycle_is_error():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("HasPart", a.id, b.id)
    model.connect("HasPart", b.id, a.id)
    issues = ContainmentValidator().validate(model, Scope.all())
    assert any("cycle" in i.message.lower() for i in issues)
