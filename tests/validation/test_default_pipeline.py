from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.pipeline import default_pipeline


def test_default_pipeline_runs_all_first_cut_validators():
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
    model.create_element("Block")  # missing required name -> multiplicity error
    issues = default_pipeline().validate(model)
    assert any("name" in i.message for i in issues)


def test_default_pipeline_reports_containment_and_uniqueness_independently():
    mm = Metamodel(
        elements=[
            ElementType(
                name="NamedElement",
                abstract=True,
                properties=[
                    PropertyDef(name="name", datatype="string", multiplicity="1")
                ],
                key=["name"],
            ),
            ElementType(name="Block", extends="NamedElement"),
        ],
        relationships=[
            RelationshipType(
                name="HasPart", containment=True, source="Block", target="Block"
            )
        ],
    )
    model = Model(mm)
    # containment cycle: a -> b -> a
    a = model.create_element("Block")
    b = model.create_element("Block")
    model.set_property(a, "name", "A")
    model.set_property(b, "name", "B")
    model.connect("HasPart", a.id, b.id)
    model.connect("HasPart", b.id, a.id)
    # uniqueness violation: two unowned Blocks with same name
    c = model.create_element("Block")
    d = model.create_element("Block")
    model.set_property(c, "name", "Dup")
    model.set_property(d, "name", "Dup")

    issues = default_pipeline().validate(model)
    assert any("cycle" in i.message.lower() for i in issues)
    assert any("Duplicate" in i.message for i in issues)
