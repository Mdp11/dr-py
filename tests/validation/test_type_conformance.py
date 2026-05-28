from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.validators.type_conformance import (
    TypeConformanceValidator,
)


def _model():
    mm = Metamodel(
        enums={"Status": ["Draft", "Approved"]},
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="mass", datatype="float"),
                    PropertyDef(name="status", datatype="Status"),
                ],
            )
        ],
    )
    return Model(mm)


def test_conforming_values_produce_no_issues():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "name", "Engine")
    model.set_property(el, "mass", 3.5)
    model.set_property(el, "status", "Draft")
    assert TypeConformanceValidator().validate(model, Scope.all()) == []


def test_wrong_primitive_type_is_error():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "name", 123)
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert el.id in issues[0].target_ids


def test_value_outside_enum_is_error():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "status", "Rejected")
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any("Status" in i.message for i in issues)


def test_bool_is_not_accepted_as_integer_or_float():
    mm = Metamodel(
        elements=[
            ElementType(
                name="B", properties=[PropertyDef(name="n", datatype="integer")]
            )
        ]
    )
    model = Model(mm)
    el = model.create_element("B")
    model.set_property(el, "n", True)
    assert len(TypeConformanceValidator().validate(model, Scope.all())) == 1


def test_out_of_scope_elements_skipped():
    model = _model()
    el = model.create_element("Block")
    model.set_property(el, "name", 123)  # invalid
    assert TypeConformanceValidator().validate(model, Scope(set())) == []


def _ref_model():
    mm = Metamodel(
        elements=[
            ElementType(name="NamedElement", abstract=True),
            ElementType(name="Person", extends="NamedElement"),
            ElementType(
                name="Requirement",
                extends="NamedElement",
                properties=[
                    PropertyDef(name="owner", datatype="Person", multiplicity="1"),
                    PropertyDef(
                        name="refines",
                        datatype="Requirement",
                        multiplicity="0..*",
                    ),
                    PropertyDef(
                        name="related",
                        datatype="NamedElement",
                        multiplicity="0..1",
                    ),
                ],
            ),
        ]
    )
    return Model(mm)


def test_valid_reference_is_ok():
    model = _ref_model()
    person = model.create_element("Person")
    req = model.create_element("Requirement")
    model.set_property(req, "owner", person.id)
    assert TypeConformanceValidator().validate(model, Scope.all()) == []


def test_reference_to_missing_element_is_error():
    model = _ref_model()
    req = model.create_element("Requirement")
    model.set_property(req, "owner", "does-not-exist")
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any("points to no element" in i.message for i in issues)


def test_reference_to_wrong_type_is_error():
    model = _ref_model()
    other = model.create_element("Requirement")
    req = model.create_element("Requirement")
    model.set_property(req, "owner", other.id)
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any(
        "expected Person" in i.message and "Requirement" in i.message for i in issues
    )


def test_polymorphic_reference_accepts_subtype():
    model = _ref_model()
    person = model.create_element("Person")
    req = model.create_element("Requirement")
    model.set_property(req, "related", person.id)
    assert TypeConformanceValidator().validate(model, Scope.all()) == []


def test_non_string_reference_value_is_error():
    model = _ref_model()
    req = model.create_element("Requirement")
    model.set_property(req, "owner", 42)
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any("not a valid Person reference" in i.message for i in issues)


def test_list_of_references_validated_per_item():
    model = _ref_model()
    other = model.create_element("Requirement")
    req = model.create_element("Requirement")
    model.set_property(req, "refines", [other.id, "missing-id"])
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert "missing-id" in issues[0].message


def _rel_model():
    mm = Metamodel(
        enums={"Kind": ["Strong", "Weak"]},
        elements=[
            ElementType(name="Block"),
            ElementType(name="Person"),
        ],
        relationships=[
            RelationshipType(
                name="Trace",
                source="Block",
                target="Block",
                properties=[
                    PropertyDef(name="weight", datatype="integer"),
                    PropertyDef(name="kind", datatype="Kind"),
                    PropertyDef(name="owner", datatype="Person"),
                ],
            )
        ],
    )
    return Model(mm)


def test_relationship_conforming_values_produce_no_issues():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "weight", 4)
    model.set_property(rel, "kind", "Strong")
    assert TypeConformanceValidator().validate(model, Scope.all()) == []


def test_relationship_wrong_primitive_type_is_error():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "weight", "heavy")
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any("weight" in i.message and rel.id in i.target_ids for i in issues)


def test_relationship_enum_violation_is_error():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "kind", "Loose")
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any("Kind" in i.message and rel.id in i.target_ids for i in issues)


def test_relationship_reference_to_missing_element_is_error():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "owner", "does-not-exist")
    issues = TypeConformanceValidator().validate(model, Scope.all())
    assert any(
        "points to no element" in i.message and rel.id in i.target_ids for i in issues
    )


def test_relationship_out_of_scope_skipped():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "weight", "heavy")
    assert TypeConformanceValidator().validate(model, Scope(set())) == []
