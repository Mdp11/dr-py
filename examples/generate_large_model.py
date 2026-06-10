"""Generate large smart-city model fixtures for benchmarking.

Reuses the deterministic `build_model` from `generate_smart_city_model` with a
configurable scale factor. Scale 1 is the ~1000-element reference model; scale
~170 yields an 80MB-class fixture (~170k elements / ~127k relationships) and
scale ~500 a 250MB-class one. Output is compact JSON (no indentation) and
conforms to `examples/smart-city.metamodel.yaml`.

Run from the repo root:

    pixi run -e core-dev python examples/generate_large_model.py \\
        --scale 170 --out benchmarks/large.model.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_smart_city_model import build_model  # noqa: E402


def write_model(scale: int, out: Path) -> dict[str, int]:
    """Generate a scale-N model and write it to `out`; returns size stats."""
    data = build_model(scale=scale)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(data, separators=(",", ":")),
        encoding="utf-8",
    )
    return {
        "elements": len(data["elements"]),
        "relationships": len(data["relationships"]),
        "bytes": out.stat().st_size,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--scale",
        type=int,
        required=True,
        help="entity-count multiplier (1 ~= 1000 elements / 746 relationships)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="output path for the model JSON file",
    )
    args = parser.parse_args()

    stats = write_model(args.scale, args.out)
    print(
        f"wrote {args.out}: {stats['elements']} elements, "
        f"{stats['relationships']} relationships, "
        f"{stats['bytes'] / 1_048_576:.1f} MiB"
    )


if __name__ == "__main__":
    main()
