from data_rover.core.metamodel.check import check_metamodel
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)


def test_valid_metamodel_has_no_errors():
    mm = Metamodel(
        enums={"Status": ["Draft"]},
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="s", datatype="Status")]
            )
        ],
        relationships=[RelationshipType(name="R", source="Block", target="Block")],
    )
    assert check_metamodel(mm) == []


def test_unknown_extends_reported():
    mm = Metamodel(elements=[ElementType(name="Block", extends="Ghost")])
    errors = check_metamodel(mm)
    assert any("Ghost" in e for e in errors)


def test_inheritance_cycle_reported():
    mm = Metamodel(
        elements=[
            ElementType(name="A", extends="B"),
            ElementType(name="B", extends="A"),
        ]
    )
    errors = check_metamodel(mm)
    assert any("cycle" in e.lower() for e in errors)


def test_unknown_datatype_reported():
    mm = Metamodel(
        elements=[
            ElementType(name="A", properties=[PropertyDef(name="p", datatype="Weird")])
        ]
    )
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
    mm = Metamodel(
        elements=[
            ElementType(
                name="A",
                properties=[
                    PropertyDef(name="p", datatype="string", multiplicity="xx")
                ],
            )
        ]
    )
    errors = check_metamodel(mm)
    assert any("multiplicity" in e.lower() for e in errors)


def test_two_independent_cycles_both_reported():
    mm = Metamodel(
        elements=[
            ElementType(name="A", extends="B"),
            ElementType(name="B", extends="A"),
            ElementType(name="C", extends="D"),
            ElementType(name="D", extends="C"),
        ]
    )
    errors = check_metamodel(mm)
    cycle_errors = [e for e in errors if "cycle" in e.lower()]
    assert len(cycle_errors) == 2


def test_invalid_regex_pattern_reported():
    mm = Metamodel(
        elements=[
            ElementType(
                name="A",
                properties=[PropertyDef(name="p", datatype="string", pattern="[bad")],
            )
        ]
    )
    errors = check_metamodel(mm)
    assert any("pattern" in e.lower() for e in errors)


def test_property_redefinition_in_child_reported():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Parent", properties=[PropertyDef(name="name", datatype="string")]
            ),
            ElementType(
                name="Child",
                extends="Parent",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
        ]
    )
    errors = check_metamodel(mm)
    assert any(
        "redefines" in e and "'name'" in e and "'Child'" in e and "'Parent'" in e
        for e in errors
    )


def test_property_redefinition_in_grandchild_reported():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Root", properties=[PropertyDef(name="id", datatype="string")]
            ),
            ElementType(name="Mid", extends="Root"),
            ElementType(
                name="Leaf",
                extends="Mid",
                properties=[PropertyDef(name="id", datatype="string")],
            ),
        ]
    )
    errors = check_metamodel(mm)
    assert any(
        "redefines" in e and "'id'" in e and "'Leaf'" in e and "'Root'" in e
        for e in errors
    )


def test_relationship_property_redefinition_reported():
    mm = Metamodel(
        elements=[ElementType(name="A")],
        relationships=[
            RelationshipType(
                name="ParentRel",
                source="A",
                target="A",
                properties=[PropertyDef(name="weight", datatype="integer")],
            ),
            RelationshipType(
                name="ChildRel",
                source="A",
                target="A",
                extends="ParentRel",
                properties=[PropertyDef(name="weight", datatype="integer")],
            ),
        ],
    )
    errors = check_metamodel(mm)
    assert any(
        "redefines" in e
        and "'weight'" in e
        and "'ChildRel'" in e
        and "'ParentRel'" in e
        for e in errors
    )


def test_element_type_as_datatype_is_valid():
    mm = Metamodel(
        elements=[
            ElementType(name="Block"),
            ElementType(
                name="Req",
                properties=[PropertyDef(name="target", datatype="Block")],
            ),
        ]
    )
    assert check_metamodel(mm) == []


def test_name_clash_enum_and_element_reported():
    mm = Metamodel(
        enums={"Status": ["Draft"]},
        elements=[ElementType(name="Status")],
    )
    errors = check_metamodel(mm)
    assert any("'Status'" in e and "enum" in e and "element" in e for e in errors)


def test_name_clash_primitive_and_element_reported():
    mm = Metamodel(elements=[ElementType(name="string")])
    errors = check_metamodel(mm)
    assert any("'string'" in e and "primitive" in e for e in errors)


def test_empty_key_list_rejected():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[PropertyDef(name="name", datatype="string")],
                key=[],
            )
        ]
    )
    errors = check_metamodel(mm)
    assert any("Block" in e and "key" in e.lower() for e in errors)


def test_key_references_unknown_property_rejected():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[PropertyDef(name="name", datatype="string")],
                key=["ghost"],
            )
        ]
    )
    errors = check_metamodel(mm)
    assert any("Block" in e and "ghost" in e for e in errors)


def test_key_referencing_inherited_property_ok():
    mm = Metamodel(
        elements=[
            ElementType(
                name="NamedElement",
                abstract=True,
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Block", extends="NamedElement", key=["name"]),
        ]
    )
    assert check_metamodel(mm) == []


def test_distinct_property_names_in_child_ok():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Parent", properties=[PropertyDef(name="name", datatype="string")]
            ),
            ElementType(
                name="Child",
                extends="Parent",
                properties=[PropertyDef(name="mass", datatype="float")],
            ),
        ]
    )
    assert check_metamodel(mm) == []


def test_multiple_valid_mappings_ok():
    mm = Metamodel(
        elements=[
            ElementType(name="A"),
            ElementType(name="B"),
            ElementType(name="C"),
            ElementType(name="D"),
        ],
        relationships=[
            RelationshipType(
                name="R",
                mappings=[
                    {"source": "A", "target": "B"},
                    {"source": "C", "target": "D"},
                ],
            )
        ],
    )
    assert check_metamodel(mm) == []


def test_mapping_unknown_source_reported():
    mm = Metamodel(
        elements=[ElementType(name="A"), ElementType(name="B")],
        relationships=[
            RelationshipType(
                name="R",
                mappings=[
                    {"source": "A", "target": "B"},
                    {"source": "Ghost", "target": "B"},
                ],
            )
        ],
    )
    errors = check_metamodel(mm)
    assert any("Ghost" in e for e in errors)


def test_mapping_unknown_target_reported():
    mm = Metamodel(
        elements=[ElementType(name="A")],
        relationships=[
            RelationshipType(name="R", mappings=[{"source": "A", "target": "Phantom"}])
        ],
    )
    errors = check_metamodel(mm)
    assert any("Phantom" in e for e in errors)
