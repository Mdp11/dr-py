"""Rules evaluated as the server's validator evaluates them: every property
test against every kind of value — ints, floats integral and not, booleans,
strings, lists of each, a nested list, a dict, ``[]``, ``None`` alone and in a
list, an absent key, and integers past 2^53 beside the float they round to —
then relationship atoms over subtype edges, self-loops, parallel edges,
multi-level ``to`` subtypes and a relationship atom inside a ``where``. Rules
carry ``when``, both severities, custom and empty messages, descriptions,
names no ``repr`` touches, ``Infinity`` and ``NaN`` bounds, and two sets apply
to one type, which orders an owner's issues."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, rules_step, run_steps, validate_step

_METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Item",
            "extends": "Thing",
            "properties": [{"name": "v", "datatype": "string", "multiplicity": "0..*"}],
        },
        {"name": "Hub", "extends": "Thing"},
        {
            "name": "Spoke",
            "extends": "Thing",
            "properties": [{"name": "s", "datatype": "string"}],
        },
        {"name": "SubSpoke", "extends": "Spoke"},
        {"name": "DeepSpoke", "extends": "SubSpoke"},
    ],
    "relationships": [
        {
            "name": "Conn",
            "source": "Thing",
            "target": "Thing",
            "properties": [{"name": "weight", "datatype": "float"}],
        },
        {"name": "SubConn", "extends": "Conn"},
        {"name": "DeepConn", "extends": "SubConn"},
        {"name": "Aside", "source": "Thing", "target": "Thing"},
    ],
}

_BIG = 2**53

#: one element per kind of value `v` can hold; `i-absent` has no `v`
_VALUES: dict[str, Any] = {
    "i-int": 1,
    "i-int2": 2,
    "i-f1": 1.0,
    "i-f15": 1.5,
    "i-neg0": -0.0,
    "i-true": True,
    "i-false": False,
    "i-str": "x",
    "i-ab": "ab",
    "i-estr": "",
    "i-li": [1, 2],
    "i-lf": [2.0],
    "i-lb": [True],
    "i-ls": ["x", "ab"],
    "i-nest": [[1], "x"],
    "i-dict": {"a": 1},
    "i-elist": [],
    "i-null": None,
    "i-lnull": [None],
    "i-lnull1": [None, 1],
    "i-big": _BIG + 1,
    "i-big0": _BIG,
    "i-p60": 2**60,
}


def _el(entity_id: str, type_name: str, **properties: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "properties": properties,
    }


def _rel(
    entity_id: str, type_name: str, source: str, target: str, **properties: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": properties,
    }


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


def _delete_rel(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


_ITEMS = [
    _el(entity_id, "Item", **({} if entity_id == "i-absent" else {"v": value}))
    for entity_id, value in [*_VALUES.items(), ("i-absent", None)]
]

#: every property test, each against every value above
_TESTS = f"""\
rules:
  - {{name: exists-true, applies_to: Item, then: {{property: v, exists: true}}}}
  - {{name: exists-false, applies_to: Item, then: {{property: v, exists: false}}}}
  - {{name: eq-int, applies_to: Item, then: {{property: v, equals: 1}}}}
  - {{name: eq-float, applies_to: Item, then: {{property: v, equals: 1.0}}}}
  - {{name: eq-true, applies_to: Item, then: {{property: v, equals: true}}}}
  - {{name: eq-str, applies_to: Item, then: {{property: v, equals: x}}}}
  - {{name: eq-null, applies_to: Item, then: {{property: v, equals: null}}}}
  - {{name: eq-big, applies_to: Item, then: {{property: v, equals: {_BIG + 1}}}}}
  - {{name: eq-big-float, applies_to: Item, then: {{property: v, equals: {_BIG}.0}}}}
  - {{name: eq-p60-float, applies_to: Item, then: {{property: v, equals: {2**60}.0}}}}
  - {{name: eq-nan, applies_to: Item, then: {{property: v, equals: .nan}}}}
  - {{name: ne-int, applies_to: Item, then: {{property: v, not_equals: 1}}}}
  - {{name: ne-null, applies_to: Item, then: {{property: v, not_equals: null}}}}
  - {{name: in-mixed, applies_to: Item, then: {{property: v, in: [x, 2, false]}}}}
  - {{name: in-empty, applies_to: Item, then: {{property: v, in: []}}}}
  - {{name: gt-one, applies_to: Item, then: {{property: v, gt: 1}}}}
  - {{name: gte-one, applies_to: Item, then: {{property: v, gte: 1.0}}}}
  - {{name: lt-two, applies_to: Item, then: {{property: v, lt: 2}}}}
  - {{name: lte-zero, applies_to: Item, then: {{property: v, lte: 0}}}}
  - {{name: gt-big, applies_to: Item, then: {{property: v, gt: {_BIG}.0}}}}
  - {{name: gte-big, applies_to: Item, then: {{property: v, gte: {_BIG}.0}}}}
  - {{name: lt-inf, applies_to: Item, then: {{property: v, lt: .inf}}}}
  - {{name: gt-ninf, applies_to: Item, then: {{property: v, gt: -.inf}}}}
  - {{name: lte-nan, applies_to: Item, then: {{property: v, lte: .nan}}}}
  - {{name: contains-a, applies_to: Item, then: {{property: v, contains: a}}}}
  - {{name: contains-x, applies_to: Item, then: {{property: v, contains: x}}}}
  - {{name: contains-one, applies_to: Item, then: {{property: v, contains: 1}}}}
  - {{name: contains-empty, applies_to: Item, then: {{property: v, contains: ""}}}}
