"""The snapshot blob format: gzip of the compact document on the way out,
bytes-sniffing (never key-sniffing) on the way in."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import (
    iter_entity_lines,
    iter_model_json,
    iter_model_json_compact,
)
from data_rover.api.snapshot_codec import (
    SNAPSHOT_V2_FORMAT,
    decode_snapshot,
    encode_snapshot,
    encode_snapshot_v2,
    is_gzip,
)
from data_rover.api.state_digest import model_digest
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


# --- v2: a header line, then one line per entity ---------------------------


def _v2_blob(model: Model, rev: int = 7) -> bytes:
    return b"".join(
        encode_snapshot_v2(model, project_id="p1", rev=rev, metamodel_id="mm-1")
    )


def _v2_text(model: Model) -> str:
    return gzip.decompress(_v2_blob(model)).decode("utf-8")


def test_v2_is_a_gzip_member_of_a_header_and_entity_lines() -> None:
    model = _example_model()
    assert is_gzip(_v2_blob(model))
    text = _v2_text(model)
    assert text.endswith("\n")
    header, *lines = text.split("\n")[:-1]
    assert header == (
        '{"format":"datarover.snapshot/v2","project_id":"p1","rev":7,'
        '"metamodel_id":"mm-1","elements":1002,"relationships":746,'
        f'"state_digest":"{model_digest(model)}"}}'
    )
    assert json.loads(header)["format"] == SNAPSHOT_V2_FORMAT
    assert lines == list(iter_entity_lines(model))
    assert len(lines) == 1002 + 746


def test_v2_lines_are_the_compact_documents_entities() -> None:
    model = _example_model()
    lines = list(iter_entity_lines(model))
    n = len(model.elements)
    document = (
        '{"elements":['
        + ",".join(lines[:n])
        + '],"relationships":['
        + ",".join(lines[n:])
        + "]}"
    )
    assert document == "".join(iter_model_json_compact(model))


def test_v2_decodes_to_the_v1_document() -> None:
    model = _example_model()
    assert decode_snapshot(_v2_blob(model)) == _document(model)
    # The decoder sniffs the bytes, so an uncompressed v2 text loads too.
    assert decode_snapshot(gzip.decompress(_v2_blob(model))) == _document(model)


def test_v2_roundtrip_rebuilds_the_same_state() -> None:
    model = _example_model()
    rebuilt = build_model_from_dicts(
        load_metamodel_str(MM_YAML), decode_snapshot(_v2_blob(model)), strict=False
    )
    assert list(iter_entity_lines(rebuilt)) == list(iter_entity_lines(model))
    assert model_digest(rebuilt) == model_digest(model)


def test_v2_empty_model_is_a_lone_header() -> None:
    model = Model(load_metamodel_str(MM_YAML))
    assert _v2_text(model) == (
        '{"format":"datarover.snapshot/v2","project_id":"p1","rev":7,'
        '"metamodel_id":"mm-1","elements":0,"relationships":0,'
        '"state_digest":"0000000000000000"}\n'
    )
    assert decode_snapshot(_v2_blob(model)) == {"elements": [], "relationships": []}


def test_v2_keeps_every_value_exact_and_on_one_line() -> None:
    mm = load_metamodel_str(MM_YAML)
    model = Model(mm)
    et = next(t.name for t in mm.elements if not t.abstract)
    properties = {
        "big": 2**63 + 1,
        "whole_float": 1.0,
        "tiny": 1e-07,
        "infinity_token": "Infinity",
        "text": "line one\nline two\r\ttab \u2028 caf\u00e9 \U0001f600",
        "nested": {"b": [1, 1.0, True, None], "a": {}},
    }
    model.elements["e1"] = Element(id="e1", type_name=et, properties=properties, rev=3)
    model.indexes.rebuild()
    text = _v2_text(model)
    assert text.count("\n") == 2  # the header and one entity: no raw LF inside a line
    decoded = decode_snapshot(_v2_blob(model))
    assert decoded["elements"][0]["properties"] == properties
    assert isinstance(decoded["elements"][0]["properties"]["whole_float"], float)
    assert decoded["elements"][0]["rev"] == 3


def test_v2_decode_rejects_a_truncated_blob() -> None:
    text = _v2_text(_example_model())
    cut = text[: text.rindex("\n", 0, len(text) - 1) + 1]  # drop the last entity
    with pytest.raises(ValueError, match="1747 entity lines"):
        decode_snapshot(cut.encode("utf-8"))


def test_v2_decode_rejects_a_header_without_counts() -> None:
    blob = b'{"format":"datarover.snapshot/v2","elements":"1","relationships":0}\n'
    with pytest.raises(ValueError, match="no valid entity counts"):
        decode_snapshot(blob)


def test_v2_header_takes_the_digest_it_is_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = _example_model()

    def _no_full_pass(_: Model) -> str:
        raise AssertionError("a full digest pass")

    monkeypatch.setattr("data_rover.api.snapshot_codec.model_digest", _no_full_pass)
    blob = b"".join(
        encode_snapshot_v2(
            model,
            project_id="p",
            rev=7,
            metamodel_id="mm",
            state_digest="00000000deadbeef",
        )
    )
    header = json.loads(gzip.decompress(blob).partition(b"\n")[0])
    assert header["state_digest"] == "00000000deadbeef"


def test_v2_header_computes_the_digest_when_given_none() -> None:
    model = _example_model()
    blob = b"".join(
        encode_snapshot_v2(
            model, project_id="p", rev=7, metamodel_id="mm", state_digest=None
        )
    )
    header = json.loads(gzip.decompress(blob).partition(b"\n")[0])
    assert header["state_digest"] == model_digest(model)
