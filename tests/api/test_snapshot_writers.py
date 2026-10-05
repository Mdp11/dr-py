"""Every snapshot writer emits ``datarover.snapshot/v2``: the header carries the
session's digest and the bound metamodel id, the row mirrors the header, and
the write holds the model still for the whole stream."""

from __future__ import annotations

import gzip
import json
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, hydration, importer
from data_rover.api.db_models import Commit, Project
from data_rover.api.main import create_app
from data_rover.api.serialize import (
    iter_entity_lines,
    iter_model_json_compact,
    parse_model_json,
)
from data_rover.api.session import (
    DEFAULT_PROJECT_ID,
    Session,
    get_registry,
    get_session,
)
from data_rover.api.snapshot_codec import decode_snapshot, encode_snapshot
from data_rover.api.snapshot_rows import write_snapshot_from_rows
from data_rover.api.storage import (
    MemorySnapshotStore,
    get_snapshot_store,
    set_snapshot_store,
    snapshot_key,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.api.routes._snapshot import build_model_from_dicts

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    EMPTY_MODEL,
    install,
    commit_ops,
)

_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""

_MM_V2 = (
    _MM
    + """
  - name: Refers
    source: Node
    target: Node
"""
)

_EXAMPLES = Path("examples")


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def _node(temp_id: str, label: str) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{temp_id}",
        "type_name": "Node",
        "properties": {"label": label},
    }


def _ops(client: TestClient, ops: list[dict[str, Any]]) -> dict[str, Any]:
    return commit_ops(client, ops)


def _row(project_id: str, rev: int) -> Any:
    with db.db_session() as s:
        row = content.get_snapshot(s, project_id, rev)
        assert row is not None, f"no snapshot row at {rev}"
        s.expunge(row)
        return row


def _inflated(project_id: str, rev: int) -> bytes:
    return gzip.decompress(get_snapshot_store().get(_row(project_id, rev).key))


def _header(project_id: str, rev: int) -> dict[str, Any]:
    return json.loads(_inflated(project_id, rev).partition(b"\n")[0])


def _model_row_metamodel_id(project_id: str) -> str:
    with db.db_session() as s:
        row = content.get_model_row(s, project_id)
        assert row is not None
        return row.metamodel_id


def _document(model: Model) -> Any:
    return parse_model_json("".join(iter_model_json_compact(model)))


def _assert_v2(project_id: str, rev: int, model: Model) -> dict[str, Any]:
    text = _inflated(project_id, rev)
    assert text.startswith(b'{"format":"datarover.snapshot/v2"')
    header = json.loads(text.partition(b"\n")[0])
    assert header["project_id"] == project_id
    assert header["rev"] == rev
    row = _row(project_id, rev)
    assert row.format == "v2"
    for field in ("metamodel_id", "state_digest", "elements", "relationships"):
        assert getattr(row, field) == header[field], field
    lines = text.split(b"\n")[1:]
    assert lines[-1] == b""
    assert len(lines) - 1 == header["elements"] + header["relationships"]
    blob = get_snapshot_store().get(row.key)
    assert decode_snapshot(blob) == _document(model)
    return header


def test_the_baseline_snapshot_is_v2(client: TestClient) -> None:
    session = get_session()
    assert session.model is not None
    header = _assert_v2(DEFAULT_PROJECT_ID, session.model_rev, session.model)
    assert header["metamodel_id"] == _model_row_metamodel_id(DEFAULT_PROJECT_ID)


def test_the_periodic_snapshot_is_v2(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "2")
    for i in range(4):
        _ops(client, [_node(f"t{i}", f"n{i}")])
        if get_session().model_rev % 2 == 0:
            break
    session = get_session()
    assert session.model is not None and session.model_rev % 2 == 0
    _assert_v2(DEFAULT_PROJECT_ID, session.model_rev, session.model)


def test_eviction_writes_no_snapshot(client: TestClient) -> None:
    _ops(client, [_node("a", "A"), _node("b", "B")])
    rev = get_session().model_rev
    get_registry().evict(DEFAULT_PROJECT_ID)
    assert get_registry().peek(DEFAULT_PROJECT_ID) is None
    with db.db_session() as s:
        assert content.get_snapshot(s, DEFAULT_PROJECT_ID, rev) is None


def test_the_rebind_snapshot_is_v2_and_names_the_new_metamodel(
    client: TestClient,
) -> None:
    before = _model_row_metamodel_id(DEFAULT_PROJECT_ID)
    res = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert res.status_code == 200, res.text
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [{"kind": "metamodel.rebind", "blob": _MM_V2}],
            "message": "rebind",
            "lock_tokens": [res.json()["token"]],
        },
    )
    assert res.status_code == 200, res.text
    session = get_session()
    assert session.model is not None
    header = _assert_v2(DEFAULT_PROJECT_ID, session.model_rev, session.model)
    with db.db_session() as s:
        row = s.get(Commit, (DEFAULT_PROJECT_ID, session.model_rev))
        assert row is not None and row.to_metamodel_id
        assert header["metamodel_id"] == row.to_metamodel_id != before



