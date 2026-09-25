"""Rule sets parsed and compiled as the server does: every construct of the
grammar, parse and schema failures, each drift reason and which one comes
first, a disabled rule that would drift, abstract ``applies_to`` types, two
sets of one name, an empty set; the same sources against two metamodels, so
that the same YAML drifts differently."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import rules_step, run_steps

_PROPS = [
    {"name": "flag", "datatype": "boolean"},
    {"name": "score", "datatype": "float"},
    {"name": "tags", "datatype": "string", "multiplicity": "0..*"},
    {"name": "day", "datatype": "date"},
    {"name": "tone", "datatype": "Tone"},
    {"name": "peer", "datatype": "Leaf"},
]

_METAMODEL_A = {
    "enums": {"Tone": ["dark", "light"]},
    "elements": [
        {
            "name": "Root",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Mid",
            "abstract": True,
            "extends": "Root",
            "properties": [{"name": "level", "datatype": "integer"}],
        },
        {"name": "Leaf", "extends": "Mid", "properties": _PROPS},
        {"name": "Twig", "extends": "Leaf"},
        {
            "name": "Other",
            "extends": "Root",
            "properties": [{"name": "code", "datatype": "string"}],
        },
    ],
    "relationships": [
        {
            "name": "Link",
            "source": "Root",
            "target": "Root",
            "properties": [{"name": "weight", "datatype": "float"}],
        },
        {"name": "SubLink", "extends": "Link"},
        {"name": "SubSubLink", "extends": "SubLink"},
        {"name": "Owns", "containment": True, "source": "Root", "target": "Root"},
    ],
}

#: the same names, less: no `Other`, no `SubLink` (so no `SubSubLink`), and
#: `Leaf` without `score`
_METAMODEL_B = {
    "enums": {"Tone": ["dark", "light"]},
    "elements": [
        {
            "name": "Root",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Mid",
            "abstract": True,
            "extends": "Root",
            "properties": [{"name": "level", "datatype": "integer"}],
        },
        {
            "name": "Leaf",
            "extends": "Mid",
            "properties": [p for p in _PROPS if p["name"] != "score"],
        },
        {"name": "Twig", "extends": "Leaf"},
    ],
    "relationships": [
        {
            "name": "Link",
            "source": "Root",
            "target": "Root",
            "properties": [{"name": "weight", "datatype": "float"}],
        },
        {"name": "Owns", "containment": True, "source": "Root", "target": "Root"},
    ],
}

#: every construct: each combinator, each property test, both relationship
#: tests with every count bound, `to` and nested `where`, `when`, severities,
#: description and message, operands of every kind
_ALL = """\
schema_version: 1
rules:
  - name: every-test
    description: each property test once
    applies_to: Leaf
    severity: warning
    disabled: false
    when:
      all:
        - {property: flag, exists: true}
        - not: {property: name, equals: null}
    then:
      any:
        - {property: name, equals: "x"}
        - {property: name, not_equals: null}
        - {property: level, in: [1, "1", true, 1.0, 1.5, 9007199254740993, -0.0]}
        - {property: score, gt: 1}
        - {property: score, gte: .inf}
        - {property: score, lt: -.inf}
        - {property: score, lte: .nan}
        - {property: tags, contains: "a"}
        - {property: level, equals: 18446744073709551616}
        - {property: score, equals: 2.5e-8}
        - {property: flag, not_equals: false}
        - {property: level, exists: false}
    message: custom text
  - name: relationships
    applies_to: Root
    then:
      all:
        - relationship: {type: Link, direction: outgoing, exists: true}
        - relationship:
            type: SubLink
            direction: incoming
            to: Mid
            count: {eq: 2, gte: 1, lte: 3}
        - relationship:
            type: Link
            direction: outgoing
            to: Leaf
            where:
              any:
                - {property: score, gt: 0.5}
                - relationship:
                    type: Owns
                    direction: incoming
                    to: Other
                    where: {property: code, exists: true}
                    exists: false
            count: {gte: 0}
  - name: nulls-as-pydantic-reads-them
    applies_to: Leaf
    when: null
    then:
      relationship:
        type: Link
        direction: outgoing
        to: null
        where: null
        exists: null
        count: {eq: null, gte: 1}
    message: null
