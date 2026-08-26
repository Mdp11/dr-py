"""The compact snapshot writer: byte-identical to a whole-document compact
``json.dumps`` while streaming one batch of entities at a time."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import (
    SNAPSHOT_BATCH,
    iter_model_json,
    iter_model_json_compact,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

MM_YAML = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL_JSON = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def _metamodel() -> Metamodel:
    return load_metamodel_str(MM_YAML)


def _example_model() -> Model:
    return build_model_from_dicts(_metamodel(), json.loads(MODEL_JSON))


def _synthetic_model(n_elements: int, n_relationships: int) -> Model:
    """Populate the dicts directly (the bulk-loader pattern) with unicode and
    nested property values, then rebuild the indexes."""
    mm = _metamodel()
    model = Model(mm)
    et = next(t.name for t in mm.elements if not t.abstract)
    rt = mm.relationships[0].name
    for i in range(n_elements):
        eid = f"e{i}"
        model.elements[eid] = Element(
            id=eid,
            type_name=et,
            properties={"name": f"nöde {i}", "k": i, "tags": ["a", {"b": None}]},
            rev=i % 3,
        )
    for i in range(n_relationships):
        rid = f"r{i}"
        model.relationships[rid] = Relationship(
            id=rid,
            type_name=rt,
            source_id=f"e{i}",
            target_id=f"e{(i + 1) % n_elements}",
            properties={},
            rev=0,
        )
    model.indexes.rebuild()
    return model


def _compact_reference(model: Model) -> str:
    doc = json.loads("".join(iter_model_json(model)))
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False)


def test_compact_matches_whole_document_dumps_on_the_example() -> None:
    model = _example_model()
    assert "".join(iter_model_json_compact(model)) == _compact_reference(model)


def test_compact_matches_across_batch_boundaries() -> None:
    # 2 full batches + a partial one on each side, so first/subsequent-batch
    # comma handling and the partial tail are all exercised
    model = _synthetic_model(2 * SNAPSHOT_BATCH + 7, SNAPSHOT_BATCH + 3)
    assert "".join(iter_model_json_compact(model)) == _compact_reference(model)


def test_compact_exactly_one_batch() -> None:
    model = _synthetic_model(SNAPSHOT_BATCH, 0)
    assert "".join(iter_model_json_compact(model)) == _compact_reference(model)


def test_compact_empty_model() -> None:
    text = "".join(iter_model_json_compact(Model(_metamodel())))
    assert text == '{"elements":[],"relationships":[]}'


def test_compact_streams_more_than_one_chunk_per_list() -> None:
    model = _synthetic_model(2 * SNAPSHOT_BATCH + 7, 0)
    chunks = list(iter_model_json_compact(model))
    # "{", '"elements":[', 3 batches, "]", ",", '"relationships":[', "]", "}"
    assert len(chunks) == 10


def test_compact_rejects_nan_like_the_indented_writer() -> None:
    model = _synthetic_model(3, 0)
    model.elements["e0"].properties["bad"] = float("nan")
    with pytest.raises(ValueError):
        "".join(iter_model_json_compact(model))
