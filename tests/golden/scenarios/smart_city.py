"""The smart-city example, bulk-loaded: its indexes, digest and state.

The model file is an input both sides read from ``examples/``; the fixture
holds what the oracle makes of it. The state is 1,748 lines, so it travels as
the fingerprint alone."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import parse_model_json
from data_rover.core.metamodel.loader import load_metamodel_str

from ..driver import scenario
from ..model_steps import observe

_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


@scenario("smart_city")
def smart_city() -> Any:
    mm = load_metamodel_str(
        (_EXAMPLES / "smart-city.metamodel.yaml").read_text(encoding="utf-8")
    )
    raw = parse_model_json((_EXAMPLES / "smart-city.model.json").read_bytes())
    model = build_model_from_dicts(mm, raw, strict=False)
    seen = observe(model)
    return {
        "metamodel": mm.model_dump(mode="json"),
        "model_file": "examples/smart-city.model.json",
        "elements": len(model.elements),
        "relationships": len(model.relationships),
        "digest": seen["digest"],
        "fingerprint": seen["fingerprint"],
        "indexes": seen["indexes"],
    }
