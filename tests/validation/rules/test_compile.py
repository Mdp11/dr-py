"""Compilation: dispatch map, drift skips, unparseable-set tolerance."""

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.validation.rules.compile import (
    RuleSetSource,
    applies_type_names,
    compile_rule_sets,
    empty_compiled,
)


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="critical", datatype="boolean"),
                ],
            ),
            ElementType(name="OfficeBuilding", extends="Building"),
            ElementType(
                name="Zone",
                properties=[PropertyDef(name="evacuation_plan", datatype="string")],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Owns",
                containment=True,
                mappings=[Mapping(source="Building", target="Zone")],
            )
        ],
    )


def _src(yaml_text: str, artifact_id: str = "a1", name: str = "set-1") -> RuleSetSource:
    return RuleSetSource(artifact_id=artifact_id, name=name, yaml=yaml_text)


GOOD = """
rules:
  - name: has-zone
    applies_to: Building
    then:
      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}
"""


def test_compile_builds_subtype_closed_dispatch():
    c = compile_rule_sets([_src(GOOD)], _mm())
    assert c.total == 1 and not c.skipped
    assert set(c.rules_by_type) == {"Building", "OfficeBuilding"}
    assert c.rules[0].check == "rule:has-zone"


def test_disabled_rule_not_dispatched():
    doc = GOOD.replace("applies_to: Building", "applies_to: Building\n    disabled: true")
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 0 and not c.skipped and not c.rules_by_type


def test_unknown_applies_to_skips_rule_with_reason():
    doc = GOOD.replace("applies_to: Building", "applies_to: Bulding")
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 0
    assert c.skipped[0].rule == "has-zone"
    assert "Bulding" in c.skipped[0].reason


def test_unknown_relationship_type_and_far_type_skip():
    for bad in ("type: Owsn", "to: Zoen"):
        doc = GOOD.replace(bad.split(": ")[0] + ": " + {"type: Owsn": "Owns", "to: Zoen": "Zone"}[bad], bad)
        c = compile_rule_sets([_src(doc)], _mm())
        assert c.total == 0 and len(c.skipped) == 1


def test_unknown_property_on_context_skips():
    doc = (
        "rules:\n"
        "  - name: p\n    applies_to: Building\n"
        "    then: {property: nope, exists: true}\n"
    )
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 0 and "nope" in c.skipped[0].reason


def test_property_in_unfiltered_where_not_statically_checked():
    # no `to:` on the hop -> far context unknown -> property name not checkable
    doc = (
        "rules:\n"
        "  - name: w\n    applies_to: Building\n"
        "    then:\n"
        "      relationship:\n"
        "        type: Owns\n        direction: outgoing\n        exists: true\n"
        "        where: {property: whatever, exists: true}\n"
    )
    c = compile_rule_sets([_src(doc)], _mm())
    assert c.total == 1 and not c.skipped


def test_unparseable_set_skipped_whole_with_diagnostic():
    c = compile_rule_sets([_src("rules: [", name="broken"), _src(GOOD, "a2", "ok")], _mm())
    assert c.total == 1
    assert c.skipped[0].set_name == "broken" and c.skipped[0].rule == ""


def test_empty_and_applies_union():
    assert empty_compiled().total == 0
    c = compile_rule_sets([_src(GOOD)], _mm())
    assert applies_type_names(empty_compiled(), c) == {"Building", "OfficeBuilding"}
