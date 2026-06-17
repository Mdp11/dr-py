"""WebSocket feed endpoint (Phase 5): connect, authz, snapshot, presence."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()  # each TestClient creates its own event loop; clear the cached one
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    ).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def _feed_url(user: str = "test-user") -> str:
    # browsers cannot set headers on a WS handshake -> identity via query params
    return papi(f"/feed?x-user-id={user}&x-user-email={user}@example.com")


def test_connect_receives_snapshot(client: TestClient) -> None:
    with client.websocket_connect(_feed_url()) as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot"
        assert snap["model_rev"] == 2  # metamodel upload (+1) then model upload (+1)
        assert snap["connected"] == ["test-user"]
        assert snap["locks"] == []


def test_second_client_sees_presence_join(client: TestClient) -> None:
    with client.websocket_connect(_feed_url("test-user")) as ws1:
        ws1.receive_json()  # own snapshot
        with client.websocket_connect(_feed_url("test-user")) as ws2:
            ws2.receive_json()  # ws2 snapshot
            # ws1 is told someone joined
            evt = ws1.receive_json()
            assert evt["type"] == "presence" and evt["action"] == "join"


def test_unknown_project_closes_4404(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    url = "/api/v1/projects/nope/feed?x-user-id=test-user"
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url) as ws:
            ws.receive_json()
    assert exc.value.code == 4404


def test_missing_identity_closes_4401(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    # Use a fresh client without AUTH_HEADERS set at the client level — the
    # httpx TestClient merges client-level headers into every request including
    # WS upgrades, so we need a bare client to simulate a missing identity.
    reset_loop()
    bare = TestClient(create_app())
    with pytest.raises(WebSocketDisconnect) as exc:
        with bare.websocket_connect(papi("/feed")) as ws:
            ws.receive_json()
    assert exc.value.code == 4401
