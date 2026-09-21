"""The containment tree as the read routes serve it: roots, children, tree
items and the excluded pool of a view — first containment parent wins, a
child counts once, names order by code point — before and after churn."""

from __future__ import annotations

import copy
from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, read_step, run_steps, view_step
from .read_pages import METAMODEL as _PAGES_METAMODEL

_METAMODEL = copy.deepcopy(_PAGES_METAMODEL)
_METAMODEL["relationships"].append(
    {"name": "Holds", "extends": "Owns", "source": "Node", "target": "Node"}
)

#: id-1 .. id-17, by name; `None` leaves the element unnamed
_NAMES: list[Any] = [
    "beta", "Alpha", "alpha", None, "\U00010000", "￿", "", "child b",
    "child a", "shared", "sub", "level1", "level2", "level3", "leaf", ["", "listy"],
    "Beta",
]  # fmt: skip


def _element(i: int, name: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{i}",
        "type_name": "Leaf" if i == 15 else "Node",
        "properties": {} if name is None else {"name": name},
    }


def _rel(kind: str, source: int, target: int) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{source}_{target}",
        "type_name": kind,
        "source_id": f"id-{source}",
        "target_id": f"id-{target}",
    }


#: id-18 ..: 9 has two parents, 1 first; 2 holds 10 twice; 3 holds 11
#: through the subtype; 1 → 12 → 13 → 14 is a chain
_RELATIONSHIPS = [
    [_rel("Owns", 1, 8)],
    [_rel("Owns", 1, 9)],
    [_rel("Owns", 3, 9)],
    [_rel("Owns", 2, 10)],
    [_rel("Owns", 2, 10)],
    [_rel("Holds", 3, 11)],
    [_rel("Owns", 1, 12)],
    [_rel("Owns", 12, 13)],
    [_rel("Owns", 13, 14)],
    [_rel("Owns", 1, 15)],
    [_rel("Links", 1, 2)],
]

_VIEW = [
    {
        "name": "outer",
        "elements": ["id-1"],
        "folders": [{"name": "inner", "elements": ["id-5", "id-8"]}],
    }
]


def _reads() -> list[dict[str, Any]]:
    children = ["id-1", "id-2", "id-3", "id-9", "id-12", "id-13", "id-14", "ghost"]
    return [
        read_step("listContainmentRoots"),
        *[read_step("listContainmentRoots", limit=3, offset=o) for o in (0, 3, 30)],
        *[read_step("listContainmentChildren", id=eid) for eid in children],
        read_step("listContainmentChildren", id="id-1", limit=2, offset=2),
        read_step(
            "getTreeItemsBatch", ids=["id-1", "id-3", "id-1", "ghost", "id-9", "id-12"]
        ),
        read_step("getTreeItemsBatch", ids=["id-2"] * 501),
        read_step("listExcludedRoots"),
        read_step("listExcludedRoots", view_id="nope"),
        view_step("v1", _VIEW),
        read_step("listExcludedRoots", view_id="v1"),
        read_step("listExcludedRoots", view_id="v1", limit=2, offset=1),
        read_step("listExcludedRoots", view_id=""),
        {"do": "drop_view", "view_id": "v1"},
        read_step("listExcludedRoots", view_id="v1"),
    ]


_STEPS: list[dict[str, Any]] = [
    batch([_element(i, name) for i, name in enumerate(_NAMES, start=1)]),
    *[batch(ops) for ops in _RELATIONSHIPS],
    *_reads(),
    # churn: 9 loses its first parent and moves to 3, a root is renamed, a
    # subtree goes, and 9's first edge comes back under its id — last
    batch([{"kind": "delete_relationship", "id": "id-19"}]),
    batch(
        [{"kind": "update_element", "id": "id-2", "properties_patch": {"name": "zeta"}}]
    ),
    batch([{"kind": "delete_element", "id": "id-12"}]),
    {
        "do": "restore_relationship",
        "id": "id-19",
        "type": "Owns",
        "source": "id-1",
        "target": "id-9",
    },
    *_reads(),
]


@scenario("read_tree")
def read_tree() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
