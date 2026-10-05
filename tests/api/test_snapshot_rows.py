"""A snapshot streamed from the head rows is byte-identical to the one the model
encoder writes, and the descriptor needs no session model."""

from __future__ import annotations

import gzip
import json
import random
from typing import Any

import pytest
from sqlalchemy import delete
from fastapi.testclient import TestClient

from data_rover.api import content, db, head as head_mod
from data_rover.api.db_models import Snapshot
from data_rover.api.main import create_app
from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import iter_entity_lines, parse_model_json
from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry
from data_rover.api.snapshot_codec import decode_snapshot, encode_snapshot_v2
from data_rover.api.snapshot_rows import write_snapshot_from_rows
from data_rover.api.storage import get_snapshot_store
from data_rover.api.storage_gcs import GcsSnapshotStore
from data_rover.core.metamodel.loader import load_metamodel_str
from tests.golden.reader import load_fixture

from .conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    SMART_CITY_MM,
    SMART_CITY_MODEL,
    commit_ops,
    install,
    papi,
    post_commit,
    seed_default_project,
)
from .test_head_rows import _MM, _random_ops


def _stored(rev: int) -> bytes:
    with db.db_session() as s:
        snap = content.get_snapshot(s, DEFAULT_PROJECT_ID, rev)
        assert snap is not None
        key = snap.key
    return gzip.decompress(get_snapshot_store().get(key))


def _model_row() -> tuple[int, str, str]:
    with db.db_session() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None and row.state_digest is not None
        return row.model_rev, row.metamodel_id, row.state_digest


def _expected(metamodel_yaml: str, model_json: str | bytes) -> bytes:
    mm = load_metamodel_str(metamodel_yaml)
    model = build_model_from_dicts(mm, parse_model_json(model_json))
    rev, metamodel_id, digest = _model_row()
    return gzip.decompress(
        b"".join(
            encode_snapshot_v2(
                model,
                project_id=DEFAULT_PROJECT_ID,
                rev=rev,
                metamodel_id=metamodel_id,
                state_digest=digest,
            )
        )
    )


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def test_rows_snapshot_equals_model_encoder_smart_city() -> None:
    seed_default_project()
    install(metamodel=SMART_CITY_MM, model=SMART_CITY_MODEL)
    rev = write_snapshot_from_rows(DEFAULT_PROJECT_ID)
    assert _stored(rev) == _expected(SMART_CITY_MM, SMART_CITY_MODEL)


def test_rows_snapshot_equals_fixture_model() -> None:
    doc = load_fixture("snapshot_v2")
    metamodel_yaml = json.dumps(doc["metamodel"])  # JSON is YAML
    blob = gzip.compress(doc["text"].encode("utf-8"))
    model_json = json.dumps(decode_snapshot(blob), allow_nan=False)
    seed_default_project()
    install(metamodel=metamodel_yaml, model=model_json)
    rev = write_snapshot_from_rows(DEFAULT_PROJECT_ID)
    assert _stored(rev) == _expected(metamodel_yaml, model_json)


def test_rows_snapshot_after_random_commits(client: TestClient) -> None:
    rng = random.Random(11)
    landed = attempts = 0
    while landed < 50:
        attempts += 1
        assert attempts < 600, "the generator no longer lands commits"
        session = get_registry().get(DEFAULT_PROJECT_ID)
        assert session.model is not None
        ids = (list(session.model.elements), list(session.model.relationships))
        landed += post_commit(client, _random_ops(rng, ids)).status_code == 200
    rev = write_snapshot_from_rows(DEFAULT_PROJECT_ID)
    model_rev, _, digest = _model_row()
    assert rev == model_rev
    text = _stored(rev)
    header = json.loads(text.partition(b"\n")[0])
    assert header["state_digest"] == digest
    with db.db_session() as s:
        want_e, want_r = head_mod.read_head(s, DEFAULT_PROJECT_ID)
    got = decode_snapshot(text)
    assert got["elements"] == [
        {k: e[k] for k in ("id", "type_name", "properties", "rev")} for e in want_e
    ]
    assert got["relationships"] == want_r
    assert header["elements"] == len(want_e)
    assert header["relationships"] == len(want_r)


def test_exact_values(client: TestClient) -> None:
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {"label": "NaN", "x": 1.0, "n": 2**60},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_b",
                "type_name": "Node",
                "properties": {"label": "-Infinity", "x": 0.5, "n": 1},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_c",
                "type_name": "Node",
                "properties": {"label": "Infinity"},
            },
        ],
    )
    rev = write_snapshot_from_rows(DEFAULT_PROJECT_ID)
    text = _stored(rev)
    session = get_registry().get(DEFAULT_PROJECT_ID)
    assert session.model is not None
    for line in iter_entity_lines(session.model):
        assert line.encode() + b"\n" in text
    for token in (b'"x":1.0', b'"n":1152921504606846976', b'"NaN"', b'"Infinity"'):
        assert token in text
    assert b"-Infinity" in text


def test_descriptor_without_model(client: TestClient) -> None:
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {"label": "A"},
            }
        ],
    )
    session = get_registry().get(DEFAULT_PROJECT_ID)
    session.model = None
    with db.db_session() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        s.execute(delete(Snapshot))
        head_rev = row.model_rev
    res = client.get(papi("/replica/snapshot"))
    assert res.status_code == 200, res.text
    assert res.json()["rev"] == head_rev
    assert res.json()["elements"] == 1
    assert _stored(head_rev)


class _Blob:
    def __init__(self) -> None:
        self.opened: list[tuple[str, dict[str, Any]]] = []
        self.written = b""

    def open(self, mode: str, **kwargs: Any) -> "_Blob":
        self.opened.append((mode, kwargs))
        return self

    def write(self, data: bytes) -> None:
        self.written += data

    def __enter__(self) -> "_Blob":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class _Bucket:
    def __init__(self) -> None:
        self.blob_obj = _Blob()

    def blob(self, key: str) -> _Blob:
        return self.blob_obj


class _Client:
    def __init__(self) -> None:
        self.bucket_obj = _Bucket()

    def bucket(self, name: str) -> _Bucket:
        return self.bucket_obj


def test_gcs_put_sets_gzip_type() -> None:
    client = _Client()
    GcsSnapshotStore("b", client=client).put("k", iter([b"ab", b"cd"]))
    blob = client.bucket_obj.blob_obj
    assert blob.written == b"abcd"
    ((mode, kwargs),) = blob.opened
    assert mode == "wb"
    assert kwargs["content_type"] == "application/gzip"
    assert kwargs["chunk_size"] == 8 * 1024 * 1024
    assert "content_encoding" not in kwargs


def test_descriptor_of_a_project_without_head_rows_is_409(client: TestClient) -> None:
    with db.db_session() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        row.state_digest = None
        row.next_seq = None
        s.execute(delete(Snapshot))
    res = client.get(papi("/replica/snapshot"))
    assert res.status_code == 409
    assert res.json()["detail"] == "project has no head rows: re-import it"
