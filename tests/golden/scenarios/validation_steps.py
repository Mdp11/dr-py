"""The issue store as a session keeps it: seeded by the server's sweep, then
spliced by every batch as ``POST /model/ops`` splices it, and read back
through ``GET /model/issues`` after each. The batches make and mend every
kind of issue — a duplicate, a cycle, a dangling reference among them — and
one is refused, which leaves the store as it was. Then staged ops go through
``POST /commits/preview`` and the staged branch of ``POST /model/validate``:
they fix, make and duplicate issues, cascade-delete a primary, touch an
entity whose issue stands, and run strict and not, which leave the model and
the store as they were.

A second session holds two rule sets whose atoms reach two hops. Its
batches flip a verdict two hops away in both directions, rename a far
element and delete a middle one; then the rule sets change: one rule
changed, one removed, one added. Staged ops break a rule on an element they
never touch, which blocks a strict preview, and mend it again."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, rules_step, run_steps

_METAMODEL = {
    "enums": {"Color": ["red", "green"]},
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Blk",
            "extends": "Base",
            "properties": [
                {"name": "n", "datatype": "integer", "min": 0, "max": 5},
                {"name": "c", "datatype": "Color"},
                {"name": "b", "datatype": "boolean"},
                {
                    "name": "code",
                    "datatype": "string",
                    "pattern": "[A-Z]+",
                    "max_length": 3,
                },
                {"name": "ref", "datatype": "Blk"},
                {"name": "req", "datatype": "string", "multiplicity": "1"},
            ],
        },
        {"name": "Other", "extends": "Base"},
        {"name": "Car", "extends": "Base"},
        {"name": "Wheel", "extends": "Base"},
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Base", "target": "Base"},
        {
            "name": "Link",
            "mappings": [{"source": "Blk", "target": "Other"}],
            "properties": [{"name": "lbl", "datatype": "string", "multiplicity": "1"}],
        },
        {
            "name": "Needs",
            "source": "Car",
            "target": "Wheel",
            "target_multiplicity": "1..*",
        },
    ],
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


def _update_rel(rel_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_relationship", "id": rel_id, "properties_patch": patch}


def _delete(entity_id: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": entity_id}


def _delete_rel(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


_ISSUES: dict[str, Any] = {"do": "issues"}

#: a batch that makes or mends issues, then the store it leaves
_BATCHES: list[list[dict[str, Any]]] = [
    # not a valid integer, then mended
    [_update("b-1", n=1.0)],
    [_update("b-1", n=2)],
    # re-validated with its issue unchanged, an owner goes last
    [_update("car-1", name="car1b")],
    # the seeded facet issue mended, another made
    [_update("b-2", n=4), _update("b-1", n=-3)],
    # pattern and max_length, and the bound mended
    [_update("b-1", code="abcd", n=2)],
    [_update("b-1", code="AB")],
    # an enum and a boolean
    [_update("b-1", c="blue", b=1)],
    [_update("b-1", c="red", b=None)],
    # a reference dangling, then healed by the element it names
    [_update("b-1", ref="nope")],
    [_el("nope", "Blk", name="nope", req="z")],
    # a reference to an element of the wrong type, then removed
    [_update("b-1", ref="o-1")],
    [_update("b-1", ref=None)],
    # a property multiplicity
    [_update("b-1", req=None)],
    [_update("b-1", req="x")],
    # the seeded end multiplicity mended
    [_rel("n-1", "Needs", "car-1", "wheel-1")],
    # an endpoint pair no mapping allows, a relationship property missing
    [_rel("l-2", "Link", "o-1", "b-1", lbl="q"), _rel("l-3", "Link", "b-1", "o-2")],
    [_delete_rel("l-2"), _update_rel("l-3", lbl="x")],
    # a second containment parent
    [_rel("own-2", "Owns", "p-2", "x-1")],
    [_delete_rel("own-2")],
    # a cycle made, then broken
    [_rel("own-a", "Owns", "o-1", "o-2"), _rel("own-b", "Owns", "o-2", "o-1")],
    [_delete_rel("own-b")],
    # duplicates appear; the primary goes; the last one resolves
    [_el("d-1", "Other", name="d"), _el("d-2", "Other", name="d")],
    [_el("d-3", "Other", name="d"), _delete("d-1")],
    [_update("d-3", name="e")],
    # refused midway: the store stays as it was
    [_update("b-1", n=7), _update("ghost", n=1)],
    # the element of an unknown type goes
    [_delete("g-1")],
    # a cascade takes a contained element with it
    [_update("b-1", n=8), _delete("p-1")],
]


def _preview(ops: list[dict[str, Any]], *, strict: bool) -> dict[str, Any]:
    return {"do": "preview", "_ops": ops, "strict": strict}


def _validate_staged(ops: list[dict[str, Any]]) -> dict[str, Any]:
    return {"do": "validate_staged", "_ops": ops}


#: committed issues for the staged cases to meet: a duplicate group whose
#: primary contains an element, and an enum issue beside the facet one
_SETUP: list[dict[str, Any]] = [
    _el("q-1", "Other", name="q"),
    _el("q-2", "Other", name="q"),
    _el("q-3", "Other", name="q"),
    _el("k-1", "Other", name="k"),
    _rel("own-k", "Owns", "q-1", "k-1"),
    _update("b-2", c="blue"),
]

#: staged ops, each sent to both routes, strict or not
_STAGED: list[tuple[list[dict[str, Any]], bool]] = [
    # a committed issue fixed
    ([_update("b-1", n=2)], True),
    # a new one made, attributable
    ([_el("b-9", "Blk", name="b9", n=7, req="r")], True),
    ([_el("b-9", "Blk", name="b9", n=7, req="r")], False),
    # an existing element duplicated through a hinted create
    ([_el("q-9", "Other", name="q")], False),
    # the group's primary deleted with what it contains
    ([_delete("q-1")], True),
    # an entity whose issue stands touched: attributable all the same
    ([_update("b-1", name="b1x")], True),
    # a structural issue alone blocks nothing
    ([_rel("own-z", "Owns", "o-2", "k-1")], True),
    # all of it at once, owners interleaved
    (
        [
            _update("b-1", n=2, name="b1y"),
            _el("q-9", "Other", name="q"),
            _update("b-2", n=6),
            _delete("q-2"),
        ],
        True,
    ),
]

_STEPS: list[dict[str, Any]] = [
    batch(
        [
            _el("b-1", "Blk", name="b1", n=3, req="x"),
            _el("b-2", "Blk", name="b2", n=9, req="y"),
            _el("o-1", "Other", name="o1"),
            _el("o-2", "Other", name="o2"),
            _el("car-1", "Car", name="car1"),
            _el("wheel-1", "Wheel", name="wheel1"),
            _el("p-1", "Other", name="p1"),
            _el("p-2", "Other", name="p2"),
            _el("x-1", "Other", name="x1"),
            _rel("own-1", "Owns", "p-1", "x-1"),
            _rel("l-1", "Link", "b-1", "o-1", lbl="a"),
        ]
    ),
    {
        "do": "insert_element",
        "id": "g-1",
        "type": "Gad",
        "_value": {"x": 1},
        "rev": 1,
    },
    {"do": "seed"},
    _ISSUES,
    *(step for ops in _BATCHES for step in (batch(ops), _ISSUES)),
    batch(_SETUP),
    _ISSUES,
    *(
        step
        for ops, strict in _STAGED
        for step in (_validate_staged(ops), _preview(ops, strict=strict))
    ),
    # nothing staged at all
    _preview([], strict=True),
]


#: part 3: a session with rule sets whose atoms reach across two hops
_RULES_METAMODEL = {
    "elements": [
        {
            "name": "Node",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Unit",
            "extends": "Node",
            "properties": [{"name": "level", "datatype": "integer"}],
        },
        {
            "name": "Port",
            "extends": "Node",
            "properties": [
                {"name": "open", "datatype": "boolean"},
                {"name": "speed", "datatype": "integer"},
            ],
        },
        {
            "name": "Hub",
            "extends": "Node",
            "properties": [{"name": "zone", "datatype": "string"}],
        },
    ],
    "relationships": [
        {"name": "Has", "containment": True, "source": "Unit", "target": "Port"},
        {"name": "Plugs", "source": "Port", "target": "Hub"},
        {"name": "Feeds", "source": "Hub", "target": "Hub"},
    ],
}

#: a unit reaches a core hub through one of its ports; hubs are fed
_ALPHA = """\
rules:
  - name: unit-reaches-core
    applies_to: Unit
    when: {property: name, exists: true}
    then:
      relationship:
        type: Has
        direction: outgoing
        to: Port
        exists: true
        where:
          relationship:
            type: Plugs
            direction: outgoing
            to: Hub
            exists: true
            where:
              all:
                - {property: zone, equals: core}
                - {property: name, not_equals: offline}
  - name: hub-fed
    applies_to: Hub
    severity: warning
    then:
      relationship: {type: Feeds, direction: incoming, count: {gte: 1}}
