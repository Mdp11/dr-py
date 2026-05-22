from data_rover.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.endpoint_typing import (
    EndpointTypingValidator,
)


def _model():
    mm = Metamodel(
        elements=[
            ElementType(name="Component"),
            ElementType(name="Requirement"),
            ElementType(name="SubComponent", extends="Component"),
        ],
        relationships=[RelationshipType(name="Satisfies", source="Component",
                                        target="Requirement")],
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
