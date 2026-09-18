"""A ``datarover.snapshot/v2`` text as the server encodes it (a header line,
then one line per entity) over values a careless reader would lose, with what
the oracle holds after reading it back."""

from __future__ import annotations

import gzip
from typing import Any

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.snapshot_codec import decode_snapshot, encode_snapshot_v2
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from ..driver import scenario
from ..model_steps import observe

_METAMODEL = {
    "elements": [
        {
            "name": "Item",
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "amount", "datatype": "float"},
                {"name": "peer", "datatype": "Item"},
            ],
        }
    ],
    "relationships": [
        {"name": "Holds", "containment": True, "source": "Item", "target": "Item"},
        {
            "name": "Links",
            "source": "Item",
            "target": "Item",
            "properties": [{"name": "weight", "datatype": "float"}],
        },
    ],
}

_ELEMENTS: list[tuple[str, dict[str, Any], int]] = [
    ("z-last-by-id-first-in-order", {"name": "caf\u00e9 \U0001f600"}, 4),
    ("a", {"amount": 1.0, "name": "whole float"}, 1),
    ("b", {"amount": 1, "name": "whole float"}, 0),
    ("c", {"amount": 2**63 + 1, "peer": "a"}, 12),
    ("d", {"amount": "Infinity", "name": 'line\nbreak \u2028 "quoted" \\ back'}, 2),
    ("e", {"amount": 1e-07, "extra": {"k": [1.5e300, -0.0, None, True]}}, 3),
]
_RELATIONSHIPS: list[tuple[str, str, str, str, dict[str, Any], int]] = [
    ("r2", "Holds", "a", "b", {}, 0),
    ("r1", "Holds", "c", "b", {}, 5),
    ("r3", "Links", "e", "e", {"weight": 0.1}, 1),
]


@scenario("snapshot_v2")
def snapshot_v2() -> Any:
    mm = Metamodel.model_validate(_METAMODEL)
    model = Model(mm)
    for eid, properties, rev in _ELEMENTS:
        model.elements[eid] = Element(eid, "Item", dict(properties), rev)
    for rid, type_name, source, target, properties, rev in _RELATIONSHIPS:
        model.relationships[rid] = Relationship(
            rid, type_name, source, target, dict(properties), rev
        )
    model.indexes.rebuild()
    blob = b"".join(
        encode_snapshot_v2(model, project_id="demo", rev=42, metamodel_id="mm-7")
    )
    reread = build_model_from_dicts(mm, decode_snapshot(blob), strict=False)
    seen = observe(reread)
    assert seen == observe(model), "the oracle's own round trip changed the model"
    return {
        "metamodel": mm.model_dump(mode="json"),
        "text": gzip.decompress(blob).decode("utf-8"),
        **seen,
    }