def test_the_rebind_snapshot_is_written_when_the_mirror_did_not_follow(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "data_rover.api.routes.commits._follow_commit", lambda *a, **k: False
    )
    before = _model_row_metamodel_id(DEFAULT_PROJECT_ID)
    res = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert res.status_code == 200, res.text
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [{"kind": "metamodel.rebind", "blob": _MM_V2}],
            "message": "rebind",
            "lock_tokens": [res.json()["token"]],
        },
    )
    assert res.status_code == 200, res.text
    rev = res.json()["model_rev"]
    header = _header(DEFAULT_PROJECT_ID, rev)
    with db.db_session() as s:
        row = s.get(Commit, (DEFAULT_PROJECT_ID, rev))
        assert row is not None and row.to_metamodel_id
        assert header["metamodel_id"] == row.to_metamodel_id != before

def test_the_importer_snapshot_is_v2() -> None:
    importer.import_project(
        project_id="proj",
        name="Smart City",
        owner_id="u1",
        metamodel_yaml=(_EXAMPLES / "smart-city.metamodel.yaml").read_text("utf-8"),
        model_json=(_EXAMPLES / "smart-city.model.json").read_text("utf-8"),
    )
    header = _header("proj", 0)
    assert header["metamodel_id"] == _model_row_metamodel_id("proj")
    hydrated = get_registry().get("proj")
    assert hydrated.model is not None
    _assert_v2("proj", 0, hydrated.model)


def test_a_project_without_a_model_row_has_no_snapshot() -> None:
    with db.db_session() as s:
        s.add(Project(id="bare", name="Bare"))
    with pytest.raises(LookupError):
        write_snapshot_from_rows("bare")


def test_the_header_digest_is_the_rows_not_a_model_pass(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = _ops(client, [_node("a", "A")])
    rev = get_session().model_rev

    def _no_full_pass(*_: object) -> None:
        raise AssertionError("a full digest pass")

    monkeypatch.setattr("data_rover.api.session.digest_value", _no_full_pass)
    monkeypatch.setattr("data_rover.api.snapshot_codec.model_digest", _no_full_pass)
    assert write_snapshot_from_rows(DEFAULT_PROJECT_ID) == rev
    assert _header(DEFAULT_PROJECT_ID, rev)["state_digest"] == body["state_digest"]


def test_a_v2_snapshot_hydrates_to_the_same_state(client: TestClient) -> None:
    body = _ops(client, [_node("a", "A"), _node("b", "B"), _node("c", "C")])
    ids = body["id_map"]
    _ops(
        client,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Contains",
                "source_id": ids["tmp_a"],
                "target_id": ids["tmp_b"],
                "properties": {},
            },
            {
                "kind": "update_element",
                "id": ids["tmp_c"],
                "properties_patch": {"label": "C2"},
            },
        ],
    )
    _ops(client, [{"kind": "delete_element", "id": ids["tmp_c"]}])
    session = get_session()
    assert session.model is not None
    lines = list(iter_entity_lines(session.model))
    rev = session.model_rev
    write_snapshot_from_rows(DEFAULT_PROJECT_ID)
    get_registry().evict(DEFAULT_PROJECT_ID)
    again = get_session()
    assert again.model is not None and again.model is not session.model
    assert list(iter_entity_lines(again.model)) == lines
    with again.write_mutex:
        assert again.state_digest() == _header(DEFAULT_PROJECT_ID, rev)["state_digest"]


def test_a_v1_snapshot_still_hydrates() -> None:
    metamodel_yaml = (_EXAMPLES / "smart-city.metamodel.yaml").read_text("utf-8")
    importer.import_project(
        project_id="old",
        name="Old",
        owner_id="u1",
        metamodel_yaml=metamodel_yaml,
        model_json=(_EXAMPLES / "smart-city.model.json").read_text("utf-8"),
    )
    model = get_registry().get("old").model
    assert model is not None
    lines = list(iter_entity_lines(model))
    get_registry().evict("old")
    key = snapshot_key("old", 0)
    get_snapshot_store().put(key, encode_snapshot(model))
    with db.db_session() as s:
        content.record_snapshot(s, "old", rev=0, key=key)
    assert not gzip.decompress(get_snapshot_store().get(key)).startswith(b'{"format"')
    assert _row("old", 0).format is None
    hydrated = get_registry().get("old")
    assert hydrated.model is not None
    assert list(iter_entity_lines(hydrated.model)) == lines
