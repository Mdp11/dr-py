"""Write the Python oracle's export of the gate's table over model M.

Loads ``benchmarks/large.model.json`` against its metamodel the way
``scripts/table_large.py`` does, calls ``POST /tables/export`` — the real
``routes/tables.py::export_table`` — on a bare ``Session`` over M for each of
the gate's two flat-file formats, with the table definition
(``engine/bench/big-table.json``) inline, reusing the golden recorder's
``_ArtifactDb`` (there are no artifacts to fetch: the definition travels
inline, so the fake db is never asked for one). The clock is pinned to the
date the engine side uses (``EXPORT_DATE`` in ``engine/bench/parity-large.ts``),
the way the golden recorder pins ``table_export_engine``'s.

``benchmarks/large.export.csv`` and ``benchmarks/large.export.json`` receive
the route's raw response bytes, in csv and in json (the gate's two export
formats); ``benchmarks/large.export.meta.json`` receives what the bytes
cannot say, by format: ``{"filename", "content_type", "truncated"}``.
``engine/bench/parity-large.ts`` runs ``exportTable`` over the same
(pre-violation) model for both formats and compares the two, byte for byte.

Run from the repo root (``pixi run engine-parity-large`` does, through the
``engine-export-oracle`` task):

    pixi run -e core-dev python scripts/export_large.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from unittest import mock
from urllib.parse import unquote

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from data_rover.api import table_export_engine  # noqa: E402
from data_rover.api.deps import Session  # noqa: E402
from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.routes import tables as table_routes  # noqa: E402
from data_rover.api.schemas import ExportTableIn  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.api.settings import Settings  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402

from tests.golden.model_steps import _ArtifactDb, _clock  # noqa: E402

BENCHMARKS = REPO_ROOT / "benchmarks"
ENGINE_BENCH = REPO_ROOT / "engine" / "bench"

#: the date the engine side pins (``EXPORT_DATE`` in
#: ``engine/bench/parity-large.ts``).
EXPORT_DATE = "20240229"

#: the gate's two export formats — xlsx and jsonl are exercised elsewhere
#: (the golden fixtures); this oracle holds the two the engine ships as a
#: single flat file, byte for byte, at scale.
FORMATS = ("csv", "json")


def _filename(disposition: str) -> str:
    """The attachment filename, decoded from ``filename*`` when the route
    sent one (mirrors ``tests.golden.model_steps._shipped``)."""
    head, star, encoded = disposition.partition("; filename*=UTF-8''")
    prefix = 'attachment; filename="'
    assert head.startswith(prefix) and head.endswith('"'), disposition
    return unquote(encoded, errors="strict") if star else head[len(prefix) : -1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, default=BENCHMARKS / "large.model.json")
    parser.add_argument(
        "--metamodel",
        type=Path,
        default=REPO_ROOT / "examples" / "smart-city.metamodel.yaml",
    )
    parser.add_argument("--table", type=Path, default=ENGINE_BENCH / "big-table.json")
    parser.add_argument("--out-dir", type=Path, default=BENCHMARKS)
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(
            f"{args.model} is missing: examples/generate_large_model.py writes it "
            "(--scale 170 for model M)"
        )
    metamodel = load_metamodel_file(args.metamodel)
    doc = parse_model_json(args.model.read_bytes())
    model = build_model_from_dicts(metamodel, doc, strict=False)
    session = Session(metamodel=metamodel, model=model)
    db: Any = _ArtifactDb({})

    definition = json.loads(args.table.read_text(encoding="utf-8"))
    meta: dict[str, dict[str, Any]] = {}
    for fmt in FORMATS:
        payload = ExportTableIn.model_validate(
            {"definition": definition, "format": fmt}
        )
        with mock.patch.object(table_export_engine, "datetime", _clock(EXPORT_DATE)):
            response = table_routes.export_table(
                payload,
                project_id="p",
                session=session,
                db=db,
                runner=None,
                settings=Settings(),
            )
        assert response.status_code == 200, (fmt, response.status_code, response.body)
        blob = bytes(response.body)
        out = args.out_dir / f"large.export.{fmt}"
        out.write_bytes(blob)
        meta[fmt] = {
            "filename": _filename(response.headers["content-disposition"]),
            "content_type": response.headers["content-type"],
            "truncated": response.headers.get("x-table-truncated") == "true",
        }
        print(
            f"wrote {out}: {len(blob):,} bytes ({meta[fmt]['content_type']}, "
            f"truncated={meta[fmt]['truncated']})"
        )

    meta_path = args.out_dir / "large.export.meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {meta_path}")


if __name__ == "__main__":
    main()