"""

#: the rule's own parts: `when`, severity, messages, descriptions, names
_PARTS = """\
rules:
  - name: guarded
    applies_to: Item
    severity: warning
    description: only where v exists
    when: {property: v, exists: true}
    then: {property: v, gt: 0}
  - name: custom
    applies_to: Item
    when: {property: v, equals: x}
    then: {property: v, equals: y}
    message: "v is 'x', not y"
  - name: empty-message
    applies_to: Item
    description: falls back
    when: {not: {property: v, exists: true}}
    then: {property: v, exists: true}
    message: ""
  - name: "it's"
    applies_to: Item
    when: {property: v, in: [ab]}
    then: {property: v, equals: x}
  - name: "règle ✓"
    applies_to: Thing
    severity: warning
    when: {any: [{property: name, equals: far}, {property: name, equals: h2}]}
    then: {not: {property: name, exists: true}}
"""

#: relationship atoms, over the web below
_WEB = f"""\
rules:
  - name: out-exists
    applies_to: Hub
    then: {{relationship: {{type: Conn, direction: outgoing, exists: true}}}}
  - name: no-subconn
    applies_to: Hub
    then: {{relationship: {{type: SubConn, direction: outgoing, exists: false}}}}
  - name: two-spokes
    applies_to: Hub
    then:
      relationship: {{type: Conn, direction: outgoing, to: Spoke, count: {{eq: 2}}}}
  - name: sub-spokes
    applies_to: Hub
    then:
      relationship: {{type: Conn, direction: outgoing, to: SubSpoke, count: {{gte: 2}}}}
  - name: in-one-or-two
    applies_to: Hub
    then:
      relationship: {{type: Conn, direction: incoming, count: {{gte: 1, lte: 2}}}}
  - name: nested-where
    applies_to: Hub
    then:
      relationship:
        type: Conn
        direction: outgoing
        to: Spoke
        where:
          all:
            - {{property: s, exists: true}}
            - relationship: {{type: Conn, direction: outgoing, to: SubSpoke, exists: true}}
        count: {{gte: 1}}
  - name: where-without-to
    applies_to: Hub
    then:
      relationship:
        type: Conn
        direction: outgoing
        where: {{property: name, equals: far}}
        exists: true
  - name: heavy-in
    applies_to: Thing
    when: {{relationship: {{type: Conn, direction: incoming, exists: true}}}}
    then:
      relationship:
        type: DeepConn
        direction: incoming
        where: {{not: {{relationship: {{type: Aside, direction: incoming, exists: true}}}}}}
        count: {{lte: 0}}
  - name: huge-count
    applies_to: Spoke
    then:
      relationship: {{type: Conn, direction: incoming, count: {{eq: {2**64}, lte: {2**70}}}}}
"""

_WEB_OPS = [
    _el("h-1", "Hub", name="h1"),
    _el("h-2", "Hub", name="h2"),
    _el("h-3", "Hub", name="far"),
    _el("h-4", "Hub"),
    _el("s-1", "Spoke", name="far", s="a"),
    _el("s-2", "SubSpoke", name="s2"),
    _el("s-3", "DeepSpoke", s="c"),
    _el("s-4", "Spoke"),
]

_WEB_RELS = [
    _rel("c-1", "Conn", "h-1", "s-1", weight=1.5),
    _rel("c-2", "SubConn", "h-1", "s-2"),
    _rel("c-3", "DeepConn", "h-1", "s-3"),
    # a self-loop, and two parallel edges
    _rel("c-4", "Conn", "h-2", "h-2"),
    _rel("c-5", "Conn", "h-2", "s-1"),
    _rel("c-6", "Conn", "h-2", "s-1"),
    _rel("c-7", "Conn", "s-1", "s-2"),
    _rel("c-8", "Conn", "h-4", "h-1"),
    _rel("c-9", "DeepConn", "h-3", "s-4"),
    _rel("a-1", "Aside", "h-4", "h-3"),
    _rel("a-2", "Aside", "s-3", "s-3"),
]

_STEPS: list[dict[str, Any]] = [
    batch(_ITEMS),
    batch(_WEB_OPS),
    batch(_WEB_RELS),
    rules_step(
        [
            ("r-tests", "Values", _TESTS),
            ("r-parts", "Parts", _PARTS),
            ("r-web", "Web", _WEB),
        ]
    ),
    validate_step("all_ids"),
    # an unknown id, a relationship id, an id twice, in no state order
    validate_step(["s-1", "ghost", "c-4", "h-2", "s-1", "i-lnull1", "i-absent"]),
    validate_step(["h-4", "h-3", "h-2", "h-1"]),
    # s-1 loses its `s` and its edge to a sub-spoke; h-3 gains an Aside
    batch([_update("s-1", s=None), _delete_rel("c-7")]),
    batch([_rel("a-3", "Aside", "h-1", "s-3"), _update("i-int", v=[1, "x"])]),
    batch(
        [
            _rel("c-10", "DeepConn", "h-3", "s-2"),
            _update("h-4", name="far"),
            _update("i-big", v=_BIG),
        ]
    ),
    validate_step("all_ids"),
]


@scenario("rules_eval")
def rules_eval() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
