"""The snapshot codec reproduces the frozen ``snapshot_v2`` fixture: the text
it writes, the digest and state a reader makes of it, the variants it reads to
the same document and the texts it refuses, in its own words."""

from __future__ import annotations

import gzip

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.snapshot_codec import decode_snapshot, encode_snapshot_v2
from data_rover.core.metamodel.schema import Metamodel
from tests.golden.reader import load_fixture, observe


def test_snapshot_v2_matches_the_fixture() -> None:
    doc = load_fixture("snapshot_v2")
    mm = Metamodel.model_validate(doc["metamodel"])
    blob = gzip.compress(doc["text"].encode("utf-8"))
    reread = build_model_from_dicts(mm, decode_snapshot(blob), strict=False)
    seen = observe(reread)
    assert seen == {
        key: doc[key] for key in ("digest", "fingerprint", "state", "indexes")
    }
    written = b"".join(
        encode_snapshot_v2(reread, project_id="demo", rev=42, metamodel_id="mm-7")
    )
    assert gzip.decompress(written).decode("utf-8") == doc["text"]

    assert doc["same"]
    for case in doc["same"]:
        assert decode_snapshot(case["text"].encode("utf-8")) == decode_snapshot(blob), (
            case["name"]
        )
    assert doc["refused"]
    for case in doc["refused"]:
        try:
            decode_snapshot(case["text"].encode("utf-8"))
        except ValueError as exc:
            assert type(exc) is ValueError, case["name"]
            assert str(exc) == case["error"], case["name"]
        else:
            raise AssertionError(f"{case['name']} was read")
