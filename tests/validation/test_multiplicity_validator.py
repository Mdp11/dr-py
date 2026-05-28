from data_rover.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.model.model import Model
from data_rover.validation.scope import Scope
from data_rover.validation.validators.multiplicity import MultiplicityValidator


def test_required_property_missing_is_error():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string", multiplicity="1")
                ],
            )
        ]
    )
    model = Model(mm)
    model.create_element("Block")  # no name set
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("name" in i.message for i in issues)


def test_required_property_present_ok():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string", multiplicity="1")
                ],
            )
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "x")
    assert MultiplicityValidator().validate(model, Scope.all()) == []


def test_many_property_count_bounds():
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="tags", datatype="string", multiplicity="1..*")
                ],
            )
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "tags", [])  # below lower bound of 1
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("tags" in i.message for i in issues)


def test_relationship_target_multiplicity_lower_bound():
    # every Block must have >=1 outgoing Owns (target_multiplicity 1..*)
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[
            RelationshipType(
                name="Owns", source="Block", target="Block", target_multiplicity="1..*"
            )
        ],
    )
    model = Model(mm)
    model.create_element("Block")  # no outgoing Owns
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("Owns" in i.message for i in issues)
