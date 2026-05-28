from data_rover.metamodel.schema import ElementType, Metamodel, PropertyDef
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
