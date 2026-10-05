"""Every snapshot writer emits ``datarover.snapshot/v2``: the header carries the
rows' digest and the bound metamodel id, the row mirrors the header, and the
write holds the rows still for the whole stream."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, importer
from data_rover.api.db_models import Commit, Project
from data_rover.api.main import create_app
from data_rover.api.serialize import (
    iter_entity_lines,
    iter_model_json_compact,
    parse_model_json,
)
from data_rover.api.project_state import DEFAULT_PROJECT_ID, get_registry
from data_rover.api.snapshot_codec import decode_snapshot
from data_rover.api.snapshot_rows import write_snapshot_from_rows
from data_rover.api.storage import get_snapshot_store
from data_rover.core.model.model import Model

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    EMPTY_MODEL,
    install,
    commit_ops,
    default_state,
    head,
    rows_model,
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
    header = _assert_v2(
        DEFAULT_PROJECT_ID, default_state().model_rev, rows_model(DEFAULT_PROJECT_ID)
    )
    assert header["metamodel_id"] == _model_row_metamodel_id(DEFAULT_PROJECT_ID)


def test_the_periodic_snapshot_is_v2(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "2")
    for i in range(4):
        _ops(client, [_node(f"t{i}", f"n{i}")])
        if default_state().model_rev % 2 == 0:
            break
    rev = default_state().model_rev
    assert rev % 2 == 0
    _assert_v2(DEFAULT_PROJECT_ID, rev, rows_model(DEFAULT_PROJECT_ID))


def test_eviction_writes_no_snapshot(client: TestClient) -> None:
    _ops(client, [_node("a", "A"), _node("b", "B")])
    rev = default_state().model_rev
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
            "base_rev": default_state().model_rev,
            "ops": [{"kind": "metamodel.rebind", "blob": _MM_V2}],
            "message": "rebind",
            "lock_tokens": [res.json()["token"]],
        },
    )
    assert res.status_code == 200, res.text
    rev = default_state().model_rev
    header = _assert_v2(DEFAULT_PROJECT_ID, rev, rows_model(DEFAULT_PROJECT_ID))
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
    _assert_v2("proj", 0, rows_model("proj"))


def test_a_project_without_a_model_row_has_no_snapshot() -> None:
    with db.db_session() as s:
        s.add(Project(id="bare", name="Bare"))
    with pytest.raises(LookupError):
        write_snapshot_from_rows("bare")


def test_the_header_digest_is_the_rows_not_a_model_pass(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = _ops(client, [_node("a", "A")])
    rev = default_state().model_rev

    def _no_full_pass(*_: object) -> None:
        raise AssertionError("a full digest pass")

    monkeypatch.setattr("data_rover.api.head.digest_value", _no_full_pass)
    monkeypatch.setattr("data_rover.api.snapshot_codec.model_digest", _no_full_pass)
    assert write_snapshot_from_rows(DEFAULT_PROJECT_ID) == rev
    assert _header(DEFAULT_PROJECT_ID, rev)["state_digest"] == body["state_digest"]


def test_a_v2_snapshot_decodes_to_the_rows(client: TestClient) -> None:
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
    rev = head().rev
    write_snapshot_from_rows(DEFAULT_PROJECT_ID)
    lines = list(iter_entity_lines(rows_model(DEFAULT_PROJECT_ID)))
    text = _inflated(DEFAULT_PROJECT_ID, rev)
    assert text.split(b"\n")[1:-1] == [line.encode() for line in lines]
    assert _header(DEFAULT_PROJECT_ID, rev)["state_digest"] == head_digest()


def head_digest() -> str | None:
    with db.db_session() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        return row.state_digest
