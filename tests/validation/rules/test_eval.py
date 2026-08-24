"""Pinned condition-evaluation semantics (the spec's contract, §2.2/§2.3)."""

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.rules.schema import parse_rule_set
from data_rover.core.validation.rules.validator import evaluate_condition


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[
                    PropertyDef(name="critical", datatype="boolean"),
                    PropertyDef(name="floors", datatype="integer"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                    PropertyDef(name="label", datatype="string"),
                ],
            ),
            ElementType(name="Zone",
                        properties=[PropertyDef(name="plan", datatype="string")]),
            ElementType(name="SafeZone", extends="Zone"),
        ],
        relationships=[
            RelationshipType(
                name="Owns", containment=True,
                mappings=[Mapping(source="Building", target="Zone")],
            ),
            RelationshipType(
                name="SecureOwns", extends="Owns",
                mappings=[Mapping(source="Building", target="Zone")],
            ),
            RelationshipType(
                name="Monitors",
                mappings=[Mapping(source="Building", target="Zone")],
            ),
        ],
    )


def _cond(yaml_frag: str):
    """Parse one condition by wrapping it in a throwaway rule."""
    rs = parse_rule_set(
        "rules:\n  - name: t\n    applies_to: Building\n    then:\n" + yaml_frag
    )
    return rs.rules[0].then


def _building(model, **props):
    el = model.create_element("Building")
    for k, v in props.items():
        model.set_property(el, k, v)
    return el


# -- property atoms ---------------------------------------------------------

def test_missing_property_fails_everything_but_exists_false():
    model = Model(_mm())
    el = _building(model)
    assert evaluate_condition(model, el, _cond("      property: label\n      exists: false\n"))
    for frag in (
        "      property: label\n      exists: true\n",
        "      property: label\n      equals: x\n",
        "      property: label\n      not_equals: x\n",  # pinned: false on missing
        "      property: floors\n      gt: 0\n",
        "      property: label\n      contains: x\n",
    ):
        assert not evaluate_condition(model, el, _cond(frag))


def test_equality_no_coercion():
    model = Model(_mm())
    el = _building(model, floors=3)
    assert evaluate_condition(model, el, _cond("      property: floors\n      equals: 3\n"))
    assert not evaluate_condition(model, el, _cond("      property: floors\n      equals: '3'\n"))


def test_numeric_comparisons_and_type_mismatch_false():
    model = Model(_mm())
    el = _building(model, floors=5, label="tall")
    assert evaluate_condition(model, el, _cond("      property: floors\n      gte: 5\n"))
    assert not evaluate_condition(model, el, _cond("      property: floors\n      lt: 5\n"))
    # gt on a string value: false, never an error
    assert not evaluate_condition(model, el, _cond("      property: label\n      gt: 1\n"))


def test_in_and_contains():
    model = Model(_mm())
    el = _building(model, label="north-wing", tags=["a", "b"])
    assert evaluate_condition(model, el, _cond("      property: label\n      in: [north-wing, south]\n"))
    assert evaluate_condition(model, el, _cond("      property: label\n      contains: wing\n"))
    # contains on a LIST value = whole-value membership
    assert evaluate_condition(model, el, _cond("      property: tags\n      contains: a\n"))
    assert not evaluate_condition(model, el, _cond("      property: tags\n      contains: wing\n"))


def test_many_valued_any_entry_matches_scalar_tests():
    model = Model(_mm())
    el = _building(model, tags=["x", "y"])
    assert evaluate_condition(model, el, _cond("      property: tags\n      equals: y\n"))
    assert not evaluate_condition(model, el, _cond("      property: tags\n      equals: z\n"))
    empty = _building(model, tags=[])
    assert evaluate_condition(model, empty, _cond("      property: tags\n      exists: false\n"))


# -- relationship atoms -----------------------------------------------------

def test_exists_count_to_and_where():
    model = Model(_mm())
    b = _building(model)
    z1, z2 = model.create_element("Zone"), model.create_element("SafeZone")
    model.set_property(z1, "plan", "P1")
    model.connect("Owns", b.id, z1.id)
    model.connect("Owns", b.id, z2.id)
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, exists: true}\n"))
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, to: Zone, count: {eq: 2}}\n"))
    # subtype counted under `to: Zone`; `where` filters to the one with a plan
    assert evaluate_condition(model, b, _cond(
        "      relationship:\n"
        "        type: Owns\n        direction: outgoing\n        count: {eq: 1}\n"
        "        where: {property: plan, exists: true}\n"))
    # incoming direction, from the zone's side
    assert evaluate_condition(model, z1, _cond(
        "      relationship: {type: Owns, direction: incoming, exists: true}\n"))
    assert not evaluate_condition(model, b, _cond(
        "      relationship: {type: Monitors, direction: outgoing, exists: true}\n"))


def test_relationship_subtype_counted_under_its_base_type():
    """`type:` is a stereotype closure, subtypes included — the relationship
    mirror of `to:`'s element closure."""
    model = Model(_mm())
    b = _building(model)
    z1, z2 = model.create_element("Zone"), model.create_element("Zone")
    model.connect("Owns", b.id, z1.id)
    model.connect("SecureOwns", b.id, z2.id)
    # BOTH hops count under the base type: an exact-name match would see 1
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, count: {eq: 2}}\n"))
    assert not evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, count: {eq: 1}}\n"))
    # the subtype itself stays narrow: it does not match its own base
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: SecureOwns, direction: outgoing, count: {eq: 1}}\n"))
    # incoming, from the subtype-connected zone's side
    assert evaluate_condition(model, z2, _cond(
        "      relationship: {type: Owns, direction: incoming, exists: true}\n"))


def test_dangling_far_endpoint_semantics():
    model = Model(_mm())
    b = _building(model)
    z = model.create_element("Zone")
    model.connect("Owns", b.id, z.id)
    # dangle the far end without cascading the relationship away
    del model.elements[z.id]
    model.indexes.rebuild()
    # unfiltered atom still counts the relationship
    assert evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, exists: true}\n"))
    # any far-element test excludes it, never raises
    assert not evaluate_condition(model, b, _cond(
        "      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}\n"))


# -- combinators ------------------------------------------------------------

def test_all_any_not_nesting():
    model = Model(_mm())
    el = _building(model, critical=True, floors=2)
    cond = _cond(
        "      all:\n"
        "        - property: critical\n          equals: true\n"
        "        - any:\n"
        "            - property: floors\n              gte: 3\n"
        "            - not:\n"
        "                property: floors\n                equals: 99\n"
    )
    assert evaluate_condition(model, el, cond)
