"""Write the script parity corpus's model as the snapshot the browser run opens.

The model is the one ``engine/fixtures/golden/script_parity.json`` was built
over, as ``datarover.snapshot/v2`` gzip bytes next to its metamodel, in
``benchmarks/`` (git-ignored). Its ids are ordered so that code-point order
differs from UTF-16 order. The lines are checked against the committed
fixture, so a changed fixture stops here instead of failing every case.

    pixi run engine-scripts-snapshot
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from data_rover.api.serialize import iter_entity_lines  # noqa: E402
from data_rover.api.snapshot_codec import encode_snapshot_v2  # noqa: E402
from data_rover.core.metamodel.schema import Metamodel  # noqa: E402
from data_rover.core.model.model import Model  # noqa: E402

FIXTURE = REPO_ROOT / "engine" / "fixtures" / "golden" / "script_parity.json"
OUT = REPO_ROOT / "benchmarks" / "script-corpus.snapshot.v2.gz"

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

ASTRAL = "\U0001f600"
_BMP_MAX = "\uffff"

#: (id, type, properties), in insertion order
ELEMENTS: list[tuple[str, str, dict[str, Any]]] = [
    ("n1", "Node", {"name": "one"}),
    ("n2", "Node", {"name": "two"}),
    ("l1", "Leaf", {"name": ["", "listed", "second"]}),
    ("o1", "Other", {}),
    (f"z{ASTRAL}", "Node", {"Name": "Upper"}),
    (
        "é1",
        "Node",
        {"name": "é", "note": {"z": 1, "a": {"y": 2, "b": [3, 1.5]}}, "list": [1, "x"]},
    ),
    ("n3", "Node", {"name": "three", "f": 1.0, "i": 1, "big": 2**60, "s": ASTRAL}),
]

#: (id, type, source, target, properties)
RELATIONSHIPS: list[tuple[str, str, str, str, dict[str, Any]]] = [
    ("r1", "Owns", "n1", "n2", {}),
    ("r2", "Owns", "n1", "l1", {}),
    ("r3", "Owns", "n1", "n2", {}),
    ("r4", "Links", "n2", "n1", {"name": "back"}),
    (f"{_BMP_MAX}r5", "Links", "n1", "o1", {}),
    (f"{ASTRAL}r6", "Links", "n1", f"z{ASTRAL}", {}),
]


def build_model() -> Model:
    model = Model(Metamodel.model_validate(METAMODEL))
    for eid, type_name, properties in ELEMENTS:
        model.insert_element(eid, type_name, properties, 0)
    for rid, type_name, source, target, properties in RELATIONSHIPS:
        model.insert_relationship(rid, type_name, source, target, properties, 0)
    return model


def main() -> None:
    model = build_model()
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))["model"]
    lines = list(iter_entity_lines(model))
    if (
        lines[: len(ELEMENTS)] != fixture["elements"]
        or lines[len(ELEMENTS) :] != fixture["relationships"]
        or model.metamodel.model_dump(mode="json") != fixture["metamodel"]
    ):
        raise SystemExit(f"{FIXTURE} no longer holds this corpus")
    OUT.parent.mkdir(exist_ok=True)
    blob = b"".join(
        encode_snapshot_v2(model, project_id="bench", rev=1, metamodel_id="script-corpus")
    )
    OUT.write_bytes(blob)
    doc = OUT.with_name("script-corpus.metamodel.json")
    doc.write_text(
        json.dumps(model.metamodel.model_dump(mode="json"), ensure_ascii=False), encoding="utf-8"
    )
    print(
        f"wrote {OUT.name}: {len(model.elements)} elements, "
        f"{len(model.relationships)} relationships, {len(blob)} bytes; and {doc.name}"
    )


if __name__ == "__main__":
    main()
