"""A ``model_rev`` bump that writes no journal row is announced on the feed as a
header-only ``reset`` frame; a journaled commit is not."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from data_rover.api import content, feed
from data_rover.api.db import db_session
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    install,
    EMPTY_MODEL,
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
  - name: Refers
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()  # each TestClient creates its own event loop; clear the cached one
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def _feed_url(user: str = "test-user") -> str:
    return papi(f"/feed?x-user-id={user}&x-user-email={user}@example.com")


def _settle(ws: WebSocketTestSession) -> None:
    """Reads the initial snapshot and the client's own presence join, which the
    hub queues for every registered client, this one included."""
    assert ws.receive_json()["type"] == "snapshot"
    evt = ws.receive_json()
    assert (evt["type"], evt["action"]) == ("presence", "join")


def _frames_before_join(
    client: TestClient, ws: WebSocketTestSession
) -> list[dict[str, Any]]:
    """Every frame ``ws`` receives before a second client's presence join.

    The join is broadcast through the same loop after whatever the calls before
    it broadcast, so it bounds the read: a missing frame fails, never hangs."""
    frames: list[dict[str, Any]] = []
    with client.websocket_connect(_feed_url()) as ws2:
        ws2.receive_json()  # its own snapshot
        while True:
            evt = ws.receive_json()
            if evt["type"] == "presence" and evt["action"] == "join":
                return frames
            frames.append(evt)


def _resets(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [f for f in frames if f["type"] == "reset"]


def _ops(client: TestClient, ops: list[dict[str, Any]]) -> dict[str, Any]:
    return commit_ops(client, ops)


def _seed(client: TestClient) -> dict[str, str]:
    """Two nodes and a ``Refers`` between them, written through the ops path."""
    out = _ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_b",
                "type_name": "Node",
                "properties": {},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Refers",
                "source_id": "tmp_a",
                "target_id": "tmp_b",
            },
        ],
    )
    ids = out["id_map"]
    return {"a": ids["tmp_a"], "b": ids["tmp_b"], "r": ids["tmp_r"]}


def _spy_on_resets(
    monkeypatch: pytest.MonkeyPatch, read: Callable[[], Any]
) -> list[Any]:
    """Records ``read()`` at the moment each ``reset`` is broadcast."""
    hub = get_session().hub
    original = hub.broadcast
    seen: list[Any] = []

    def spy(event: dict[str, Any]) -> None:
        if event["type"] == "reset":
            seen.append(read())
        original(event)

    monkeypatch.setattr(hub, "broadcast", spy)
    return seen


def test_an_install_announces_after_its_baseline(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def snapshot_rev() -> int | None:
        with db_session() as db:
            row = content.latest_snapshot(db, DEFAULT_PROJECT_ID)
            return None if row is None else row.rev

    with client.websocket_connect(_feed_url()) as ws:
        _settle(ws)
        seen = _spy_on_resets(monkeypatch, snapshot_rev)
        body = (
            b'{"elements":[{"id":"n1","type_name":"Node","properties":{}}],'
            b'"relationships":[]}'
        )
        install(metamodel=_MM, model=body)
        rev = get_session().model_rev
        assert _resets(_frames_before_join(client, ws)) == [
            {"type": "reset", "model_rev": rev}
        ]
    assert seen == [rev]


def test_post_metamodel_announces_after_its_rows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def metamodel_id() -> str | None:
        with db_session() as db:
            row = content.get_model_row(db, DEFAULT_PROJECT_ID)
            assert row is not None
            return row.metamodel_id

    old_id = metamodel_id()
    with client.websocket_connect(_feed_url()) as ws:
        _settle(ws)
        seen = _spy_on_resets(monkeypatch, metamodel_id)
        res = client.post(
            papi("/metamodel"),
            content=_MM,
            headers={"content-type": "application/x-yaml"},
        )
        assert res.status_code == 200, res.text
        rev = get_session().model_rev
        assert _resets(_frames_before_join(client, ws)) == [
            {"type": "reset", "model_rev": rev}
        ]
    new_id = metamodel_id()
    assert new_id != old_id
    assert seen == [new_id]


def test_a_metamodel_delete_announces_itself(client: TestClient) -> None:
    with client.websocket_connect(_feed_url()) as ws:
        _settle(ws)
        assert client.delete(papi("/metamodel")).status_code == 204
        rev = get_session().model_rev
        assert _resets(_frames_before_join(client, ws)) == [
            {"type": "reset", "model_rev": rev}
        ]


def test_a_commit_does_not(client: TestClient) -> None:
    ids = _seed(client)
    with client.websocket_connect(_feed_url()) as ws:
        _settle(ws)
        lock = client.post(
            papi("/locks"),
            json={
                "targets": [{"resource_id": ids["a"], "mode": "exclusive"}],
                "intent": "edit",
            },
        )
        assert lock.status_code == 200, lock.text
        commit = client.post(
            papi("/commits"),
            json={
                "base_rev": get_session().model_rev,
                "ops": [
                    {
                        "kind": "update_element",
                        "id": ids["a"],
                        "properties_patch": {"label": "c"},
                    }
                ],
                "message": "label",
                "lock_tokens": [lock.json()["token"]],
            },
        )
        assert commit.status_code == 200, commit.text
        frames = _frames_before_join(client, ws)
        assert _resets(frames) == []
        assert [f["type"] for f in frames if f["type"] == "commit"] == ["commit"]


def test_the_replica_routes_after_a_reset(client: TestClient) -> None:
    before = get_session().model_rev
    session = get_session()
    session.set_model(session.model, announce=False)
    head = session.model_rev
    assert head == before + 1

    tail = client.get(papi(f"/replica/tail?from_rev={before}"))
    assert tail.status_code == 200, tail.text
    assert tail.json()["complete"] is False

    descriptor = client.get(papi("/replica/snapshot"))
    assert descriptor.status_code == 200, descriptor.text
    assert descriptor.json()["rev"] == head


def test_reset_event_has_exactly_two_keys() -> None:
    assert feed.reset_event(model_rev=7) == {"type": "reset", "model_rev": 7}
