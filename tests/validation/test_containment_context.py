from data_rover.core.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.validation.containment_context import containment_parents


def _model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[
            RelationshipType(
                name="HasPart", containment=True, source="Block", target="Block"
            ),
            RelationshipType(name="Link", source="Block", target="Block"),
        ],
    )
    return Model(mm)


def test_returns_parent_per_contained_element():
    model = _model()
    parent = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("HasPart", parent.id, child.id)

    parents = containment_parents(model)
    assert parents == {child.id: [parent.id]}


def test_non_containment_relationships_ignored():
    model = _model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("Link", a.id, b.id)

    assert containment_parents(model) == {}


def test_multiple_parents_all_listed():
    model = _model()
    p1 = model.create_element("Block")
    p2 = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("HasPart", p1.id, child.id)
    model.connect("HasPart", p2.id, child.id)

    parents = containment_parents(model)
    assert set(parents[child.id]) == {p1.id, p2.id}
