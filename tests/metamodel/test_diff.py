"""Structural metamodel diff.

Identity is the NAME everywhere; a rename is remove+add. The diff mirrors the
raw document (no inheritance flattening). `source`/`target` on relationship
types are deliberately NOT diffed as attributes — they are normalized mirrors
of `mappings[0]`, and the mappings diff is authoritative for endpoints.
"""

from data_rover.core.metamodel.diff import diff_metamodels
from data_rover.core.metamodel.loader import load_metamodel_str

_BASE = """
enums:
  Status: [ok, down]
elements:
  - name: Asset
    abstract: true
    properties:
      - name: label
        datatype: string
  - name: Building
    extends: Asset
    properties:
      - name: height
        datatype: float
        max: 10
relationships:
  - name: Owns
    containment: true
    source: Asset
    target: Asset
"""


def _mm(yaml_str: str):
    return load_metamodel_str(yaml_str)


def test_identical_metamodels_diff_empty() -> None:
    d = diff_metamodels(_mm(_BASE), _mm(_BASE))
    assert d.is_empty
    assert d.element_types.added == []
    assert d.element_types.changed == []
    assert d.relationship_types.changed == []
    assert d.enums.changed == []


def test_added_and_removed_element_types_carry_full_definitions() -> None:
    cand = _BASE.replace(
        "  - name: Building",
        "  - name: Tower",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    assert [t.name for t in d.element_types.added] == ["Tower"]
    assert [t.name for t in d.element_types.removed] == ["Building"]
    # full definitions, not just names — the removed side keeps its properties
    assert d.element_types.removed[0].properties[0].name == "height"
    # rename == remove+add: nothing lands in `changed`
    assert d.element_types.changed == []
    assert not d.is_empty


def test_property_facet_change_is_field_level() -> None:
    cand = _BASE.replace("max: 10", "max: 20")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.element_types.changed
    assert chg.name == "Building"
    assert chg.attributes == []
    (prop,) = chg.properties.changed
    assert prop.name == "height"
    (fc,) = prop.fields
    assert (fc.field, fc.from_, fc.to) == ("max", 10, 20)


def test_field_change_serializes_from_alias() -> None:
    cand = _BASE.replace("max: 10", "max: 20")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    dumped = d.element_types.changed[0].properties.changed[0].fields[0].model_dump(
        by_alias=True
    )
    assert dumped == {"field": "max", "from": 10, "to": 20}


def test_element_attribute_changes() -> None:
    cand = _BASE.replace("    abstract: true\n", "").replace(
        "    extends: Asset", "    extends: null"
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    by_name = {c.name: c for c in d.element_types.changed}
    assert {f.field for f in by_name["Asset"].attributes} == {"abstract"}
    assert {f.field for f in by_name["Building"].attributes} == {"extends"}


def test_property_added_and_removed() -> None:
    cand = _BASE.replace(
        "      - name: label\n        datatype: string",
        "      - name: title\n        datatype: string",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.element_types.changed
    assert chg.name == "Asset"
    assert [p.name for p in chg.properties.added] == ["title"]
    assert [p.name for p in chg.properties.removed] == ["label"]


def test_relationship_mapping_and_multiplicity_changes() -> None:
    cand = _BASE.replace(
        "    source: Asset\n    target: Asset",
        "    source_multiplicity: '1..1'\n"
        "    mappings:\n"
        "      - {source: Asset, target: Asset}\n"
        "      - {source: Building, target: Building}",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.relationship_types.changed
    assert chg.name == "Owns"
    assert {f.field for f in chg.attributes} == {"source_multiplicity"}
    assert [(m.source, m.target) for m in chg.mappings.added] == [
        ("Building", "Building")
    ]
    assert chg.mappings.removed == []


def test_source_target_shorthand_not_diffed_as_attributes() -> None:
    # mappings[0] changes => source/target mirrors change too, but only the
    # mappings diff reports it (shorthand fields are derived, not authored).
    cand = _BASE.replace(
        "    source: Asset\n    target: Asset",
        "    mappings:\n      - {source: Building, target: Building}",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.relationship_types.changed
    assert chg.attributes == []
    assert [(m.source, m.target) for m in chg.mappings.added] == [
        ("Building", "Building")
    ]
    assert [(m.source, m.target) for m in chg.mappings.removed] == [("Asset", "Asset")]


def test_enum_literal_add_remove_and_reorder() -> None:
    cand = _BASE.replace("Status: [ok, down]", "Status: [down, ok, archived]")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.enums.changed
    assert (chg.name, chg.added, chg.removed) == ("Status", ["archived"], [])
    # pure reorder alone is NOT a change
    reorder = _BASE.replace("Status: [ok, down]", "Status: [down, ok]")
    assert diff_metamodels(_mm(_BASE), _mm(reorder)).is_empty


def test_enum_added_and_removed_carry_literals() -> None:
    cand = _BASE.replace("  Status: [ok, down]", "  Grade: [a, b]")
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    assert [(e.name, e.literals) for e in d.enums.added] == [("Grade", ["a", "b"])]
    assert [(e.name, e.literals) for e in d.enums.removed] == [("Status", ["ok", "down"])]


def test_key_change_is_an_attribute() -> None:
    cand = _BASE.replace(
        "  - name: Building\n    extends: Asset",
        "  - name: Building\n    extends: Asset\n    key: [height]",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    (chg,) = d.element_types.changed
    (fc,) = chg.attributes
    assert (fc.field, fc.from_, fc.to) == ("key", None, ["height"])


def test_output_is_sorted_by_name() -> None:
    cand = _BASE.replace(
        "relationships:",
        "  - name: Zeta\n  - name: Alpha\nrelationships:",
    )
    d = diff_metamodels(_mm(_BASE), _mm(cand))
    assert [t.name for t in d.element_types.added] == ["Alpha", "Zeta"]
