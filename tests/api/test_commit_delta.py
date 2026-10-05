"""What a replica follows a commit by: ``prev_rev``, ``state_digest`` and the
``recreated_*`` lists on every carrier, and the digest behind them on the model
row: kept up per batch without a pass over the entities, true to a full
recomputation, left as it was by a batch that is taken back, and whole across
whatever moves the revision or the rows around it."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, head
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.project_state import DEFAULT_PROJECT_ID, get_registry
from data_rover.api.state_digest import entity_hash, format_digest

from .conftest import (
    default_state,
    AUTH_HEADERS,
    feed_url,
    papi,
    seed_default_project,
    EMPTY_MODEL,
    install,
    commit_ops,
    unjournaled_bump,
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


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
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
    return commit_ops(client, ops)


def _true_digest() -> str:
    """The digest of the head rows by full recomputation, independent of
    ``state_digest.digest_value`` (which the tests below make fail)."""
    with db.db_session() as s:
        elements, relationships = head.read_head(s, DEFAULT_PROJECT_ID)
    value = 0
    for entity in (*elements, *relationships):
        value ^= entity_hash(entity["id"], entity["rev"])
    return format_digest(value)


def _row_digest() -> str | None:
    with db.db_session() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        return row.state_digest


def _journal_digest(rev: int) -> str | None:
    with db.db_session() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, rev)
        assert row is not None
        return row.state_digest


# ---------------------------------------------------------------------------
# the digest on the model row
# ---------------------------------------------------------------------------


def test_the_digest_is_kept_up_per_batch_and_stays_true(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a, b = first["id_map"]["tmp_a"], first["id_map"]["tmp_b"]
    assert first["state_digest"] == _true_digest() == _row_digest()

    def _no_full_pass(*_: object) -> int:
        raise AssertionError("a pass over every entity for a digest it knew")

    # every kind of touch, folded in without another pass over the model
    monkeypatch.setattr("data_rover.api.state_digest.digest_value", _no_full_pass)
    monkeypatch.setattr("data_rover.api.head.digest_value", _no_full_pass)
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
        assert body["state_digest"] == _true_digest() == _row_digest(), ops


def test_whatever_moves_the_revision_or_the_rows_leaves_the_digest_true(
    client: TestClient,
) -> None:
    _ops(client, [_node("tmp_a", "a")])

    # the revision moves with no journal row, as a commit needs the rows to
    # carry on from
    unjournaled_bump()
    assert _ops(client, [_node("tmp_b", "b")])["state_digest"] == _true_digest()

    # the rows replaced whole
    install(metamodel=_MM, model=EMPTY_MODEL)
    assert _row_digest() == "0" * 16 == _true_digest()


def test_a_batch_taken_back_leaves_the_digest_as_it_was(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = default_state()
    known = _ops(client, [_node("tmp_a", "a")])["state_digest"]

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.content.append_commit", _boom)
    res = client.post(
        papi("/commits"),
        json={"base_rev": state.model_rev, "ops": [_node("tmp_b", "b")]},
    )
    assert res.status_code == 500, res.text
    assert _row_digest() == known == _true_digest()


def test_the_digest_survives_eviction(client: TestClient) -> None:
    body = _ops(client, [_node("tmp_a", "a"), _node("tmp_b", "b")])
    a = body["id_map"]["tmp_a"]
    live = _ops(
        client,
        [{"kind": "update_element", "id": a, "properties_patch": {"label": "a2"}}],
    )["state_digest"]

    assert get_registry().evict(DEFAULT_PROJECT_ID)
    assert _row_digest() == live == _true_digest()
    again = _ops(
        client,
        [{"kind": "update_element", "id": a, "properties_patch": {"label": "a3"}}],
    )["state_digest"]
    assert again == _true_digest() == _row_digest() != live


# ---------------------------------------------------------------------------
# the carriers
# ---------------------------------------------------------------------------


def test_ops_response_carries_the_delta_fields(client: TestClient) -> None:
    rev = default_state().model_rev
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
    body = commit_ops(client, [])
    assert body["prev_rev"] is None
    assert body["state_digest"] is None


def test_commit_response_and_feed_event_carry_the_delta_fields(
    client: TestClient,
) -> None:
    with client.websocket_connect(feed_url()) as ws:
        ws.receive_json()  # snapshot
        rev = default_state().model_rev
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
    target = default_state().model_rev
    _ops(client, [_node("tmp_b", "b")])
    with client.websocket_connect(feed_url()) as ws:
        ws.receive_json()  # snapshot
        rev = default_state().model_rev
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


def test_a_commit_that_could_not_be_persisted_leaves_the_digest_and_rev(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = default_state()
    known = _ops(client, [_node("tmp_a", "a")])["state_digest"]

    def _boom(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("no database")

    monkeypatch.setattr("data_rover.api.routes.commits._stage_commit", _boom)
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": state.model_rev,
            "ops": [_node("tmp_b", "b")],
            "lock_tokens": [],
            "message": "lost",
        },
    )
    assert res.status_code == 500, res.text
    assert _row_digest() == known == _true_digest()
    assert state.model_rev == 1
