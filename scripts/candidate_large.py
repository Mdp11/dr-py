"""Write the Python oracle's candidate diff at model M, with violations injected.

Takes the smart-city metamodel and edits it four ways, deterministically: one
relationship type becomes a containment, one element type gains a key, one
gains a required property and one required property is dropped. The candidate
document goes to ``benchmarks/large.candidate.metamodel.json`` as
``GET /metamodel`` answers it. Model M, with the violation ops and the custom
rules of ``scripts/issues_large.py`` (its loaders), is validated under the
candidate through ``metamodel_candidate.candidate_issues``, and ``model_half``
diffs that against the swept store's issues, in store order;
``benchmarks/large.candidate.json`` receives the result.
``engine/bench/parity-large.ts`` holds the engine's candidate scan to it.

Run from the repo root (``pixi run engine-candidate-oracle`` does):

    pixi run -e core-dev python scripts/candidate_large.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

from pydantic import TypeAdapter

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from issues_large import (  # noqa: E402
    BENCHMARKS,
    compiled_rules,
    rule_artifacts,
)

from data_rover.api.metamodel_candidate import (  # noqa: E402
    candidate_issues,
    model_half,
)
from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.routes.ops import _apply_batch  # noqa: E402
from data_rover.api.schemas import ModelOpIn  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.api.session import Session  # noqa: E402
from data_rover.api.validation_sweep import start_validation_sweep  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402
from data_rover.core.metamodel.schema import Metamodel, PropertyDef  # noqa: E402
from data_rover.core.validation.state import ValidationState  # noqa: E402

#: the relationship type turned into a containment
CONTAINMENT = "MemberOf"
#: the element type given a key, and its key
KEYED = ("Incident", ["opened_at"])
#: the element type given a required property, and the property
REQUIRED = (
    "Incident",
    PropertyDef(name="postmortem", datatype="string", multiplicity="1"),
)
#: the type and property whose requirement is dropped
DROPPED = ("Microservice", "language")


def derive(metamodel: Metamodel) -> Metamodel:
    """The smart-city metamodel with the four edits."""
    candidate = metamodel.model_copy(deep=True)
    relationship = next(r for r in candidate.relationships if r.name == CONTAINMENT)
    relationship.containment = True
    keyed = next(e for e in candidate.elements if e.name == KEYED[0])
    keyed.key = list(KEYED[1])
    required = next(e for e in candidate.elements if e.name == REQUIRED[0])
    required.properties.append(REQUIRED[1].model_copy())
    dropped = next(e for e in candidate.elements if e.name == DROPPED[0])
    next(p for p in dropped.properties if p.name == DROPPED[1]).multiplicity = "0..1"
    return Metamodel.model_validate(candidate.model_dump(mode="json"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, default=BENCHMARKS / "large.model.json")
    parser.add_argument(
        "--metamodel",
        type=Path,
        default=REPO_ROOT / "examples" / "smart-city.metamodel.yaml",
    )
    parser.add_argument(
        "--ops", type=Path, default=BENCHMARKS / "large.violations.ops.json"
    )
    parser.add_argument(
        "--out-metamodel",
        type=Path,
        default=BENCHMARKS / "large.candidate.metamodel.json",
    )
    parser.add_argument("--out", type=Path, default=BENCHMARKS / "large.candidate.json")
    args = parser.parse_args()

    for path in (args.model, args.ops):
        if not path.exists():
            raise SystemExit(f"{path} is missing: run engine-parity-oracle first")
    metamodel = load_metamodel_file(args.metamodel)
    candidate = derive(metamodel)
    args.out_metamodel.write_text(
        json.dumps(candidate.model_dump(mode="json"), ensure_ascii=False),
        encoding="utf-8",
    )

    doc = parse_model_json(args.model.read_bytes())
    model = build_model_from_dicts(metamodel, doc, strict=False)
    ops = json.loads(args.ops.read_text(encoding="utf-8"))
    _apply_batch(
        model, TypeAdapter(list[ModelOpIn]).validate_python(ops), restore=False
    )
    compiled = compiled_rules(rule_artifacts(), metamodel)
    state = ValidationState()
    session = Session(
        metamodel=metamodel, model=model, validation=state, compiled_rules=compiled
    )
    progress = start_validation_sweep(session, sync=True)
    if progress.error or progress.done != progress.total:
        raise SystemExit("the sweep did not run to its end")
    current = list(state.iter_issues())

    start = time.perf_counter()
    under = candidate_issues(model, candidate, compiled.sources)
    seconds = time.perf_counter() - start
    half = model_half(current, under)
    args.out.write_text(json.dumps(half, ensure_ascii=False), encoding="utf-8")
    print(
        f"wrote {args.out_metamodel} and {args.out}: {len(current):,} current, "
        f"{len(under):,} candidate issues (validated in {seconds:.1f} s); "
        f"{len(half['now_failing']):,} now failing, "
        f"{len(half['now_passing']):,} now passing, "
        f"{half['unchanged_count']:,} unchanged"
    )
    empty = [name for name in ("now_failing", "now_passing") if not half[name]]
    for name in ("now_failing", "now_passing"):
        checks = Counter(f"{i['check']} ({i['category']})" for i in half[name])
        for check, n in sorted(checks.items()):
            print(f"  {name} {check}: {n:,}")
    if empty:
        raise SystemExit(f"{', '.join(empty)} is empty: pick other types")


if __name__ == "__main__":
    main()
