from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)


def test_property_defaults():
    p = PropertyDef(name="name", datatype="string")
    assert p.multiplicity == "0..1"
    assert p.min is None and p.max is None


def test_build_metamodel():
    mm = Metamodel(
        enums={"Status": ["Draft", "Approved"]},
        elements=[
            ElementType(name="NamedElement", abstract=True,
                        properties=[PropertyDef(name="name", datatype="string",
                                                multiplicity="1")]),
            ElementType(name="Block", extends="NamedElement"),
        ],
        relationships=[
            RelationshipType(name="HasPart", containment=True,
                             source="Block", target="Block"),
        ],
    )
    assert mm.element_type("Block").extends == "NamedElement"
    assert mm.element_type("Missing") is None
    assert mm.relationship_type("HasPart").containment is True


def test_relationship_defaults():
    r = RelationshipType(name="R", source="A", target="B")
    assert r.containment is False
    assert r.source_multiplicity == "0..*"
    assert r.target_multiplicity == "0..*"
