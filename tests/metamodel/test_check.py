from data_rover.metamodel.check import check_metamodel
from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)


def test_valid_metamodel_has_no_errors():
    mm = Metamodel(
        enums={"Status": ["Draft"]},
        elements=[ElementType(name="Block",
                              properties=[PropertyDef(name="s", datatype="Status")])],
        relationships=[RelationshipType(name="R", source="Block", target="Block")],
    )
    assert check_metamodel(mm) == []


def test_unknown_extends_reported():
    mm = Metamodel(elements=[ElementType(name="Block", extends="Ghost")])
    errors = check_metamodel(mm)
    assert any("Ghost" in e for e in errors)


def test_inheritance_cycle_reported():
    mm = Metamodel(elements=[
        ElementType(name="A", extends="B"),
        ElementType(name="B", extends="A"),
    ])
    errors = check_metamodel(mm)
    assert any("cycle" in e.lower() for e in errors)


def test_unknown_datatype_reported():
    mm = Metamodel(elements=[ElementType(name="A",
                  properties=[PropertyDef(name="p", datatype="Weird")])])
    errors = check_metamodel(mm)
    assert any("Weird" in e for e in errors)


def test_relationship_endpoint_must_be_element_type():
    mm = Metamodel(
        elements=[ElementType(name="A")],
        relationships=[RelationshipType(name="R", source="A", target="Nope")],
    )
    errors = check_metamodel(mm)
    assert any("Nope" in e for e in errors)


def test_bad_multiplicity_reported():
    mm = Metamodel(elements=[ElementType(name="A",
                  properties=[PropertyDef(name="p", datatype="string", multiplicity="xx")])])
    errors = check_metamodel(mm)
    assert any("multiplicity" in e.lower() for e in errors)
