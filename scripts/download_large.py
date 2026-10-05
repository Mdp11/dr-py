"""Write the Python oracle's model download over model M.

Loads ``benchmarks/large.model.json`` against its metamodel and writes
``"".join(iter_model_json(model))`` (the bytes ``GET /model/download`` streams)
to ``benchmarks/large.download.json``, whose size ``pixi run engine-bench-browser``
holds the engine's download to.

    pixi run -e core-dev python scripts/download_large.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.serialize import iter_model_json, parse_model_json  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402

BENCHMARKS = REPO_ROOT / "benchmarks"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, default=BENCHMARKS / "large.model.json")
    parser.add_argument(
        "--metamodel",
        type=Path,
        default=REPO_ROOT / "examples" / "smart-city.metamodel.yaml",
    )
    parser.add_argument("--out", type=Path, default=BENCHMARKS / "large.download.json")
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(
            f"{args.model} is missing: examples/generate_large_model.py writes it "
            "(--scale 170 for model M)"
        )
    metamodel = load_metamodel_file(args.metamodel)
    doc = parse_model_json(args.model.read_bytes())
    model = build_model_from_dicts(metamodel, doc, strict=False)
    blob = "".join(iter_model_json(model)).encode("utf-8")
    args.out.write_bytes(blob)
    print(f"wrote {args.out}: {len(blob):,} bytes")


if __name__ == "__main__":
    main()
