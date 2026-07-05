"""Tests for the navigation-support caches on Metamodel:

- element_descendants: the DOWNWARD closure (self + subtypes), inverting the
  cached ancestor sets. Abstract types are included (a scope naming an
  abstract type must expand to its concrete subtypes' instances).
- relationship_types_from/to: non-abstract relationship types whose mappings
  accept the element type (or an ancestor) as source/target respectively.
  Abstract relationship types contribute nothing (they cannot be instantiated).
"""

from data_rover.core.metamodel.schema import (
    ElementType,
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
            RelationshipType(name="AbsRel", abstract=True, source="Block", target="Block"),
            RelationshipType(name="HasPart", source="Block", target="Block"),
            RelationshipType(name="Feeds", source="Sensor", target="Other"),
            RelationshipType(name="Owns", source="Base", target="Other"),
        ],
    )


def test_descendants_include_self_and_transitive_subtypes() -> None:
    mm = _mm()
    assert mm.element_descendants("Base") == frozenset({"Base", "Block", "Sensor"})
    assert mm.element_descendants("Block") == frozenset({"Block", "Sensor"})
    assert mm.element_descendants("Sensor") == frozenset({"Sensor"})
    assert mm.element_descendants("Other") == frozenset({"Other"})


def test_descendants_unknown_type_is_empty() -> None:
    assert _mm().element_descendants("Nope") == frozenset()


def test_relationship_types_from_matches_ancestors() -> None:
    mm = _mm()
    # Sensor is a Block and a Base: HasPart (source Block), Feeds (source
    # Sensor), Owns (source Base) — but never the abstract AbsRel.
    assert sorted(mm.relationship_types_from("Sensor")) == ["Feeds", "HasPart", "Owns"]
    assert sorted(mm.relationship_types_from("Block")) == ["HasPart", "Owns"]
    assert mm.relationship_types_from("Other") == []


def test_relationship_types_to_matches_ancestors() -> None:
    mm = _mm()
    assert sorted(mm.relationship_types_to("Other")) == ["Feeds", "Owns"]
    assert sorted(mm.relationship_types_to("Sensor")) == ["HasPart"]
    assert mm.relationship_types_to("Base") == []  # abstract, no instances but
    # the cache is name-based: Base IS a mapping target nowhere, hence empty.


def test_unknown_type_rel_lookups_are_empty() -> None:
    mm = _mm()
    assert mm.relationship_types_from("Nope") == []
    assert mm.relationship_types_to("Nope") == []
