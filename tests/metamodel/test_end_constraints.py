"""Tests for Metamodel.end_constraints().

The expected semantics mirror today's MultiplicityValidator exactly:

- for each NON-abstract relationship type rt:
  - if an element's type is a subtype of ANY mapping source, rt's TARGET
    multiplicity binds that type (checked against the element's outgoing count)
  - if it is a subtype of ANY mapping target, rt's SOURCE multiplicity binds
    that type (checked against the element's incoming count)
- a multiplicity that can never fail (lower 0, unbounded upper, e.g. "0..*")
  produces no constraint
- abstract relationship types produce no constraints
- at most one constraint per (relationship type, direction) per element type,
  even when the type matches several mappings of the same relationship
"""

from data_rover.core.metamodel.multiplicity import Multiplicity
from data_rover.core.metamodel.schema import (
    ElementType,
    EndConstraint,
    Mapping,
    Metamodel,
    RelationshipType,
)


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(name="Base", abstract=True),
            ElementType(name="Block", extends="Base"),
            ElementType(name="Sensor", extends="Block"),
            ElementType(name="Other"),
        ],
        relationships=[
            # abstract: must contribute nothing even though its multiplicities bind
            RelationshipType(
                name="AbsRel",
                abstract=True,
                source="Block",
                target="Block",
                source_multiplicity="1",
                target_multiplicity="1",
            ),
            # source multiplicity binds ("1"); target multiplicity is the
            # always-satisfied "0..*" and must be excluded
            RelationshipType(
                name="HasPart",
                source="Block",
                target="Block",
                source_multiplicity="1",
                target_multiplicity="0..*",
            ),
            # target multiplicity binds for sources; bare "*" source
            # multiplicity is unbounded and must be excluded for targets
            RelationshipType(
                name="Feeds",
                source="Sensor",
                target="Other",
                source_multiplicity="*",
                target_multiplicity="1..2",
            ),
            # abstract mapping source expands over its concrete subtypes
            RelationshipType(
                name="Owns",
                source="Base",
                target="Other",
                source_multiplicity="0..*",
                target_multiplicity="0..1",
            ),
            # Sensor matches BOTH mappings' sources -> still only one constraint
            RelationshipType(
                name="Links",
                mappings=[
                    Mapping(source="Block", target="Other"),
                    Mapping(source="Sensor", target="Other"),
                ],
                source_multiplicity="0..*",
                target_multiplicity="1",
            ),
        ],
    )


def test_source_direction_binds_incoming_and_unbounded_target_excluded():
    mm = _mm()
    assert [c for c in mm.end_constraints("Block") if c.rel_type_name == "HasPart"] == [
        EndConstraint("HasPart", "source", Multiplicity(1, 1)),
    ]


def test_target_direction_binds_outgoing_for_subtype_of_mapping_source():
    mm = _mm()
    assert [c for c in mm.end_constraints("Sensor") if c.rel_type_name == "Feeds"] == [
        EndConstraint("Feeds", "target", Multiplicity(1, 2)),
    ]
    # Block is a SUPERtype of Sensor, not a subtype: no Feeds constraint
    assert [c for c in mm.end_constraints("Block") if c.rel_type_name == "Feeds"] == []


def test_unbounded_source_multiplicity_excluded_for_target_type():
    mm = _mm()
    # Other is the target of Feeds/Owns/Links but their source multiplicities
    # are all "0..*"/"*": nothing binds Other
    assert mm.end_constraints("Other") == []


def test_subtype_expansion_through_abstract_mapping_source():
    mm = _mm()
    owns = EndConstraint("Owns", "target", Multiplicity(0, 1))
    assert owns in mm.end_constraints("Block")
    assert owns in mm.end_constraints("Sensor")
    assert owns not in mm.end_constraints("Other")


def test_abstract_relationship_types_skipped():
    mm = _mm()
    for type_name in ("Base", "Block", "Sensor", "Other"):
        assert all(c.rel_type_name != "AbsRel" for c in mm.end_constraints(type_name))


def test_one_constraint_per_direction_even_with_multiple_matching_mappings():
    mm = _mm()
    links = [c for c in mm.end_constraints("Sensor") if c.rel_type_name == "Links"]
    assert links == [EndConstraint("Links", "target", Multiplicity(1, 1))]


def test_abstract_element_type_still_gets_constraints():
    # the validator checks elements by type name regardless of abstractness,
    # so abstract element types keep their binding constraints too
    mm = _mm()
    assert mm.end_constraints("Base") == [
        EndConstraint("Owns", "target", Multiplicity(0, 1)),
    ]


def test_unknown_type_yields_empty_list():
    assert _mm().end_constraints("Nope") == []


def test_full_constraint_lists_in_declaration_order():
    mm = _mm()
    assert mm.end_constraints("Sensor") == [
        EndConstraint("HasPart", "source", Multiplicity(1, 1)),
        EndConstraint("Feeds", "target", Multiplicity(1, 2)),
        EndConstraint("Owns", "target", Multiplicity(0, 1)),
        EndConstraint("Links", "target", Multiplicity(1, 1)),
    ]


def test_returned_list_is_a_fresh_copy():
    mm = _mm()
    first = mm.end_constraints("Sensor")
    first.append(EndConstraint("HasPart", "source", Multiplicity(9, 9)))
    assert mm.end_constraints("Sensor") != first


def test_caches_do_not_affect_metamodel_equality():
    a, b = _mm(), _mm()
    a.end_constraints("Sensor")  # builds a's caches; b's stay cold
    assert a == b
