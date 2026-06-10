"""Benchmark core Model operations against a model fixture.

Times load/build, full validation, random mutations, neighborhood traversal,
and serialization on a model JSON file (see `examples/generate_large_model.py`
for producing fixtures).

Run from the repo root:

    pixi run -e core-dev python scripts/bench.py \\
        --model benchmarks/large.model.json \\
        --metamodel examples/smart-city.metamodel.yaml
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from data_rover.api.routes._snapshot import _build_model_from_payload  # noqa: E402
from data_rover.api.schemas import ElementOut, RelationshipOut  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402
from data_rover.core.model.model import Model  # noqa: E402
from data_rover.core.validation.dirty import DirtyCollector  # noqa: E402
from data_rover.core.validation.pipeline import default_pipeline  # noqa: E402
from data_rover.core.validation.scope import Scope  # noqa: E402
from data_rover.core.validation.state import ValidationState  # noqa: E402

SEED = 20260610
MUTATION_COUNT = 100
TRAVERSAL_SEEDS = 10
TRAVERSAL_HOPS = 2


def _report(label: str, seconds: float, detail: str = "") -> None:
    suffix = f"  ({detail})" if detail else ""
    print(f"  {label:<58s} {seconds:9.3f} s{suffix}")


def bench_load(model_path: Path, metamodel_path: Path) -> Model:
    """(1) json.load + payload parsing + Model construction (API code path)."""
    metamodel = load_metamodel_file(metamodel_path)

    t0 = time.perf_counter()
    with model_path.open(encoding="utf-8") as f:
        raw = json.load(f)
    t_parse = time.perf_counter() - t0

    t0 = time.perf_counter()
    elements = [ElementOut.model_validate(e) for e in raw.get("elements", [])]
    relationships = [
        RelationshipOut.model_validate(r) for r in raw.get("relationships", [])
    ]
    model = _build_model_from_payload(metamodel, elements, relationships)
    t_build = time.perf_counter() - t0

    _report("(1a) json.load", t_parse)
    _report("(1b) payload parse + _build_model_from_payload", t_build)
    _report("(1)  load + build total", t_parse + t_build)
    return model


def bench_validation(model: Model, limit_seconds: float) -> list:
    """(2) full validation via default_pipeline over Scope.all()."""
    t0 = time.perf_counter()
    issues = default_pipeline().validate(model, Scope.all())
    elapsed = time.perf_counter() - t0
    _report("(2)  full validation (default_pipeline, Scope.all())", elapsed,
            f"{len(issues)} issues")
    if elapsed > limit_seconds:
        print(
            f"  warning: validation took {elapsed:.1f}s, exceeding "
            f"--limit-validation-seconds={limit_seconds:.0f}"
        )
    return issues


def bench_mutations(
    model: Model, rng: random.Random, base_issues: list | None
) -> None:
    """(3) random single mutations through the Model mutation boundary.

    (3a) times the raw mutation; (3b) times the Phase-B incremental
    validation loop per mutation: dirty-set collection + scoped validation +
    ValidationState.replace (requires the full-validation issues from step 2
    as the baseline, so it is skipped under --skip-validation).
    """
    element_ids = list(model.elements)
    targets = [rng.choice(element_ids) for _ in range(MUTATION_COUNT)]
    t0 = time.perf_counter()
    for n, element_id in enumerate(targets):
        element = model.get_element(element_id)
        # `name` is defined on the NamedElement root, so it exists everywhere.
        model.set_property(element, "name", f"bench-mutated-{n:04d}")
    elapsed = time.perf_counter() - t0
    _report(
        f"(3a) {MUTATION_COUNT} random set_property mutations",
        elapsed,
        f"{elapsed / MUTATION_COUNT * 1000:.3f} ms/mutation",
    )

    if base_issues is None:
        print("  (3b) mutate + scoped revalidate: skipped (--skip-validation)")
        return
    pipeline = default_pipeline()
    state = ValidationState()
    state.set_full(base_issues)
    targets = [rng.choice(element_ids) for _ in range(MUTATION_COUNT)]
    t0 = time.perf_counter()
    for n, element_id in enumerate(targets):
        element = model.get_element(element_id)
        collector = DirtyCollector()
        collector.before_element_props_change(model, element_id)
        model.set_property(element, "name", f"bench-scoped-{n:04d}")
        collector.after_element_props_change(model, element_id)
        issues = pipeline.validate(model, collector.to_scope())
        state.replace(collector.ids, issues)
    elapsed = time.perf_counter() - t0
    _report(
        f"(3b) {MUTATION_COUNT} x (mutate + dirty + scoped validate + replace)",
        elapsed,
        f"{elapsed / MUTATION_COUNT * 1000:.3f} ms/op",
    )


def bench_traversal(model: Model, rng: random.Random) -> None:
    """(4) 2-hop neighborhood expansion from random seed elements."""
    element_ids = list(model.elements)
    seeds = [rng.choice(element_ids) for _ in range(TRAVERSAL_SEEDS)]
    t0 = time.perf_counter()
    visited_total = 0
    for seed in seeds:
        visited = {seed}
        frontier = {seed}
        for _ in range(TRAVERSAL_HOPS):
            next_frontier: set[str] = set()
            for element_id in frontier:
                for r in model.relationships_from(element_id):
                    next_frontier.add(r.target_id)
                for r in model.relationships_to(element_id):
                    next_frontier.add(r.source_id)
            frontier = next_frontier - visited
            visited |= frontier
        visited_total += len(visited)
    elapsed = time.perf_counter() - t0
    _report(
        f"(4)  {TRAVERSAL_HOPS}-hop traversal from {TRAVERSAL_SEEDS} elements",
        elapsed,
        f"{visited_total} elements visited",
    )


def bench_serialize(model: Model) -> None:
    """(5) serialize the model back to JSON and write it to a temp file."""
    t0 = time.perf_counter()
    data = {
        "rev": 1,
        "elements": [
            {"id": e.id, "type_name": e.type_name, "properties": e.properties, "rev": e.rev}
            for e in model.elements.values()
        ],
        "relationships": [
            {
                "id": r.id,
                "type_name": r.type_name,
                "source_id": r.source_id,
                "target_id": r.target_id,
                "properties": r.properties,
                "rev": r.rev,
            }
            for r in model.relationships.values()
        ],
    }
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".model.json", delete=False, encoding="utf-8"
    ) as f:
        json.dump(data, f, separators=(",", ":"))
        tmp_path = Path(f.name)
    elapsed = time.perf_counter() - t0
    size_mib = tmp_path.stat().st_size / 1_048_576
    tmp_path.unlink()
    _report("(5)  serialize model + write temp file", elapsed, f"{size_mib:.1f} MiB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, required=True, help="model JSON file")
    parser.add_argument(
        "--metamodel", type=Path, required=True, help="metamodel YAML file"
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="skip step (2), full validation",
    )
    parser.add_argument(
        "--limit-validation-seconds",
        type=float,
        default=120.0,
        help="advisory budget for step (2); a warning is printed when exceeded",
    )
    args = parser.parse_args()

    size_mib = args.model.stat().st_size / 1_048_576
    print(f"model file: {args.model} ({size_mib:.1f} MiB)")

    model = bench_load(args.model, args.metamodel)
    print(
        f"model: {len(model.elements)} elements, "
        f"{len(model.relationships)} relationships"
    )

    base_issues: list | None = None
    if args.skip_validation:
        print("  (2)  full validation: skipped (--skip-validation)")
    else:
        base_issues = bench_validation(model, args.limit_validation_seconds)

    rng = random.Random(SEED)
    bench_mutations(model, rng, base_issues)
    bench_traversal(model, rng)
    bench_serialize(model)


if __name__ == "__main__":
    main()
