"""Write a model JSON file as the snapshot the engine opens.

Two files land next to each other: ``<out>``, the INFLATED
``datarover.snapshot/v2`` text (inflating is the engine host's job, so the
engine's benchmark starts from these bytes), and ``<out>.metamodel.json``, the
metamodel as ``GET /metamodel`` serves it. With ``--gzip`` a third,
``<out>.gz``, holds the encoder's bytes as they are — what the server stores
and serves, and what the browser benchmark streams.

Run from the repo root (``pixi run engine-bench-data`` does, for model M):

    pixi run -e core-dev python scripts/snapshot_v2.py \\
        --model benchmarks/large.model.json \\
        --metamodel examples/smart-city.metamodel.yaml \\
        --out benchmarks/large.snapshot.v2 --gzip
"""

from __future__ import annotations

import argparse
import json
import sys
import zlib
from contextlib import nullcontext
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.api.snapshot_codec import encode_snapshot_v2  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--metamodel", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rev", type=int, default=1)
    parser.add_argument("--gzip", action="store_true")
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(
            f"{args.model} is missing: examples/generate_large_model.py writes it "
            "(--scale 170 for model M)"
        )
    metamodel = load_metamodel_file(args.metamodel)
    model = build_model_from_dicts(
        metamodel, parse_model_json(args.model.read_bytes()), strict=False
    )
    inflate = zlib.decompressobj(16 + zlib.MAX_WBITS)
    blob = encode_snapshot_v2(
        model, project_id="bench", rev=args.rev, metamodel_id=args.metamodel.name
    )
    gz = args.out.with_name(args.out.name + ".gz")
    size = gz_size = 0
    stored = gz.open("wb") if args.gzip else nullcontext()
    with args.out.open("wb") as out, stored as raw:
        for chunk in blob:
            if raw is not None:
                gz_size += raw.write(chunk)
            size += out.write(inflate.decompress(chunk))
        size += out.write(inflate.flush())
    doc = args.out.with_name(args.out.name + ".metamodel.json")
    doc.write_text(
        json.dumps(metamodel.model_dump(mode="json"), ensure_ascii=False),
        encoding="utf-8",
    )
    print(
        f"wrote {args.out}: {len(model.elements)} elements, "
        f"{len(model.relationships)} relationships, {size / 1_048_576:.1f} MiB; "
        f"and {doc.name}" + (f"; and {gz.name}, {gz_size:,} bytes" if args.gzip else "")
    )


if __name__ == "__main__":
    main()
