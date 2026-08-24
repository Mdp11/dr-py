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
from data_rover.core.model.change_request import (
    ChangeRequest,
    ModifiedElement,
    apply_change_request,
)
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import DirtyCollector, change_request_dirty_ids
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
            RelationshipType(
                name="HasBuilding",
                containment=True,
                mappings=[Mapping(source="City", target="Building")],
            ),
            RelationshipType(
                name="Owns",
                containment=True,
                mappings=[Mapping(source="Building", target="Zone")],
            ),
            RelationshipType(
                name="Watches", mappings=[Mapping(source="Zone", target="Sensor")]
            ),
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

INCOMING_HOP = """
rules:
  - name: has_owner_city
    applies_to: Building
    then:
      relationship:
        type: HasBuilding
        direction: incoming
        to: City
        exists: true
"""


WHEN_ONLY = """
rules:
  - name: guarded
    applies_to: Building
    when:
      relationship:
        type: Owns
        direction: outgoing
        to: Zone
        exists: true
    then:
      property: critical
      equals: true
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
    """Random mutations — property AND structural — through the real
    ``DirtyCollector``: full rule issues == splice-simulated rule issues.

    Structural churn (connect/disconnect/delete/create) is where the
    dirty-set/reach interaction is least obvious: a mutation's own dirty set
    names entities the rule never reports on, and the expansion is what has
    to carry it back to the applies-to element. An under-approximating
    ``expand_scope`` shows up here as a splice that drifts from the full run.
    """
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
            i.target_ids[0] for i in RulesValidator(compiled).validate(model, scope)
        }

    def alive(elements):
        return [e for e in elements if e.id in model.elements]

    def rels_of_type(type_name):
        return [r for r in model.relationships.values() if r.type_name == type_name]

    # maintained incrementally, seeded from a full run
    live = rule_issue_owners(Scope.all())

    fired: set[str] = set()

    def mutate(d):
        """One random mutation through the collector's wrappers, so the base
        dirty set is built by exactly the hooks production uses."""
        choices = ["prop", "prop", "connect", "disconnect", "delete", "create"]
        match rng.choice(choices):
            case "prop" if sensors:
                s = rng.choice(sensors)
                fired.add("prop")
                if rng.random() < 0.5:
                    d.set_property(model, s, "status", rng.choice(["ok", "bad"]))
                else:
                    d.delete_property(model, s, "status")
            case "connect" if zones and sensors:
                if rng.random() < 0.5:
                    fired.add("connect")
                    d.connect(
                        model, "Watches", rng.choice(zones).id, rng.choice(sensors).id
                    )
                else:
                    # only re-parent an orphan zone: a second containment
                    # parent is a structural defect, not a rule scenario
                    orphans = [z for z in zones if not model.indexes.incoming_ids(z.id)]
                    if orphans and buildings:
                        fired.add("connect")
                        d.connect(
                            model,
                            "Owns",
                            rng.choice(buildings).id,
                            rng.choice(orphans).id,
                        )
            case "disconnect":
                rels = rels_of_type(rng.choice(["Watches", "Owns"]))
                if rels:
                    fired.add("disconnect")
                    d.disconnect(model, rng.choice(rels).id)
            case "delete":
                pool = [*zones, *sensors, *buildings]
                if pool:
                    fired.add("delete")
                    d.delete_element(model, rng.choice(pool).id)
            case "create":
                kind = rng.choice(["Building", "Zone", "Sensor"])
                fired.add("create")
                el = d.create_element(model, kind)
                {"Building": buildings, "Zone": zones, "Sensor": sensors}[kind].append(
                    el
                )
                if kind == "Zone" and buildings:
                    d.connect(model, "Owns", rng.choice(buildings).id, el.id)
                elif kind == "Sensor" and zones:
                    d.connect(model, "Watches", rng.choice(zones).id, el.id)
            case _:
                pass

    for _ in range(120):
        d = DirtyCollector()
        mutate(d)
        # cascades can remove more than the chosen element
        buildings, zones, sensors = alive(buildings), alive(zones), alive(sensors)
        dirty = list(d.ids)
        extra = expand_scope(model, compiled, dirty)
        scoped_ids = list(dict.fromkeys([*dirty, *extra]))
        scoped_owners = rule_issue_owners(Scope(scoped_ids))
        live = (live - set(scoped_ids)) | scoped_owners
        assert live == rule_issue_owners(Scope.all())

    # the pools can shrink under deletion; fail loudly rather than degenerate
    # into a property-only run that quietly stops testing structural churn
    assert fired == {"prop", "connect", "disconnect", "delete", "create"}


def test_expand_incoming_direction_reaches_owner():
    """direction: incoming means owner=target, far=source (the mirror of
    outgoing); a swapped source/target inversion would either find nothing
    or land on the wrong element, so pin the exact result."""
    mm = _mm()
    model = Model(mm)
    c = model.create_element("City")
    b = model.create_element("Building")
    decoy = model.create_element("Building")  # not connected to c
    model.connect("HasBuilding", c.id, b.id)
    extra = expand_scope(model, _compiled(mm, INCOMING_HOP), [c.id])
    assert extra == [b.id]
    assert decoy.id not in extra


def test_derive_paths_from_when_guard():
    rs = parse_rule_set(WHEN_ONLY)
    paths = derive_paths(rs.rules[0], _mm())
    assert len(paths) == 1
    assert paths[0].steps[0].rel_types == frozenset({"Owns"})
    assert paths[0].steps[0].far_types == frozenset({"Zone"})


def test_expand_reaches_owner_through_when_only_relationship():
    mm = _mm()
    model = Model(mm)
    b = model.create_element("Building")
    z = model.create_element("Zone")
    model.connect("Owns", b.id, z.id)
    extra = expand_scope(model, _compiled(mm, WHEN_ONLY), [z.id])
    assert b.id in extra


# -- retype (change-request path) -------------------------------------------

SAFE_ZONE_REQUIRED = """
rules:
  - name: needs_safe_zone
    applies_to: Building
    then:
      relationship: {type: Owns, direction: outgoing, to: SafeZone, exists: true}
