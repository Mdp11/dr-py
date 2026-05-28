from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.facets import FacetsValidator


def _model():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Req",
                properties=[
                    PropertyDef(name="priority", datatype="integer", min=1, max=5),
                    PropertyDef(
                        name="code",
                        datatype="string",
                        pattern="^R[0-9]+$",
                        max_length=4,
                    ),
                ],
            )
        ]
    )
    return Model(mm)


def _rel_model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[
            RelationshipType(
                name="Trace",
                source="Block",
                target="Block",
                properties=[
                    PropertyDef(name="weight", datatype="integer", min=1, max=5),
                    PropertyDef(
                        name="tag",
                        datatype="string",
                        pattern="^T[0-9]+$",
                        max_length=4,
                    ),
                ],
            )
        ],
    )
    return Model(mm)


def test_in_range_and_matching_ok():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "priority", 3)
    model.set_property(el, "code", "R12")
    assert FacetsValidator().validate(model, Scope.all()) == []


def test_numeric_out_of_range_is_error():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "priority", 9)
    issues = FacetsValidator().validate(model, Scope.all())
    assert any("priority" in i.message for i in issues)


def test_pattern_mismatch_is_error():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "code", "X99")
    issues = FacetsValidator().validate(model, Scope.all())
    assert any("pattern" in i.message.lower() for i in issues)


def test_max_length_exceeded_is_error():
    model = _model()
    el = model.create_element("Req")
    model.set_property(el, "code", "R12345")
    issues = FacetsValidator().validate(model, Scope.all())
    assert any("length" in i.message.lower() for i in issues)


def test_relationship_property_in_range_ok():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "weight", 3)
    model.set_property(rel, "tag", "T12")
    assert FacetsValidator().validate(model, Scope.all()) == []


def test_relationship_numeric_out_of_range_is_error():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "weight", 9)
    issues = FacetsValidator().validate(model, Scope.all())
    assert any("weight" in i.message and rel.id in i.target_ids for i in issues)


def test_relationship_pattern_mismatch_is_error():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "tag", "X99")
    issues = FacetsValidator().validate(model, Scope.all())
    assert any(
        "pattern" in i.message.lower() and rel.id in i.target_ids for i in issues
    )


def test_relationship_out_of_scope_skipped():
    model = _rel_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "weight", 9)
    assert FacetsValidator().validate(model, Scope(set())) == []
