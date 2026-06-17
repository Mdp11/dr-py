from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.validators.endpoint_typing import (
    EndpointTypingValidator,
)


def _model():
    mm = Metamodel(
        elements=[
            ElementType(name="Component"),
            ElementType(name="Requirement"),
            ElementType(name="SubComponent", extends="Component"),
        ],
        relationships=[
            RelationshipType(name="Satisfies", source="Component", target="Requirement")
        ],
    )
    return Model(mm)


def test_correct_endpoints_ok():
    model = _model()
    c = model.create_element("Component")
    r = model.create_element("Requirement")
    model.connect("Satisfies", c.id, r.id)
    assert EndpointTypingValidator().validate(model, Scope.all()) == []


def test_subtype_source_accepted():
    model = _model()
    sub = model.create_element("SubComponent")
    r = model.create_element("Requirement")
    model.connect("Satisfies", sub.id, r.id)
    assert EndpointTypingValidator().validate(model, Scope.all()) == []


def test_wrong_target_type_is_error():
    model = _model()
    c = model.create_element("Component")
    bad = model.create_element("Component")  # should be Requirement
    rel = model.connect("Satisfies", c.id, bad.id)
    issues = EndpointTypingValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert rel.id in issues[0].target_ids


def _multi_mapping_model():
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
                    Mapping(source="A", target="B"),
                    Mapping(source="C", target="D"),
                ],
            )
        ],
    )
    return Model(mm)


def test_any_declared_mapping_is_accepted():
    model = _multi_mapping_model()
    a, b = model.create_element("A"), model.create_element("B")
    c, d = model.create_element("C"), model.create_element("D")
    model.connect("R", a.id, b.id)
    model.connect("R", c.id, d.id)
    assert EndpointTypingValidator().validate(model, Scope.all()) == []


def test_cross_pair_not_in_any_mapping_is_error():
    model = _multi_mapping_model()
    a = model.create_element("A")
    d = model.create_element("D")  # A->D matches no declared mapping
    rel = model.connect("R", a.id, d.id)
    issues = EndpointTypingValidator().validate(model, Scope.all())
    assert len(issues) == 1
    assert rel.id in issues[0].target_ids
