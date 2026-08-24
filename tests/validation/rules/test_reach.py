"""Reverse-reach derivation and dirty-scope expansion.

Keystone: expansion + scoped rerun must equal a full rerun for rule issues.
"""

import random

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets
from data_rover.core.validation.rules.reach import derive_paths, expand_scope
from data_rover.core.validation.rules.schema import parse_rule_set
from data_rover.core.validation.rules.validator import RulesValidator
from data_rover.core.validation.scope import Scope


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(name="City"),
            ElementType(
                name="Building",
                properties=[PropertyDef(name="critical", datatype="boolean")],
            ),
            ElementType(
                name="Zone",
                properties=[PropertyDef(name="plan", datatype="string")],
            ),
            ElementType(
                name="Sensor",
                properties=[PropertyDef(name="status", datatype="string")],
            ),
        ],
        relationships=[
            RelationshipType(name="HasBuilding", containment=True,
                             mappings=[Mapping(source="City", target="Building")]),
            RelationshipType(name="Owns", containment=True,
                             mappings=[Mapping(source="Building", target="Zone")]),
            RelationshipType(name="Watches",
                             mappings=[Mapping(source="Zone", target="Sensor")]),
        ],
    )


TWO_HOP = """
rules:
  - name: deep
    applies_to: Building
    then:
      relationship:
        type: Owns
        direction: outgoing
        to: Zone
        exists: true
        where:
          relationship:
            type: Watches
            direction: outgoing
            to: Sensor
            exists: true
            where: {property: status, equals: ok}
"""


def _compiled(mm, doc=TWO_HOP):
    return compile_rule_sets([RuleSetSource("a1", "s", doc)], mm)


def test_derive_paths_shapes():
    rs = parse_rule_set(TWO_HOP)
    paths = derive_paths(rs.rules[0], _mm())
    # one path per relationship atom: depth-1 (Owns) and depth-2 (Owns,Watches)
    assert sorted(len(p.steps) for p in paths) == [1, 2]
    deep = next(p for p in paths if len(p.steps) == 2)
    assert "Owns" in deep.steps[0].rel_types
    assert "Watches" in deep.steps[1].rel_types
    assert deep.steps[1].far_types == frozenset({"Sensor"})


def test_expand_depth1_far_property_change():
    mm = _mm()
    model = Model(mm)
    b = model.create_element("Building")
    z = model.create_element("Zone")
    model.connect("Owns", b.id, z.id)
    extra = expand_scope(model, _compiled(mm), [z.id])
    assert b.id in extra


def test_expand_depth2_sensor_change_reaches_building():
    mm = _mm()
    model = Model(mm)
    b = model.create_element("Building")
    z = model.create_element("Zone")
    s = model.create_element("Sensor")
    model.connect("Owns", b.id, z.id)
    model.connect("Watches", z.id, s.id)
    extra = expand_scope(model, _compiled(mm), [s.id])
    assert b.id in extra


def test_unrelated_element_expands_nothing():
    mm = _mm()
    model = Model(mm)
    model.create_element("Building")
    c = model.create_element("City")
    assert expand_scope(model, _compiled(mm), [c.id]) == []


def test_expansion_scoped_rerun_equals_full_rerun():
    """Random mutations: full rule issues == splice-simulated rule issues."""
    mm = _mm()
    doc = TWO_HOP
    rng = random.Random(7)
    model = Model(mm)
    compiled = _compiled(mm, doc)
    buildings = [model.create_element("Building") for _ in range(8)]
    zones = [model.create_element("Zone") for _ in range(12)]
    sensors = [model.create_element("Sensor") for _ in range(12)]
    for z in zones:
        model.connect("Owns", rng.choice(buildings).id, z.id)
    for s in sensors:
        model.connect("Watches", rng.choice(zones).id, s.id)

    def rule_issue_owners(scope):
        return {
            i.target_ids[0]
            for i in RulesValidator(compiled).validate(model, scope)
        }

    # maintained incrementally, seeded from a full run
    live = rule_issue_owners(Scope.all())

    for _ in range(40):
        s = rng.choice(sensors)
        dirty = [s.id]
        if rng.random() < 0.5:
            model.set_property(s, "status", rng.choice(["ok", "bad"]))
        else:
            model.delete_property(s, "status")
        extra = expand_scope(model, compiled, dirty)
        scoped_ids = list(dict.fromkeys([*dirty, *extra]))
        scoped_owners = rule_issue_owners(Scope(scoped_ids))
        live = (live - set(scoped_ids)) | scoped_owners
        assert live == rule_issue_owners(Scope.all())
