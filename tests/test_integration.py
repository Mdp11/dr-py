from pathlib import Path

from data_rover.metamodel.loader import load_metamodel_file
from data_rover.model.ids import SequentialIdGenerator
from data_rover.model.model import Model
from data_rover.validation.pipeline import default_pipeline

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "example.metamodel.yaml"


def test_full_flow_valid_model_has_no_errors():
    mm = load_metamodel_file(EXAMPLE)
    model = Model(mm, id_generator=SequentialIdGenerator())

    block = model.create_element("Block")
    model.set_property(block, "name", "Engine")
    model.set_property(block, "mass", 120.0)

    req = model.create_element("Requirement")
    model.set_property(req, "name", "MaxMass")
    model.set_property(req, "status", "Approved")
    model.set_property(req, "priority", 2)

    model.connect("Satisfies", block.id, req.id)

    issues = default_pipeline().validate(model)
    assert issues == [], [i.message for i in issues]


def test_full_flow_catches_multiple_violations():
    mm = load_metamodel_file(EXAMPLE)
    model = Model(mm, id_generator=SequentialIdGenerator())

    block = model.create_element("Block")
    # missing required name; mass wrong type; bad enum + out-of-range on req
    model.set_property(block, "mass", "heavy")

    req = model.create_element("Requirement")
    model.set_property(req, "name", "R")
    model.set_property(req, "status", "Rejected")  # not in enum
    model.set_property(req, "priority", 99)  # above max

    # endpoint-typing violation: Satisfies target must be Requirement
    model.connect("Satisfies", block.id, block.id)

    # containment violation: shared_child has two containment parents
    parent_a = model.create_element("Block")
    parent_b = model.create_element("Block")
    shared_child = model.create_element("Block")
    model.connect("BlockHasPart", parent_a.id, shared_child.id)
    model.connect("BlockHasPart", parent_b.id, shared_child.id)  # two parents

    messages = [i.message for i in default_pipeline().validate(model)]
    assert any("name" in m for m in messages)  # multiplicity
    assert any("heavy" in m for m in messages)  # type conformance
    assert any("Status" in m for m in messages)  # enum
    assert any("priority" in m for m in messages)  # facet
    assert any("Satisfies" in m for m in messages)  # endpoint typing
    assert any("parent" in m.lower() for m in messages)  # containment


def test_cascade_delete_through_full_stack():
    mm = load_metamodel_file(EXAMPLE)
    model = Model(mm, id_generator=SequentialIdGenerator())
    parent = model.create_element("Block")
    child = model.create_element("Block")
    model.connect("BlockHasPart", parent.id, child.id)
    model.delete_element(parent.id)
    assert model.elements == {}
