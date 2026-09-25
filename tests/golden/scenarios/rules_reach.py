"""The rules' reach: paths one to three hops deep in both directions, a
``where`` extending its atom's path, ``to`` on an intermediate hop met by an
element of another type (the walk does not filter on it), relationship
subtypes, owners outside a rule's applies types (dropped); reach from
elements, relationship ids, deleted ids and unknown ids; and the dirty sets
of batches widened by it, for a far property edit, a middle relationship
deleted, a middle element cascade-deleted and a create that links two
paths."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, reach_step, rules_step, run_steps

_METAMODEL = {
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "p", "datatype": "string"},
            ],
        },
        {"name": "A", "extends": "Base"},
        {"name": "A2", "extends": "A"},
        {"name": "B", "extends": "Base"},
        {"name": "C", "extends": "Base"},
        {"name": "D", "extends": "Base"},
    ],
    "relationships": [
        {"name": "R", "source": "Base", "target": "Base"},
        {"name": "R2", "extends": "R"},
        {"name": "S", "source": "Base", "target": "Base"},
        {"name": "T", "source": "Base", "target": "Base"},
    ],
}

_RULES = """\
rules:
  - name: deep
    applies_to: A
    then:
      relationship:
        type: R
        direction: outgoing
        to: B
        where:
          relationship:
            type: S
            direction: incoming
            to: C
            where:
              relationship:
                type: T
                direction: outgoing
                where: {property: p, exists: true}
                exists: true
            exists: true
        exists: true
  - name: back
    applies_to: B
    when: {relationship: {type: R, direction: incoming, exists: true}}
    then: {property: p, exists: true}
  - name: fan
    applies_to: C
    then:
      not:
        relationship: {type: T, direction: outgoing, to: D, count: {gte: 2}}
"""


def _el(entity_id: str, type_name: str, **properties: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "properties": properties,
    }


def _rel(entity_id: str, type_name: str, source: str, target: str) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


_ELEMENTS = [
    _el("a-1", "A"),
    _el("a-2", "A"),
    _el("a-3", "A2"),
    _el("a-4", "A"),
    _el("b-1", "B"),
    _el("b-2", "B"),
    _el("b-3", "B"),
    _el("c-1", "C"),
    _el("c-2", "C"),
    _el("c-3", "C"),
    _el("d-1", "D", p="x"),
    _el("d-2", "D"),
    _el("d-3", "D", p="y"),
    _el("d-4", "D"),
    _el("d-5", "D", p="z"),
]

_RELATIONSHIPS = [
    # the whole path: a-1 -R-> b-1 <-S- c-1 -T-> d-1, the T edge twice
    _rel("r-1", "R", "a-1", "b-1"),
    _rel("s-1", "S", "c-1", "b-1"),
    _rel("t-1", "T", "c-1", "d-1"),
    _rel("t-2", "T", "c-1", "d-1"),
    # the middle hop meets a D where the rule names a B
    _rel("r-2", "R", "a-2", "d-2"),
    _rel("s-2", "S", "c-2", "d-2"),
    _rel("t-3", "T", "c-2", "d-3"),
    # a subtype edge from a subtype owner; an owner outside the applies types
    _rel("r-3", "R2", "a-3", "b-1"),
    _rel("r-4", "R", "d-4", "b-1"),
    # a self-loop
    _rel("r-5", "R", "b-2", "b-2"),
    # two halves, linked later: a-4 -R-> b-3, and c-3 -T-> d-5
    _rel("r-6", "R", "a-4", "b-3"),
    _rel("t-4", "T", "c-3", "d-5"),
]


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


_STEPS: list[dict[str, Any]] = [
    batch(_ELEMENTS),
    batch(_RELATIONSHIPS),
    rules_step([("rs-1", "Reach", _RULES)]),
    reach_step(["d-1"]),
    reach_step(["d-3"]),
    reach_step(["b-1"]),
    reach_step(["b-2", "c-1", "d-2"]),
    reach_step(["r-1", "s-1", "ghost", "t-3", "d-5", "d-1"]),
    # a far property edit
    batch([_update("d-1", p=None)], record_dirty=True, expand=True),
    # a middle relationship deleted
    batch(
        [{"kind": "delete_relationship", "id": "s-1"}],
        record_dirty=True,
        expand=True,
    ),
    # a middle element deleted, its relationships with it
    batch(
        [{"kind": "delete_element", "id": "c-2"}],
        record_dirty=True,
        expand=True,
    ),
    reach_step(["c-2", "s-2", "t-3", "d-3", "d-2"]),
    # a create that links two paths
    batch([_rel("s-3", "S", "c-3", "b-3")], record_dirty=True, expand=True),
    reach_step(["d-5"]),
    # an owner outside the applies types loses its edge, another owner gains
    # one, and a far edit on a path whose middle is gone
    batch(
        [
            {"kind": "delete_relationship", "id": "r-4"},
            _rel("r-7", "R", "a-2", "b-3"),
            _update("d-3", p=None),
        ],
        record_dirty=True,
        expand=True,
    ),
]


@scenario("rules_reach")
def rules_reach() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
