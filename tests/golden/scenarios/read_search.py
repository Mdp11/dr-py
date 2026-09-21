"""Fuzzy search as ``GET /model/elements?q=`` ranks it: the four name tiers,
the length bias, id, type and property signals, Unicode lowering and
stripping, tie-breaks by code point and paging — before and after churn."""

from __future__ import annotations

import copy
from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, read_step, run_steps, set_property
from .read_pages import METAMODEL as _PAGES_METAMODEL

_METAMODEL = copy.deepcopy(_PAGES_METAMODEL)
_METAMODEL["elements"][0]["properties"].append({"name": "Name", "datatype": "string"})

#: id-1 .. id-21, by properties; the leaves are marked
_ELEMENTS: list[dict[str, Any]] = [
    {"name": "some_name"},  # exact
    {"name": "some_name_x"},  # prefix
    {"name": "left some_name right"},  # word boundary inside
    {"name": "a_some_name"},  # word boundary at the end
    {"name": "pretextsome_name"},  # substring
    {"name": "ab"},  # the length bias, against
    {"name": "abc"},
    {"_leaf": True, "name": "leafy thing"},  # type and name
    {"_leaf": True, "name": "other"},  # type alone
    {"name": "unrelated", "note": "has some_name inside", "peer": "some_name-ref"},
    {"name": "unrelated two", "Name": "some_name"},  # `Name` is no weak signal
    {"Name": "some_name"},  # but the name when `name` is missing
    {"name": ["", "some_name"]},  # a list's first non-empty entry
    {"name": "nothing here"},
    {"name": "İstanbul"},  # lowers one code point longer
    {"name": "ΟΔΟΣ"},  # a final sigma
    {"name": "Kelvin"},  # the Kelvin sign lowers to `k`
    {"name": "5K"},
    {"name": "-K-"},
    {"name": "Ksome_name"},  # `k` before it: no boundary once lowered
    {"name": "some_name\U0001f600"},  # an astral character counts once
]


def _create(i: int, spec: dict[str, Any]) -> dict[str, Any]:
    properties = {key: value for key, value in spec.items() if key != "_leaf"}
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{i}",
        "type_name": "Leaf" if spec.get("_leaf") else "Node",
        "properties": properties,
    }


def _restored(element_id: str, name: str | None) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = [
        {"do": "restore_element", "id": element_id, "type": "Node"}
    ]
    if name is not None:
        steps.append(set_property(element_id, "name", name))
    return steps


_QUERIES = [
    "some_name", "SOME_NAME", "\x1fsome_name\x85", "﻿some_name", "ab", "leaf",
    "i̇s", "οδος", "ΟΔΟΣ", "k", "tie", "",
    "  \t", "nothing at all",
]  # fmt: skip


def _reads() -> list[dict[str, Any]]:
    return [
        *[read_step("listElementsPage", q=q) for q in _QUERIES],
        *[
            read_step("listElementsPage", q="id-", limit=2, offset=o)
            for o in (0, 2, 99)
        ],
        read_step("listElementsPage", q="id-", limit=5, offset=9),
        read_step("listElementsPage", q="leaf", type="Leaf"),
        read_step("listElementsPage", q="some_name", type="Node", limit=3, offset=1),
    ]


_STEPS: list[dict[str, Any]] = [
    batch([_create(i, spec) for i, spec in enumerate(_ELEMENTS, start=1)]),
    # ids that match on their own, and ties that sort by code point
    *_restored("some_name", None),
    *_restored("x-some_name-y", None),
    *_restored("", "tie"),
    *_restored("\U00010000", "tie"),
    *_restored("", "tie"),
    *_reads(),
    batch(
        [
            {
                "kind": "update_element",
                "id": "id-1",
                "properties_patch": {"name": "renamed"},
            },
            {"kind": "delete_element", "id": "id-2"},
        ]
    ),
    *_reads(),
]


@scenario("read_search")
def read_search() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
