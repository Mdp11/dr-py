"""Write the script parity corpus's model as the snapshot the browser run opens.

The model is the one ``engine/fixtures/golden/script_parity.json`` was built
over, as ``datarover.snapshot/v2`` gzip bytes next to its metamodel, in
``benchmarks/`` (git-ignored). The lines are checked against the committed
fixture, so a stale fixture stops here instead of failing every case.

    pixi run engine-scripts-snapshot
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from data_rover.api.serialize import iter_entity_lines  # noqa: E402
from data_rover.api.snapshot_codec import encode_snapshot_v2  # noqa: E402
from tests.golden.scenarios.script_bridge import ELEMENTS, build_model  # noqa: E402

FIXTURE = REPO_ROOT / "engine" / "fixtures" / "golden" / "script_parity.json"
OUT = REPO_ROOT / "benchmarks" / "script-corpus.snapshot.v2.gz"


def main() -> None:
    model = build_model()
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))["model"]
    lines = list(iter_entity_lines(model))
    if (
        lines[: len(ELEMENTS)] != fixture["elements"]
        or lines[len(ELEMENTS) :] != fixture["relationships"]
        or model.metamodel.model_dump(mode="json") != fixture["metamodel"]
    ):
        raise SystemExit(f"{FIXTURE} is stale: run `pixi run golden-fixtures`")
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