"""

NO_SAFE_ZONE = """
rules:
  - name: no_safe_zone
    applies_to: Building
    then:
      not:
        relationship: {type: Owns, direction: outgoing, to: SafeZone, exists: true}
"""


def _retype_mm() -> Metamodel:
    """Zone subtype hierarchy: retyping across it moves an element in and out
    of a rule's ``to:`` closure."""
    return Metamodel(
        elements=[
            ElementType(name="Building"),
            ElementType(name="Zone"),
            ElementType(name="SafeZone", extends="Zone"),
        ],
        relationships=[
            RelationshipType(
                name="Owns",
                containment=True,
                mappings=[Mapping(source="Building", target="Zone")],
            ),
        ],
    )


def _rule_owners(model, compiled, scope):
    return {i.target_ids[0] for i in RulesValidator(compiled).validate(model, scope)}


def _retype(model, element_id, new_type):
    """Retype one element through the change-request path — the only route a
    retype takes (the Model mutation boundary has no retype op). Returns the
    result model and the CR's dirty ids."""
    before = model.elements[element_id]
    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(
                id=element_id,
                before=before,
                after=Element(
                    id=element_id,
                    type_name=new_type,
                    properties=dict(before.properties),
                ),
            )
        ]
    )
    result = apply_change_request(model, cr)
    return result, change_request_dirty_ids(model, result, cr)


def _splice(model, compiled, live, dirty):
    """The API's incremental update: expand, rerun scoped, splice."""
    extra = expand_scope(model, compiled, dirty)
    scoped_ids = list(dict.fromkeys([*dirty, *extra]))
    return (live - set(scoped_ids)) | _rule_owners(model, compiled, Scope(scoped_ids))


def test_retype_across_far_type_closure_splices_like_a_full_rerun():
    """A retype flips the OWNER's verdict while the retyped element itself
    stops matching the rule's ``to:`` closure. Gating the walk on the
    element's current type would never start it, losing the owner's new
    violation; the splice must track a full rerun across both transitions.
    """
    mm = _retype_mm()
    model = Model(mm)
    b = model.create_element("Building")
    z = model.create_element("SafeZone")
    model.connect("Owns", b.id, z.id)
    compiled = _compiled(mm, SAFE_ZONE_REQUIRED)
    live = _rule_owners(model, compiled, Scope.all())
    assert live == set()
    for new_type, expected in (("Zone", {b.id}), ("SafeZone", set())):
        model, dirty = _retype(model, z.id, new_type)
        assert z.id in dirty
        live = _splice(model, compiled, live, dirty)
        assert live == _rule_owners(model, compiled, Scope.all()) == expected


def test_retype_out_of_far_type_closure_drops_the_owner_stale_issue():
    """Mirror polarity: the far element's presence in the closure is what
    violates, so leaving the closure must retract the owner's issue rather
    than strand it."""
    mm = _retype_mm()
    model = Model(mm)
    b = model.create_element("Building")
    z = model.create_element("SafeZone")
    model.connect("Owns", b.id, z.id)
    compiled = _compiled(mm, NO_SAFE_ZONE)
    live = _rule_owners(model, compiled, Scope.all())
    assert live == {b.id}
    model, dirty = _retype(model, z.id, "Zone")
    live = _splice(model, compiled, live, dirty)
    assert live == _rule_owners(model, compiled, Scope.all()) == set()
