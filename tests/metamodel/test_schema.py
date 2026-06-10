from data_rover.core.metamodel.schema import (
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
            ElementType(
                name="NamedElement",
                abstract=True,
                properties=[
                    PropertyDef(name="name", datatype="string", multiplicity="1")
                ],
            ),
            ElementType(name="Block", extends="NamedElement"),
        ],
        relationships=[
            RelationshipType(
                name="HasPart", containment=True, source="Block", target="Block"
            ),
        ],
    )
    et = mm.element_type("Block")
    assert et is not None
    assert et.extends == "NamedElement"
    assert mm.element_type("Missing") is None
    rt = mm.relationship_type("HasPart")
    assert rt is not None
    assert rt.containment is True


def test_relationship_defaults():
    r = RelationshipType(name="R", source="A", target="B")
    assert r.containment is False
    assert r.source_multiplicity == "0..*"
    assert r.target_multiplicity == "0..*"


def test_relationship_single_source_target_normalizes_to_mapping():
    r = RelationshipType(name="R", source="A", target="B")
    assert [(m.source, m.target) for m in r.mappings] == [("A", "B")]


def test_relationship_multiple_mappings():
    r = RelationshipType(
        name="R",
        mappings=[
            {"source": "A", "target": "B"},
            {"source": "C", "target": "D"},
        ],
    )
    assert [(m.source, m.target) for m in r.mappings] == [("A", "B"), ("C", "D")]
    # single source/target shorthand reflects the first mapping
    assert r.source == "A"
    assert r.target == "B"
