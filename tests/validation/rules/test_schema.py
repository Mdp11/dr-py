"""Rule-set schema: shape acceptance/rejection and caps."""

import pytest
from pydantic import ValidationError

from data_rover.core.validation.rules.schema import (
    MAX_CONDITION_DEPTH,
    MAX_RULES_PER_SET,
    RULES_ADAPTER,
    RULES_MAX_YAML_BYTES,
    RuleSetError,
    parse_rule_set,
)

VALID = """
schema_version: 1
rules:
  - name: critical-buildings-have-evacuation
    applies_to: Building
    severity: error
    when:
      all:
        - property: critical
          equals: true
        - any:
            - property: zone_count
              gte: 3
            - not:
                property: exempt
                equals: true
    then:
      relationship:
        type: Owns
        direction: outgoing
        to: Zone
        count: { gte: 1 }
        where:
          property: evacuation_plan
          exists: true
"""


def test_valid_document_parses():
    rs = parse_rule_set(VALID)
    assert rs.schema_version == 1
    assert rs.rules[0].name == "critical-buildings-have-evacuation"
    assert rs.rules[0].when is not None
    assert rs.rules[0].severity == "error"
    assert rs.rules[0].disabled is False


def test_minimal_rule_defaults():
    rs = parse_rule_set(
        "rules:\n"
        "  - name: r1\n"
        "    applies_to: Building\n"
        "    then:\n"
        "      property: name\n"
        "      exists: true\n"
    )
    r = rs.rules[0]
    assert r.when is None and r.severity == "error" and r.message is None


def test_unparseable_yaml_raises_rule_set_error():
    with pytest.raises(RuleSetError):
        parse_rule_set("rules: [unclosed")


def test_property_atom_requires_exactly_one_test():
    base = "rules:\n  - name: r\n    applies_to: B\n    then:\n"
    with pytest.raises(RuleSetError):
        parse_rule_set(base + "      property: p\n")  # zero tests
    with pytest.raises(RuleSetError):
        parse_rule_set(base + "      property: p\n      equals: 1\n      gte: 2\n")


def test_relationship_atom_requires_exactly_one_of_exists_count():
    base = (
        "rules:\n  - name: r\n    applies_to: B\n    then:\n"
        "      relationship:\n        type: T\n        direction: outgoing\n"
    )
    with pytest.raises(RuleSetError):
        parse_rule_set(base)  # neither
    with pytest.raises(RuleSetError):
        parse_rule_set(base + "        exists: true\n        count: { gte: 1 }\n")


def test_count_spec_needs_at_least_one_bound():
    with pytest.raises(RuleSetError):
        parse_rule_set(
            "rules:\n  - name: r\n    applies_to: B\n    then:\n"
            "      relationship:\n        type: T\n        direction: outgoing\n"
            "        count: {}\n"
        )


def test_unknown_keys_rejected():
    with pytest.raises(RuleSetError):
        parse_rule_set(
            "rules:\n  - name: r\n    applies_to: B\n    then:\n"
            "      property: p\n      exists: true\n      bogus: 1\n"
        )


def test_duplicate_rule_names_rejected():
    doc = (
        "rules:\n"
        "  - {name: r, applies_to: B, then: {property: p, exists: true}}\n"
        "  - {name: r, applies_to: C, then: {property: p, exists: true}}\n"
    )
    with pytest.raises(RuleSetError):
        parse_rule_set(doc)


def test_depth_cap_enforced():
    # nest `not:` MAX_CONDITION_DEPTH+1 levels around a property atom
    inner = "{property: p, exists: true}"
    for _ in range(MAX_CONDITION_DEPTH):
        inner = "{not: " + inner + "}"
    doc = f"rules:\n  - {{name: r, applies_to: B, then: {inner}}}\n"
    with pytest.raises(RuleSetError):
        parse_rule_set(doc)


def test_rule_count_cap():
    rules = "\n".join(
        f"  - {{name: r{i}, applies_to: B, then: {{property: p, exists: true}}}}"
        for i in range(MAX_RULES_PER_SET + 1)
    )
    with pytest.raises(RuleSetError):
        parse_rule_set("rules:\n" + rules)


def test_payload_adapter_validates_embedded_yaml():
    RULES_ADAPTER.validate_python(
        {"schema_version": 1, "yaml": "rules: []\n"}
    )
    with pytest.raises(ValidationError):
        RULES_ADAPTER.validate_python({"schema_version": 1, "yaml": "rules: [bad"})
    with pytest.raises(ValidationError):
        RULES_ADAPTER.validate_python(
            {"schema_version": 1, "yaml": "x" * (RULES_MAX_YAML_BYTES + 1)}
        )
