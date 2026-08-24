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
    RULES_ADAPTER.validate_python({"schema_version": 1, "yaml": "rules: []\n"})
    with pytest.raises(ValidationError):
        RULES_ADAPTER.validate_python({"schema_version": 1, "yaml": "rules: [bad"})
    with pytest.raises(ValidationError):
        RULES_ADAPTER.validate_python(
            {"schema_version": 1, "yaml": "x" * (RULES_MAX_YAML_BYTES + 1)}
        )


def _deeply_nested_not_doc(depth: int) -> str:
    inner = "{property: p, exists: true}"
    for _ in range(depth):
        inner = "{not: " + inner + "}"
    return f"rules:\n  - {{name: r, applies_to: B, then: {inner}}}\n"


def test_deeply_nested_yaml_raises_rule_set_error_not_recursion_error():
    # PyYAML's own parser recurses per nesting level and can blow the
    # interpreter's recursion limit before pydantic (and MAX_CONDITION_DEPTH)
    # ever sees the data. This must surface as RuleSetError, not RecursionError.
    doc = _deeply_nested_not_doc(800)
    # match the parse-stage message: pydantic's own depth cap would also raise
    # RuleSetError, so a bare exception-type assertion would silently stop
    # exercising the `except RecursionError` arm if PyYAML's stack threshold moved
    with pytest.raises(RuleSetError, match="Malformed rules YAML"):
        parse_rule_set(doc)


def test_deeply_nested_yaml_payload_raises_validation_error():
    doc = _deeply_nested_not_doc(800)
    assert len(doc) <= RULES_MAX_YAML_BYTES
    with pytest.raises(ValidationError):
        RULES_ADAPTER.validate_python({"schema_version": 1, "yaml": doc})


# -- YAML aliases -----------------------------------------------------------


def _alias_bomb(levels: int) -> str:
    """Nested YAML anchors: linear source text, exponential expanded shape."""
    lines = ["a: &a0 [x, x, x, x, x, x, x, x, x]"]
    for i in range(1, levels + 1):
        row = ", ".join([f"*a{i - 1}"] * 9)
        lines.append(f"b{i}: &a{i} [{row}]")
    lines.append(f"rules: *a{levels}")
    return "\n".join(lines) + "\n"


def test_alias_bomb_rejected_at_parse():
    """PyYAML loads an aliased document as a shared-reference DAG in flat time,
    then pydantic walks it as a tree: a few hundred bytes — under every cap,
    which all measure source text — expands into gigabytes of validation."""
    doc = _alias_bomb(7)
    assert len(doc) < 1024
    with pytest.raises(RuleSetError, match="alias"):
        parse_rule_set(doc)


def test_alias_rejected_even_when_harmless():
    doc = "rules: []\nreused: &anchor [1, 2]\nagain: *anchor\n"
    with pytest.raises(RuleSetError, match="alias"):
        parse_rule_set(doc)


# -- null-valued tests ------------------------------------------------------


@pytest.mark.parametrize("test", ["exists", "gt", "gte", "lt", "lte", "in", "contains"])
def test_null_operand_rejected_where_it_cannot_mean_anything(test):
    doc = f"rules:\n  - {{name: bad, applies_to: B, then: {{property: p, {test}: null}}}}\n"
    with pytest.raises(RuleSetError, match="needs a value, got null"):
        parse_rule_set(doc)


@pytest.mark.parametrize("test", ["equals", "not_equals"])
def test_null_operand_kept_for_equality_tests(test):
    """Comparing a property against null is a real query."""
    doc = f"rules:\n  - {{name: ok, applies_to: B, then: {{property: p, {test}: null}}}}\n"
    assert test in parse_rule_set(doc).rules[0].then.model_fields_set


# -- document shape ---------------------------------------------------------


@pytest.mark.parametrize("doc", ["false", "0", "''", "[]", "- a\n- b\n"])
def test_non_mapping_document_is_rejected_not_silently_empty(doc):
    """A falsy-but-present document is a wrong rule set, not an empty one."""
    with pytest.raises(RuleSetError):
        parse_rule_set(doc)


def test_empty_document_is_an_empty_rule_set():
    assert parse_rule_set("").rules == []
    assert parse_rule_set("# just a comment\n").rules == []


def test_schema_version_is_pinned():
    with pytest.raises(RuleSetError, match="schema_version"):
        parse_rule_set("schema_version: 99\nrules: []\n")
