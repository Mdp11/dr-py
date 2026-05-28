from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.type_conformance import (
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
