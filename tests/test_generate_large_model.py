"""Tests for the scale-parameterized model generator (`examples/`)."""

import json
import sys
from pathlib import Path

from data_rover.core.metamodel.loader import load_metamodel_file

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = REPO_ROOT / "examples"
sys.path.insert(0, str(EXAMPLES))

from generate_large_model import write_model  # noqa: E402

METAMODEL_PATH = EXAMPLES / "smart-city.metamodel.yaml"


def test_generated_tiny_model_structure(tmp_path):
    out = tmp_path / "tiny.model.json"
    stats = write_model(scale=2, out=out)

    data = json.loads(out.read_text(encoding="utf-8"))
    elements = data["elements"]
    relationships = data["relationships"]

    assert len(elements) == stats["elements"] > 0
    assert len(relationships) == stats["relationships"] > 0

    element_ids = [e["id"] for e in elements]
    relationship_ids = [r["id"] for r in relationships]
    assert len(set(element_ids)) == len(element_ids)
    assert len(set(relationship_ids)) == len(relationship_ids)

    mm = load_metamodel_file(METAMODEL_PATH)
    assert all(mm.element_type(e["type_name"]) is not None for e in elements)
    assert all(
        mm.relationship_type(r["type_name"]) is not None for r in relationships
    )

    # relationship endpoints resolve to generated elements
    ids = set(element_ids)
    assert all(r["source_id"] in ids and r["target_id"] in ids for r in relationships)


def test_scale_multiplies_entity_counts(tmp_path):
    small = write_model(scale=1, out=tmp_path / "s1.model.json")
    large = write_model(scale=2, out=tmp_path / "s2.model.json")

    assert large["elements"] > 1.8 * small["elements"]
    assert large["relationships"] > 1.8 * small["relationships"]


def test_generator_is_deterministic(tmp_path):
    write_model(scale=2, out=tmp_path / "a.model.json")
    write_model(scale=2, out=tmp_path / "b.model.json")
    assert (tmp_path / "a.model.json").read_bytes() == (
        tmp_path / "b.model.json"
    ).read_bytes()
