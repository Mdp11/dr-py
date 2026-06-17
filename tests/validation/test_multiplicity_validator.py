from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.validators.multiplicity import MultiplicityValidator


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


def test_relationship_target_multiplicity_checks_all_mapping_sources():
    # R allows A->B and C->D; target_multiplicity 1 means each source needs
    # exactly one outgoing R. A C with no outgoing R must be flagged even though
    # C is only a *secondary* mapping source.
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
                target_multiplicity="1",
            )
        ],
    )
    model = Model(mm)
    c = model.create_element("C")  # no outgoing R
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("R" in i.message and c.id in i.target_ids for i in issues)


def _rel_prop_model():
    mm = Metamodel(
        elements=[ElementType(name="Block")],
        relationships=[
            RelationshipType(
                name="Trace",
                source="Block",
                target="Block",
                properties=[
                    PropertyDef(name="label", datatype="string", multiplicity="1"),
                    PropertyDef(name="tags", datatype="string", multiplicity="1..*"),
                ],
            )
        ],
    )
    return Model(mm)


def test_relationship_required_property_missing_is_error():
    model = _rel_prop_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "tags", ["t1"])  # label not set
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("label" in i.message and rel.id in i.target_ids for i in issues)


def test_relationship_required_property_present_ok():
    model = _rel_prop_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "label", "x")
    model.set_property(rel, "tags", ["t1"])
    assert MultiplicityValidator().validate(model, Scope.all()) == []


def test_relationship_many_property_count_bounds():
    model = _rel_prop_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    rel = model.connect("Trace", a.id, b.id)
    model.set_property(rel, "label", "x")
    model.set_property(rel, "tags", [])  # below lower bound
    issues = MultiplicityValidator().validate(model, Scope.all())
    assert any("tags" in i.message and rel.id in i.target_ids for i in issues)


def test_relationship_property_out_of_scope_skipped():
    model = _rel_prop_model()
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.connect("Trace", a.id, b.id)  # label missing
    assert MultiplicityValidator().validate(model, Scope(set())) == []
