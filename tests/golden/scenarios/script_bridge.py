"""The script bridge's replies: request texts in, ``json.dumps`` reply texts out,
over one model and across limit groups.

Requests and replies travel as text so the engine compares them string for
string. Entities are inserted under fixed ids, ordered so that code-point order
differs from UTF-16 order."""

from __future__ import annotations

import json
from typing import Any
from unittest import mock

from data_rover.api.serialize import iter_entity_lines
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.script import bridge
from data_rover.core.script.bridge import BridgeDispatcher, project_roots

from ..driver import scenario

METAMODEL = {
    "elements": [
        {"name": "Node", "properties": [{"name": "name", "datatype": "string"}]},
        {"name": "Leaf", "extends": "Node"},
        {"name": "Other"},
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Node", "target": "Node"},
        {
            "name": "Links",
            "source": "Node",
            "target": "Node",
            "properties": [{"name": "name", "datatype": "string"}],
        },
    ],
}

_ASTRAL = "\U0001f600"
_BMP_MAX = "\uffff"

#: (id, type, properties), in insertion order
_ELEMENTS: list[tuple[str, str, dict[str, Any]]] = [
    ("n1", "Node", {"name": "one"}),
    ("n2", "Node", {"name": "two"}),
    ("l1", "Leaf", {"name": ["", "listed", "second"]}),
    ("o1", "Other", {}),
    (f"z{_ASTRAL}", "Node", {"Name": "Upper"}),
    (
        "é1",
        "Node",
        {"name": "é", "note": {"z": 1, "a": {"y": 2, "b": [3, 1.5]}}, "list": [1, "x"]},
    ),
    ("n3", "Node", {"name": "three", "f": 1.0, "i": 1, "big": 2**60, "s": _ASTRAL}),
]

#: (id, type, source, target, properties)
_RELATIONSHIPS: list[tuple[str, str, str, str, dict[str, Any]]] = [
    ("r1", "Owns", "n1", "n2", {}),
    ("r2", "Owns", "n1", "l1", {}),
    ("r3", "Owns", "n1", "n2", {}),
    ("r4", "Links", "n2", "n1", {"name": "back"}),
    (f"{_BMP_MAX}r5", "Links", "n1", "o1", {}),
    (f"{_ASTRAL}r6", "Links", "n1", f"z{_ASTRAL}", {}),
]

#: the five write dicts the facade records
_WRITES: list[dict[str, Any]] = [
    {
        "kind": "create_element",
        "temp_id": "tmp_1",
        "type_name": "Node",
        "properties": {"name": "café", "weight": 1.0, "tags": ["a", "é"]},
    },
    {
        "kind": "create_relationship",
        "temp_id": "tmp_2",
        "type_name": "Links",
        "source_id": "n1",
        "target_id": "tmp_1",
        "properties": {},
    },
    {"kind": "update_element", "id": "n1", "properties_patch": {"name": "Renamed"}},
    {"kind": "delete_element", "id": "n2"},
    {"kind": "delete_relationship", "id": "r4"},
]

_ESCAPED_WRITE: dict[str, Any] = {
    "kind": "update_element",
    "id": "é1",
    "properties_patch": {"name": "é"},
}


def _model() -> Model:
    model = Model(Metamodel.model_validate(METAMODEL))
    for eid, type_name, properties in _ELEMENTS:
        model.insert_element(eid, type_name, properties, 0)
    for rid, type_name, source, target, properties in _RELATIONSHIPS:
        model.insert_relationship(rid, type_name, source, target, properties, 0)
    return model


def _req(n: Any, op: Any, **fields: Any) -> str:
    return json.dumps({"id": n, "op": op, **fields})


def _writes(start: int, ops: list[dict[str, Any]]) -> list[str]:
    return [_req(start + i, op) for i, op in enumerate(ops)]


def _reads() -> list[str]:
    texts: list[str] = []

    def add(op: Any, **fields: Any) -> None:
        texts.append(_req(len(texts) + 1, op, **fields))

    for eid in ("n1", "l1", f"z{_ASTRAL}", "é1", "n3", "o1", "nope", "it's", ""):
        add("element", element_id=eid)
    for op in ("outgoing", "incoming"):
        for eid in ("n1", "n2", "l1", "o1", "nope"):
            add(op, element_id=eid)
    for eid in ("n1", "n2", "l1", "nope"):
        add("parent", element_id=eid)
    for eid in ("n1", "l1", "o1", "nope"):
        add("children", element_id=eid)
    for kind, name in (
        ("element", "Node"),
        ("element", "Leaf"),
        ("element", "Other"),
        ("element", "Nope"),
        ("relationship", "Owns"),
        ("relationship", "Links"),
        ("relationship", "Nope"),
        ("bogus", "Node"),
        (None, "Node"),
    ):
        add("descendants", kind=kind, name=name)
    add("descendants", kind="element")
    add("descendants", name="Node")

    for type_value in (
        None,
        ["Node"],
        [],
        "Leaf",
        ["Nope"],
        ["Leaf", "Other"],
        "Other",
    ):
        add("elements_page", type=type_value)
    add("elements_page")
    for limit in (2, 0, -1, 9999, None, "3", 2.9, True):
        add("elements_page", limit=limit)
    for offset in (0, 2, 6, 7, 99, -3, "2", 2.9, None, []):
        add("elements_page", offset=offset)
    add("elements_page", type=["Node"], offset=1, limit=2)
    add("elements_page", limit=[])
    add("elements_page", type=[[]])
    add("elements_page", type=[1])
    add("elements_page", type=5)
    add("elements_page", type={"a": 1})

    texts.append(json.dumps({"op": "element", "element_id": "n1"}))
    texts.append(json.dumps({"id": "s", "op": "element", "element_id": "n2"}))
    texts.append(json.dumps({"id": None, "op": "parent", "element_id": "n2"}))
    texts.append(json.dumps({"id": 1.5, "op": "children", "element_id": "n1"}))
    texts.append(json.dumps({"id": {"k": [1]}, "op": "element", "element_id": "n1"}))
    texts.append('{"id": 90, "op": "element", "element_id": "é1"}')
    for op in ("element", "outgoing", "incoming", "parent", "children", "descendants"):
        add(op)
    add("element", element_id=["x"])
    add("element", element_id={"a": 1})
    add("element", element_id=None)
    add("element", element_id=7)
    add("outgoing", element_id=["x"])
    add("children", element_id=["x"])
    for op in ("bogus", "", None, 5, ["element"], True):
        add(op)
    texts.append(json.dumps({"id": 1}))
    texts.append(_req(len(texts) + 1, _WRITES[0]))
    texts.append(_req(len(texts) + 1, _WRITES[3]))
    texts.append(_req(len(texts) + 1, {}))
    return texts


