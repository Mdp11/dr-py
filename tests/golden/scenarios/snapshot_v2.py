"""A ``datarover.snapshot/v2`` text as the server encodes it (a header line,
then one line per entity) over values a careless reader would lose, with what
the oracle holds after reading it back.

``same`` lists texts no writer emits that the oracle reads to the same
document; ``refused`` lists texts its decoder refuses in words of its own. A
text it refuses in the JSON parser's words, or accepts by accident, is left
out: the engine's reader answers for those alone."""

from __future__ import annotations

import gzip
import json
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


def _with_header(text: str, **changes: Any) -> str:
    """``text`` with keys of its header line replaced; ``None`` drops a key."""
    first, _, body = text.partition("\n")
    header = json.loads(first)
    for key, value in changes.items():
        if value is None:
            del header[key]
        else:
            header[key] = value
    return json.dumps(header, separators=(",", ":")) + "\n" + body


def _refusal(text: str) -> str:
    try:
        decode_snapshot(text.encode("utf-8"))
    except ValueError as exc:
        assert type(exc) is ValueError, "refused, but not in the decoder's own words"
        return str(exc)
    raise AssertionError("the oracle read a text this scenario expects it to refuse")


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
    text = gzip.decompress(blob).decode("utf-8")
    last_line = text[text.rindex("\n", 0, -1) + 1 :]
    same = {
        "the last line without its LF": text[:-1],
        "CRLF line ends": text.replace("\n", "\r\n"),
    }
    for variant in same.values():
        assert decode_snapshot(variant.encode("utf-8")) == decode_snapshot(blob)
    refused = {
        "no element count": _with_header(text, elements=None),
        "a negative count": _with_header(text, relationships=-1),
        "a boolean count": _with_header(text, elements=True),
        "a float count": _with_header(text, elements=6.0),
        "a text count": _with_header(text, relationships="3"),
        "cut after a line": text[: -len(last_line)],
        "cut inside a line": text[: -len(last_line) // 2 - len(last_line)],
        "a line too many": text + last_line,
        "a second LF at the end": text + "\n",
    }
    return {
        "metamodel": mm.model_dump(mode="json"),
        "text": text,
        **seen,
        "same": [{"name": name, "text": variant} for name, variant in same.items()],
        "refused": [
            {"name": name, "text": variant, "error": _refusal(variant)}
            for name, variant in refused.items()
        ],
    }