"""

_BAD_YAML = "rules:\n  - name: broken\n    applies_to: [Leaf\n"
_ALIAS = "rules:\n  - &r {name: a, applies_to: Leaf, then: {property: flag, exists: true}}\n  - *r\n"
_SCHEMA = """\
rules:
  - name: twice
    applies_to: Leaf
    then: {property: flag, exists: true}
  - name: twice
    applies_to: Twig
    then: {property: flag, exists: false}
"""

#: each drift reason, and which one is reported when a rule has several
_DRIFT = """\
rules:
  - name: unknown-applies
    applies_to: "it's"
    then: {property: flag, exists: true}
  - name: unknown-property
    applies_to: Leaf
    then: {property: "a\\u200bb", exists: true}
  - name: subtype-only-property
    applies_to: Mid
    then: {property: flag, exists: true}
  - name: unknown-relationship
    applies_to: Leaf
    then:
      relationship: {type: Nope, direction: outgoing, exists: true}
  - name: unknown-to
    applies_to: Leaf
    then:
      relationship: {type: Link, direction: outgoing, to: Ghost, exists: true}
  - name: when-before-then
    applies_to: Leaf
    when: {property: ghost_when, exists: true}
    then:
      relationship: {type: Nope, direction: outgoing, exists: true}
  - name: where-against-to
    applies_to: Leaf
    then:
      relationship:
        type: Link
        direction: outgoing
        to: Other
        where: {property: flag, exists: true}
        exists: true
  - name: where-without-to
    applies_to: Leaf
    then:
      relationship:
        type: Link
        direction: outgoing
        where: {property: anything_at_all, exists: true}
        exists: true
  - name: first-of-all
    applies_to: Leaf
    then:
      all:
        - {property: flag, exists: true}
        - relationship: {type: SubSubLink, direction: incoming, exists: true}
        - {property: score, gt: 1}
        - {property: ghost_later, exists: true}
  - name: under-not
    applies_to: Other
    then:
      not: {property: score, exists: true}
  - name: disabled-drift
    applies_to: Ghost
    disabled: true
    then: {property: flag, exists: true}
  - name: disabled-clean
    applies_to: Leaf
    disabled: true
    then: {property: flag, exists: true}
"""

#: abstract applies types reach every descendant
_ABSTRACT = """\
rules:
  - name: on-root
    applies_to: Root
    then: {property: name, exists: true}
  - name: on-mid
    applies_to: Mid
    then: {property: level, gte: 0}
"""

_SAME_NAME_1 = """\
rules:
  - name: twin
    applies_to: Leaf
    then: {property: flag, exists: true}
"""

_SAME_NAME_2 = """\
rules:
  - name: twin
    applies_to: Twig
    then: {property: tags, exists: true}
"""

_SOURCES = [
    ("a-all", "All", _ALL),
    ("a-bad", "Broken", _BAD_YAML),
    ("a-alias", "Aliased", _ALIAS),
    ("a-schema", "Schema", _SCHEMA),
    ("a-drift", "Drift", _DRIFT),
    ("a-abstract", "Abstract", _ABSTRACT),
    ("a-twin-2", "Twins", _SAME_NAME_2),
    ("a-twin-1", "Twins", _SAME_NAME_1),
    ("a-empty", "Empty", ""),
    ("a-blank", "\U0001f600 blank", "# nothing\n"),
    ("a-bmp", "￿ last", "rules: []\n"),
]


def _run(metamodel: dict[str, Any]) -> Any:
    return run_steps(Metamodel.model_validate(metamodel), [rules_step(_SOURCES)])


@scenario("rules_compile")
def rules_compile() -> Any:
    return {"runs": [_run(_METAMODEL_A), _run(_METAMODEL_B)]}
