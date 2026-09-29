"""Write the Python oracle's compare and apply-CR over model M.

Loads ``benchmarks/large.model.json`` as ``scripts/download_large.py`` does and
derives from its raw document, deterministically, a second model file — every
50th element renamed, every 97th with a property removed, every 200th leaf
element (one that is no relationship's source) deleted with its relationships,
every 300th remaining relationship deleted, and 500 new elements with 200 new
relationships among them — written to ``benchmarks/large.compare.model.json``.
The compare route function then answers for that file over a session holding
M, with the clock pinned to ``2026-01-01T00:00:00.000Z``, and the answer goes to
``benchmarks/large.compare.json``; the apply-CR route function answers for
``[that answer's cr]``, written to ``benchmarks/large.apply-cr.json``.
``engine/bench/parity-large.ts`` holds the engine's compare and apply-CR to
both, and ``frontend/bench/main.ts`` feeds the file to the browser.

Run from the repo root (``pixi run engine-parity-large`` does, through the
``engine-compare-oracle`` task):

    pixi run -e core-dev python scripts/compare_large.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any
from unittest import mock

from fastapi.responses import JSONResponse
from starlette.requests import Request
from starlette.types import Message

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from data_rover.api.routes import change_request as cr_routes  # noqa: E402
from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.schemas import ProposeCrRequest  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.api.session import Session  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402

BENCHMARKS = REPO_ROOT / "benchmarks"

CREATED_AT = "2026-01-01T00:00:00.000Z"
NEW_ELEMENTS = 500
NEW_RELATIONSHIPS = 200

Doc = dict[str, Any]


def derive(doc: Doc) -> Doc:
    """The other file: ``doc`` with the edits of the module docstring."""
    elements: list[Doc] = doc["elements"]
    relationships: list[Doc] = doc["relationships"]
    sources = {r["source_id"] for r in relationships}
    deleted: set[str] = set()
    leaves = 0
    out_elements: list[Doc] = []
    for i, element in enumerate(elements, start=1):
        if element["id"] not in sources:
            leaves += 1
            if leaves % 200 == 0:
                deleted.add(element["id"])
                continue
        element = {**element, "properties": dict(element["properties"])}
        if i % 50 == 0:
            element["properties"]["name"] = f"{element['properties']['name']} (renamed)"
        if i % 97 == 0:
            element["properties"].pop("description", None)
        out_elements.append(element)
    out_relationships: list[Doc] = []
    kept = 0
    for rel in relationships:
        if rel["source_id"] in deleted or rel["target_id"] in deleted:
            continue
        kept += 1
        if kept % 300 == 0:
            continue
        out_relationships.append(rel)

    template = next(
        e for e in elements if e["type_name"] == "Service" and e["id"] not in deleted
    )
    connects = next(r for r in relationships if r["type_name"] == "ConnectsTo")
    created: list[str] = []
    for n in range(1, NEW_ELEMENTS + 1):
        new = f"c_{n:06d}"
        created.append(new)
        properties = {**template["properties"], "name": f"Compared service {n}"}
        out_elements.append(
            {"id": new, "type_name": "Service", "properties": properties, "rev": 0}
        )
    for n in range(1, NEW_RELATIONSHIPS + 1):
        out_relationships.append(
            {
                "id": f"d_{n:06d}",
                "type_name": "ConnectsTo",
                "source_id": created[n - 1],
                "target_id": created[n],
                "properties": dict(connects["properties"]),
                "rev": 0,
            }
        )
    return {
        "rev": doc.get("rev", 1),
        "elements": out_elements,
        "relationships": out_relationships,
    }


def compare(session: Session, body: bytes) -> Doc:
    """The compare route over ``body``, sent as the one chunk of a request
    that carries nothing else."""

    async def receive() -> Message:
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request({"type": "http", "method": "POST", "headers": []}, receive)
    answer = asyncio.run(cr_routes.compare_model(request, session=session))
    return answer.model_dump(mode="json")


def propose(session: Session, crs: list[Doc]) -> Doc:
    answer = cr_routes.propose_cr(
        ProposeCrRequest.model_validate({"crs": crs}), session=session
    )
    if isinstance(answer, JSONResponse):
        raise SystemExit(f"the apply-CR route refused its own compare: {answer.body!r}")
    return answer.model_dump(mode="json")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, default=BENCHMARKS / "large.model.json")
    parser.add_argument(
        "--metamodel",
        type=Path,
        default=REPO_ROOT / "examples" / "smart-city.metamodel.yaml",
    )
    parser.add_argument(
        "--file", type=Path, default=BENCHMARKS / "large.compare.model.json"
    )
    parser.add_argument(
        "--compare", type=Path, default=BENCHMARKS / "large.compare.json"
    )
    parser.add_argument(
        "--apply-cr", type=Path, default=BENCHMARKS / "large.apply-cr.json"
    )
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(
            f"{args.model} is missing: examples/generate_large_model.py writes it "
            "(--scale 170 for model M)"
        )
    metamodel = load_metamodel_file(args.metamodel)
    doc = parse_model_json(args.model.read_bytes())
    other = derive(doc)
    blob = json.dumps(other, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    args.file.write_bytes(blob)

    model = build_model_from_dicts(metamodel, doc, strict=False)
    session = Session(metamodel=metamodel, model=model, model_rev=doc["rev"])
    with mock.patch.object(cr_routes, "_now_iso", lambda: CREATED_AT):
        answer = compare(session, blob)
        args.compare.write_text(
            json.dumps(answer, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        applied = propose(session, [answer["cr"]])
    args.apply_cr.write_text(
        json.dumps(applied, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    counts = {
        f"{kind}.{how}": len(entries)
        for kind, hows in answer["cr"]["ops"].items()
        for how, entries in hows.items()
    }
    print(
        f"wrote {args.file}: {len(blob):,} bytes; {args.compare}: "
        f"{args.compare.stat().st_size:,} bytes; {args.apply_cr}: "
        f"{args.apply_cr.stat().st_size:,} bytes ({len(applied['ops']):,} ops)"
    )
    print(
        f"  other file: {answer['other_element_count']:,} elements, "
        f"{answer['other_relationship_count']:,} relationships"
    )
    for name, n in counts.items():
        print(f"  {name}: {n:,}")


if __name__ == "__main__":
    main()
