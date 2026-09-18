"""The bulk loader, lenient about types and strict about structure: what
``build_model_from_dicts(strict=False)`` accepts, and the text of every refusal.

Entities travel as JSON text lines, as a snapshot holds them, so that the
engine reads them with its own parser (``1.0`` must stay a float to be refused
as a ``rev``)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import parse_model_json
from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import observe

_METAMODEL = {
    "elements": [
        {
            "name": "Thing",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Box",
            "extends": "Thing",
            "properties": [{"name": "buddy", "datatype": "Box"}],
        },
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Box", "target": "Box"},
        {"name": "Links", "source": "Box", "target": "Box"},
    ],
}

_GOOD_ELEMENTS = [
    '{"id":"b1","type_name":"Box","properties":{"name":"one","buddy":"b2"},"rev":3}',
    '{"id":"b2","type_name":"Box","properties":{"name":"one"},"rev":0,"extra":true}',
    '{"id":"b3","type_name":"Box"}',
    '{"id":"b4","type_name":"Box","properties":null}',
    '{"id":"b5","type_name":"Gone","properties":{"anything":[1,1.0,2e+30,18446744073709551617]}}',
    '{"id":"b6","type_name":"Box","properties":{"__proto__":"p","constructor":"c","name":"six"},"rev":-2}',
    '{"rev":1,"properties":{"name":"one"},"type_name":"Box","id":"b7"}',
]
_GOOD_RELATIONSHIPS = [
    '{"id":"r1","type_name":"Holds","source_id":"b1","target_id":"b2","properties":{},"rev":1}',
    '{"id":"r2","type_name":"Vanished","source_id":"b2","target_id":"b5"}',
    '{"id":"r3","type_name":"Holds","source_id":"b3","target_id":"b2","properties":{"odd":"kept"}}',
    '{"id":"r4","type_name":"Links","source_id":"b7","target_id":"b7","rev":2}',
]

_BOX = '{"id":"b1","type_name":"Box"}'
_BOX2 = '{"id":"b2","type_name":"Box"}'

# (name, element lines, relationship lines)
_REFUSED: list[tuple[str, list[str], list[str]]] = [
    ("element is a list", ["[]"], []),
    ("element is a string", ['"b1"'], []),
    ("element is null", [_BOX, "null"], []),
    ("element id is a number", ['{"id":1,"type_name":"Box"}'], []),
    ("element id is missing", ['{"type_name":"Box"}'], []),
    ("element type_name is null", ['{"id":"b1","type_name":null}'], []),
    ("element id is reserved", ['{"id":"tmp_1","type_name":"Box"}'], []),
    ("reserved id comes before the abstract type", ['{"id":"tmp_1","type_name":"Thing"}'], []),
    ("element type is abstract", ['{"id":"b1","type_name":"Thing"}'], []),
    ("element id is repeated", [_BOX, _BOX2, _BOX], []),
    ("repeated id comes before bad properties", [_BOX, '{"id":"b1","type_name":"Box","properties":[]}'], []),
    ("properties is a list", ['{"id":"b1","type_name":"Box","properties":[]}'], []),
    ("properties is a string", [_BOX, '{"id":"b2","type_name":"Box","properties":"x"}'], []),
    ("bad properties come before a bad rev", ['{"id":"b1","type_name":"Box","properties":1,"rev":"x"}'], []),
    ("rev is a float", ['{"id":"b1","type_name":"Box","rev":1.0}'], []),
    ("rev is a boolean", ['{"id":"b1","type_name":"Box","rev":true}'], []),
    ("rev is a string", ['{"id":"b1","type_name":"Box","rev":"1"}'], []),
    ("rev is null", ['{"id":"b1","type_name":"Box","rev":null}'], []),
    ("relationship is a number", [_BOX], ["7"]),
    ("relationship id is missing", [_BOX], ['{"type_name":"Links","source_id":"b1","target_id":"b1"}']),
    ("relationship source_id is missing", [_BOX], ['{"id":"r1","type_name":"Links","target_id":"b1"}']),
    ("relationship target_id is a list", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":[]}']),
    ("relationship id is reserved", [_BOX], ['{"id":"tmp_r","type_name":"Links","source_id":"b1","target_id":"b1"}']),
    ("relationship source is unknown", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"nope","target_id":"b1"}']),
    ("relationship target is unknown", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":"it\'s"}']),
    ("unknown source comes before a repeated id", [_BOX], [
        '{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b1"}',
        '{"id":"r1","type_name":"Links","source_id":"nope","target_id":"b1"}',
    ]),
    ("relationship id is repeated", [_BOX, _BOX2], [
        '{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b2"}',
        '{"id":"r1","type_name":"Links","source_id":"b2","target_id":"b1"}',
    ]),
    ("relationship rev is a float", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b1","rev":0.0}']),
    ("relationship properties is null then a bad rev", [_BOX], ['{"id":"r1","type_name":"Links","source_id":"b1","target_id":"b1","properties":null,"rev":[]}']),
]  # fmt: skip


def _load(mm: Metamodel, elements: list[str], relationships: list[str]) -> Any:
    raw = {
        "elements": [parse_model_json(line) for line in elements],
        "relationships": [parse_model_json(line) for line in relationships],
    }
    return build_model_from_dicts(mm, raw, strict=False)


@scenario("model_load")
def model_load() -> Any:
    mm = Metamodel.model_validate(_METAMODEL)
    refused = []
    for name, elements, relationships in _REFUSED:
        try:
            _load(mm, elements, relationships)
        except HTTPException as exc:
            refused.append(
                {
                    "name": name,
                    "elements": elements,
                    "relationships": relationships,
                    "error": exc.detail,
                }
            )
        else:
            raise AssertionError(f"the oracle accepted {name!r}")
    accepted = _load(mm, _GOOD_ELEMENTS, _GOOD_RELATIONSHIPS)
    return {
        "metamodel": mm.model_dump(mode="json"),
        "accepted": {
            "elements": _GOOD_ELEMENTS,
            "relationships": _GOOD_RELATIONSHIPS,
            **observe(accepted),
        },
        "refused": refused,
    }
