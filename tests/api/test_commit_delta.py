"""What a replica follows a commit by: ``prev_rev``, ``state_digest`` and the
``recreated_*`` lists on every carrier, and the session digest behind them —
kept up per batch, true to a full recomputation, put back with a batch that
is taken back, and unknown after whatever moves the model around it."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry, get_session
from data_rover.api.state_digest import model_digest

from .conftest import AUTH_HEADERS, feed_url, papi, seed_default_project

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


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _node(temp_id: str, label: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": {"label": label},
        **extra,
    }


def _contains(temp_id: str, source: str, target: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": "Contains",
        "source_id": source,
        "target_id": target,
        "properties": {},
        **extra,
    }


def _ops(client: TestClient, ops: list[dict[str, Any]]) -> dict[str, Any]:
    res = client.post(
        papi("/model/ops"), json={"base_rev": get_session().model_rev, "ops": ops}
    )
    assert res.status_code == 200, res.text
    return res.json()


def _true_digest() -> str:
    model = get_session().model
    assert model is not None
    return model_digest(model)


def _journal_digest(rev: int) -> str | None:
    with db.db_session() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, rev)
        assert row is not None
        return row.state_digest


# ---------------------------------------------------------------------------
# the session digest
# ---------------------------------------------------------------------------


def test_the_digest_is_kept_up_per_batch_and_stays_true(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = get_session()
    assert session.state_digest_value is None  # a model just installed: unknown

    first = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a, b = first["id_map"]["tmp_a"], first["id_map"]["tmp_b"]
    assert first["state_digest"] == _true_digest()
    assert session.state_digest_value is not None  # known from here on

    def _no_full_pass(model: object) -> int:
        raise AssertionError("the session recomputed a digest it knew")

    # every kind of touch, folded in without another pass over the model
    monkeypatch.setattr("data_rover.api.session.digest_value", _no_full_pass)
    batches: list[list[dict[str, Any]]] = [
        [_contains("tmp_r", a, b)],
        [{"kind": "update_element", "id": b, "properties_patch": {"label": "b2"}}],
        [{"kind": "update_element", "id": b, "properties_patch": {"label": None}}],
        [_node("tmp_c", "c"), {"kind": "delete_element", "id": "tmp_c"}],
        [{"kind": "delete_element", "id": b}, _node("tmp_b2", "again", id=b)],
        [{"kind": "delete_element", "id": a}],
    ]
    for ops in batches:
        body = _ops(client, ops)
        assert body["state_digest"] == _true_digest(), ops
        assert body["state_digest"] == session.state_digest()


def test_whatever_moves_the_model_around_the_digest_leaves_it_unknown(
    client: TestClient,
) -> None:
    session = get_session()
    _ops(client, [_node("tmp_a", "a")])
    assert session.state_digest_value is not None

    # a legacy direct route mutates behind the op protocol
    res = client.post(papi("/model/elements"), json={"type": "Node", "properties": {}})
    assert res.status_code in (200, 201), res.text
    assert session.state_digest_value is None
    assert _ops(client, [_node("tmp_b", "b")])["state_digest"] == _true_digest()

    # a model replaced whole
    res = client.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    assert session.state_digest_value is None
    assert session.state_digest() == "0" * 16


def test_a_batch_taken_back_takes_the_digest_back(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = get_session()
    known = _ops(client, [_node("tmp_a", "a")])["state_digest"]

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.routes.ops._persist_commit", _boom)
    res = client.post(
        papi("/model/ops"),
        json={"base_rev": session.model_rev, "ops": [_node("tmp_b", "b")]},
    )
    assert res.status_code == 500, res.text
    assert session.state_digest() == known == _true_digest()


def test_a_rehydrated_session_reaches_the_same_digest(client: TestClient) -> None:
    body = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a = body["id_map"]["tmp_a"]
    live = _ops(
        client,
        [{"kind": "update_element", "id": a, "properties_patch": {"label": "a2"}}],
    )["state_digest"]

    get_registry().evict(DEFAULT_PROJECT_ID)  # snapshot, then drop
    session = get_registry().get(DEFAULT_PROJECT_ID)
    assert session.state_digest_value is None  # hydrated: unknown until read
    with session.write_mutex:
        assert session.state_digest() == live


# ---------------------------------------------------------------------------
# the carriers
# ---------------------------------------------------------------------------


def test_ops_response_carries_the_delta_fields(client: TestClient) -> None:
    rev = get_session().model_rev
    body = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a, b = body["id_map"]["tmp_a"], body["id_map"]["tmp_b"]
    assert body["prev_rev"] == rev
    assert body["model_rev"] == rev + 1
    assert body["state_digest"] == _true_digest() == _journal_digest(rev + 1)
    assert body["recreated_element_ids"] == []
    assert body["recreated_relationship_ids"] == []

    rel = _ops(client, [_contains("tmp_r", a, b)])["id_map"]["tmp_r"]
    body = _ops(
        client,
        [
            {"kind": "delete_element", "id": b},
            _node("tmp_b2", "again", id=b),
            _contains("tmp_r2", a, "tmp_b2", id=rel),
        ],
    )
    assert body["recreated_element_ids"] == [b]
    assert body["recreated_relationship_ids"] == [rel]
    assert body["deleted_element_ids"] == []


def test_a_response_that_applied_nothing_carries_no_delta(client: TestClient) -> None:
    res = client.post(
        papi("/model/ops"), json={"base_rev": get_session().model_rev, "ops": []}
    )
    assert res.status_code == 200, res.text
    assert res.json()["prev_rev"] is None
    assert res.json()["state_digest"] is None


def test_undo_carries_the_delta_fields(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "a")])
    rev = get_session().model_rev
    res = client.post(papi("/model/undo"))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["prev_rev"] == rev
    assert body["state_digest"] == _true_digest() == _journal_digest(rev + 1)
    assert body["state_digest"] == "0" * 16  # the model is empty again


def test_commit_response_and_feed_event_carry_the_delta_fields(
    client: TestClient,
) -> None:
    with client.websocket_connect(feed_url()) as ws:
        ws.receive_json()  # snapshot
        rev = get_session().model_rev
        res = client.post(
            papi("/commits"),
            json={
                "base_rev": rev,
                "ops": [_node("tmp_a", "a")],
                "lock_tokens": [],
                "message": "create",
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        event = ws.receive_json()
        while event["type"] != "commit":
            event = ws.receive_json()
    for carrier in (body, event):
        assert carrier["prev_rev"] == rev
        assert carrier["state_digest"] == _true_digest()
        assert carrier["recreated_element_ids"] == []
        assert carrier["recreated_relationship_ids"] == []
    assert event["rev"] == body["model_rev"] == rev + 1
    assert _journal_digest(rev + 1) == body["state_digest"]


def test_revert_carries_the_delta_fields(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "a")])
    target = get_session().model_rev
    _ops(client, [_node("tmp_b", "b")])
    with client.websocket_connect(feed_url()) as ws:
        ws.receive_json()  # snapshot
        rev = get_session().model_rev
        res = client.post(
            papi("/commits/revert"), json={"target_rev": target, "base_rev": rev}
        )
        assert res.status_code == 200, res.text
        body = res.json()
        event = ws.receive_json()
        while event["type"] != "commit":
            event = ws.receive_json()
    for carrier in (body, event):
        assert carrier["prev_rev"] == rev
        assert carrier["state_digest"] == _true_digest()
    assert _journal_digest(rev + 1) == body["state_digest"]


def test_a_commit_that_could_not_be_persisted_takes_the_digest_back(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = get_session()
    known = _ops(client, [_node("tmp_a", "a")])["state_digest"]

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.routes.commits._persist_commit", _boom)
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": session.model_rev,
            "ops": [_node("tmp_b", "b")],
            "lock_tokens": [],
            "message": "lost",
        },
    )
    assert res.status_code == 500, res.text
    assert session.state_digest() == known == _true_digest()
