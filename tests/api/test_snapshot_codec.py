"""The snapshot blob format: gzip of the compact document on the way out,
bytes-sniffing (never key-sniffing) on the way in."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import iter_model_json, iter_model_json_compact
from data_rover.api.snapshot_codec import decode_snapshot, encode_snapshot, is_gzip
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model

MM_YAML = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL_JSON = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def _example_model() -> Model:
    return build_model_from_dicts(load_metamodel_str(MM_YAML), json.loads(MODEL_JSON))


def _document(model: Model) -> dict:
    return json.loads("".join(iter_model_json(model)))


def test_encode_is_a_gzip_member_of_the_compact_document() -> None:
    model = _example_model()
    blob = b"".join(encode_snapshot(model))
    assert is_gzip(blob)
    assert gzip.decompress(blob).decode("utf-8") == "".join(
        iter_model_json_compact(model)
    )


def test_encode_decode_roundtrip() -> None:
    model = _example_model()
    assert decode_snapshot(b"".join(encode_snapshot(model))) == _document(model)


def test_decode_accepts_plain_indented_json_bytes() -> None:
    """Rows written before compression hold the indented save-file text."""
    model = _example_model()
    plain = "".join(iter_model_json(model)).encode("utf-8")
    assert not is_gzip(plain)
    assert decode_snapshot(plain) == _document(model)


def test_decode_accepts_plain_compact_json_bytes() -> None:
    plain = b'{"elements":[],"relationships":[]}'
    assert decode_snapshot(plain) == {"elements": [], "relationships": []}


def test_encode_empty_model() -> None:
    blob = b"".join(encode_snapshot(Model(load_metamodel_str(MM_YAML))))
    assert is_gzip(blob)
    assert decode_snapshot(blob) == {"elements": [], "relationships": []}


def test_encode_streams_a_large_model_in_several_chunks() -> None:
    mm = load_metamodel_str(MM_YAML)
    model = Model(mm)
    et = next(t.name for t in mm.elements if not t.abstract)
    for i in range(30_000):
        model.elements[f"e{i}"] = Element(
            id=f"e{i}", type_name=et, properties={"name": "x" * 60, "i": i}, rev=0
        )
    model.indexes.rebuild()
    chunks = list(encode_snapshot(model))
    assert len(chunks) >= 3  # >2 MiB of text at 1 MiB per compress() call + flush
    assert len(decode_snapshot(b"".join(chunks))["elements"]) == 30_000


def test_is_gzip_on_short_input() -> None:
    assert is_gzip(b"") is False
    assert is_gzip(b"\x1f") is False
    assert is_gzip(b"\x1f\x8b") is True