def _page_walk(page_limit: int = 500, **fields: Any) -> list[str]:
    """Requests that walk every page, following each reply's ``next_offset``."""
    dispatcher = BridgeDispatcher(_model(), record_ops=False, page_limit=page_limit)
    texts: list[str] = []
    offset: Any = 0
    while offset is not None:
        text = _req(len(texts) + 1, "elements_page", offset=offset, **fields)
        texts.append(text)
        offset = dispatcher.dispatch(json.loads(text)).get("next_offset")
    return texts


def _group(
    name: str, requests: list[str], *, record_ops: bool = False, **limits: int
) -> dict[str, Any]:
    dispatcher_limits = {
        k: v for k, v in limits.items() if k != "max_inline_far_endpoints"
    }
    dispatcher = BridgeDispatcher(_model(), record_ops=record_ops, **dispatcher_limits)
    exchanges = [
        {"request": text, "reply": json.dumps(dispatcher.dispatch(json.loads(text)))}
        for text in requests
    ]
    return {
        "name": name,
        "record_ops": record_ops,
        "limits": limits,
        "exchanges": exchanges,
        "ops": [json.dumps(op) for op in dispatcher.ops],
    }


def _far_group(name: str, cap: int, requests: list[str]) -> dict[str, Any]:
    with mock.patch.object(bridge, "_MAX_INLINE_FAR_ENDPOINTS", cap):
        return _group(name, requests, max_inline_far_endpoints=cap)


@scenario("script_bridge")
def script_bridge() -> Any:
    model = _model()
    lines = list(iter_entity_lines(model))
    first = _WRITES[0]
    first_size = len(json.dumps(first))
    both = first_size + len(json.dumps(_ESCAPED_WRITE))
    hub_reads = [
        _req(1, "outgoing", element_id="n1"),
        _req(2, "outgoing", element_id="n2"),
        _req(3, "incoming", element_id="n2"),
        _req(4, "incoming", element_id="n1"),
    ]
    groups = [
        _group("reads", _reads()),
        _group("page_walk", _page_walk(limit=2)),
        _group("page_limit", _page_walk(3), page_limit=3),
        _group(
            "page_limit_clamp",
            [
                _req(1, "elements_page", limit=9999),
                _req(2, "elements_page", limit=2),
                _req(3, "elements_page", type=["Node"], limit=0),
            ],
            page_limit=3,
        ),
        _far_group("far_cap", 2, hub_reads),
        _far_group("far_cap_dedup", 1, hub_reads),
        _far_group("far_cap_edge", 4, hub_reads),
        _group(
            "writes",
            [
                *_writes(1, _WRITES),
                _req(6, "element", element_id="n1"),
                _req(7, "outgoing", element_id="n1"),
                _req(8, {"kind": "anything", "temp_id": None, "note": 1.0}),
                _req(9, {"kind": "delete_element", "id": "é1", "temp_id": 0}),
                _req(10, {}),
            ],
            record_ops=True,
        ),
        _group("op_cap", _writes(1, _WRITES[:3]), record_ops=True, max_ops=2),
        _group(
            "byte_cap",
            _writes(1, [first, _ESCAPED_WRITE]),
            record_ops=True,
            max_op_bytes=first_size + 1,
        ),
        _group(
            "byte_cap_fit",
            _writes(1, [first, _ESCAPED_WRITE]),
            record_ops=True,
            max_op_bytes=both,
        ),
        _group(
            "byte_cap_over",
            _writes(1, [first, _ESCAPED_WRITE, _WRITES[4]]),
            record_ops=True,
            max_op_bytes=both - 1,
        ),
    ]
    roots = [
        {"ids": ids, "projection": json.dumps(project_roots(model, ids))}
        for ids in (
            [],
            ["n1"],
            ["n2", "missing", "n1", "n2"],
            [f"z{_ASTRAL}", "é1", "n3", "o1", "l1"],
        )
    ]
    return {
        "metamodel": model.metamodel.model_dump(mode="json"),
        "elements": lines[: len(_ELEMENTS)],
        "relationships": lines[len(_ELEMENTS) :],
        "groups": groups,
        "roots": roots,
    }
