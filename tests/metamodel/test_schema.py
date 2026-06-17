from data_rover.core.metamodel.check import check_metamodel
from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
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
            Mapping(source="A", target="B"),
            Mapping(source="C", target="D"),
        ],
    )
    assert [(m.source, m.target) for m in r.mappings] == [("A", "B"), ("C", "D")]
    # single source/target shorthand reflects the first mapping
    assert r.source == "A"
    assert r.target == "B"


def _rel_key_mm(person_key):
    return Metamodel(
        elements=[
            ElementType(
                name="Person",
                properties=[PropertyDef(name="name", datatype="string")],
                key=person_key,
            ),
        ],
        relationships=[
            RelationshipType(name="Parent", source="Person", target="Person"),
        ],
    )


def test_relationship_key_valid_has_no_errors():
    assert check_metamodel(_rel_key_mm(["name", "out:Parent", "in:Parent"])) == []


def test_relationship_key_unknown_relationship_errors():
    errors = check_metamodel(_rel_key_mm(["out:Ghost"]))
    assert any("unknown relationship 'Ghost'" in e for e in errors)


def test_relationship_key_wrong_end_errors():
    # Parent maps Person(source) -> Widget(target); a key 'in:Parent' on Person
    # is invalid because Person is not on the target end.
    mm = Metamodel(
        elements=[
            ElementType(name="Person", key=["in:Parent"]),
            ElementType(name="Widget"),
        ],
        relationships=[
            RelationshipType(name="Parent", source="Person", target="Widget"),
        ],
    )
    errors = check_metamodel(mm)
    assert any("not on the target end of 'Parent'" in e for e in errors)


def test_relationship_key_inherited_on_supertype_ok():
    # Key declared on abstract Base, relationship endpoint is concrete Sub.
    mm = Metamodel(
        elements=[
            ElementType(name="Base", abstract=True, key=["out:Link"]),
            ElementType(name="Sub", extends="Base"),
        ],
        relationships=[RelationshipType(name="Link", source="Sub", target="Sub")],
    )
    assert check_metamodel(mm) == []
