from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.model import Model


def _model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[
            RelationshipType(name="HasPart", containment=True,
                             source="Block", target="Block"),
            RelationshipType(name="Refers", containment=False,
                             source="Block", target="Block"),
        ],
    )
    return Model(mm)


def test_delete_cascades_contained_children():
    model = _model()
    parent = model.create_element("Block")
    child = model.create_element("Block")
    grandchild = model.create_element("Block")
    model.connect("HasPart", parent.id, child.id)
    model.connect("HasPart", child.id, grandchild.id)
    model.delete_element(parent.id)
    assert model.elements == {}
    assert model.relationships == {}


def test_delete_removes_incident_reference_relationships_only():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("Refers", a.id, b.id)  # non-containment
    model.delete_element(a.id)
    assert a.id not in model.elements
    assert b.id in model.elements  # referenced element survives
    assert model.relationships == {}  # the dangling reference is removed


def test_container_of_returns_containing_element():
    model = _model()
    parent = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("HasPart", parent.id, child.id)
    assert model.container_of(child.id) == parent.id
    assert model.container_of(parent.id) is None