"""

#: ports are open; a hub is plugged by a port of a unit of level 2 or more
_BETA = """\
rules:
  - name: port-open
    applies_to: Port
    message: port is closed
    then: {property: open, equals: true}
  - name: hub-plugged
    applies_to: Hub
    description: a hub serves a senior unit
    then:
      relationship:
        type: Plugs
        direction: incoming
        to: Port
        count: {gte: 1}
        where:
          relationship:
            type: Has
            direction: incoming
            to: Unit
            exists: true
            where: {property: level, gte: 2}
"""

#: ``hub-fed`` removed, ``port-open`` changed, ``unit-level`` added
_ALPHA_2 = """\
rules:
  - name: unit-reaches-core
    applies_to: Unit
    when: {property: name, exists: true}
    then:
      relationship:
        type: Has
        direction: outgoing
        to: Port
        exists: true
        where:
          relationship:
            type: Plugs
            direction: outgoing
            to: Hub
            exists: true
            where:
              all:
                - {property: zone, equals: core}
                - {property: name, not_equals: offline}
  - name: unit-level
    applies_to: Unit
    then: {property: level, lt: 3}
"""

_BETA_2 = """\
rules:
  - name: port-open
    applies_to: Port
    message: port is closed or slow
    then:
      all:
        - {property: open, equals: true}
        - {property: speed, exists: true}
  - name: hub-plugged
    applies_to: Hub
    description: a hub serves a senior unit
    then:
      relationship:
        type: Plugs
        direction: incoming
        to: Port
        count: {gte: 1}
        where:
          relationship:
            type: Has
            direction: incoming
            to: Unit
            exists: true
            where: {property: level, gte: 2}
"""

_RULES_MODEL: list[dict[str, Any]] = [
    _el("u-1", "Unit", name="u1", level=3),
    _el("u-2", "Unit", name="u2", level=1),
    _el("u-3", "Unit", name="u3", level=2),
    _el("p-1", "Port", name="p1", open=True, speed=10),
    _el("p-2", "Port", name="p2", open=True),
    _el("p-3", "Port", name="p3", open=True, speed=7),
    _el("h-1", "Hub", name="h1", zone="core"),
    _el("h-2", "Hub", name="h2", zone="edge"),
    _el("h-3", "Hub", name="h3", zone="core"),
    _el("h-4", "Hub", name="h4", zone="core"),
    _rel("has-1", "Has", "u-1", "p-1"),
    _rel("has-2", "Has", "u-2", "p-2"),
    _rel("has-3", "Has", "u-3", "p-3"),
    _rel("pl-1", "Plugs", "p-1", "h-1"),
    _rel("pl-2", "Plugs", "p-2", "h-2"),
    _rel("pl-3", "Plugs", "p-3", "h-4"),
    _rel("f-1", "Feeds", "h-1", "h-2"),
    _rel("f-2", "Feeds", "h-2", "h-1"),
    _rel("f-3", "Feeds", "h-1", "h-4"),
]

_RULES_BATCHES: list[list[dict[str, Any]]] = [
    # a hub two hops from its unit leaves the core
    [_update("h-1", zone="edge")],
    # a unit two hops from its hub grows senior
    [_update("u-2", level=2)],
    [_update("h-2", zone="core")],
    # a far element renamed
    [_update("h-2", name="offline")],
    [_update("h-1", zone="core")],
    # the middle element goes, its relationships with it
    [_delete("p-1")],
]

#: breaks ``unit-reaches-core`` on ``u-3``, which it never touches
_BREAK = [_update("h-4", zone="edge")]
#: the same, and a core hub for ``p-3`` to plug into
_BREAK_AND_FIX = [*_BREAK, _rel("pl-9", "Plugs", "p-3", "h-1")]

_RULES_STEPS: list[dict[str, Any]] = [
    rules_step([("r-alpha", "Alpha", _ALPHA), ("r-beta", "Beta", _BETA)]),
    batch(_RULES_MODEL),
    {"do": "seed"},
    _ISSUES,
    *(step for ops in _RULES_BATCHES for step in (batch(ops), _ISSUES)),
    rules_step([("r-alpha", "Alpha", _ALPHA_2), ("r-beta", "Beta", _BETA_2)]),
    _ISSUES,
    *(
        step
        for ops in (_BREAK, _BREAK_AND_FIX)
        for step in (_validate_staged(ops), _preview(ops, strict=True))
    ),
]


@scenario("validation_steps")
def validation_steps() -> Any:
    return {
        "runs": [
            run_steps(Metamodel.model_validate(_METAMODEL), _STEPS),
            run_steps(Metamodel.model_validate(_RULES_METAMODEL), _RULES_STEPS),
        ]
    }
