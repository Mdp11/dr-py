"""Artifacts CRUD: project-scoped, membership-authorized, optimistic-rev
guarded, payload-validated per kind (Stage 1: navigation only)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

NAV_PAYLOAD = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [{"relationship_type": "BlockHasPart"}],
}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _create(client: TestClient, name: str = "My nav") -> dict:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": name, "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_create_get_list_roundtrip(client: TestClient) -> None:
    created = _create(client)
    assert created["artifact_rev"] == 1
    assert created["payload"]["kind"] == "path"

    got = client.get(f"{API}/artifacts/{created['id']}").json()
    assert got["name"] == "My nav"

    listed = client.get(f"{API}/artifacts", params={"kind": "navigation"}).json()
    assert [a["id"] for a in listed["items"]] == [created["id"]]
    # headers carry no payload
    assert "payload" not in listed["items"][0]


def test_create_duplicate_name_409(client: TestClient) -> None:
    _create(client)
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "My nav", "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 409


def test_create_invalid_payload_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "bad", "payload": {"kind": "nope"}},
    )
    assert res.status_code == 422


def test_create_unsupported_kind_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts", json={"kind": "table", "name": "t", "payload": {}}
    )
    assert res.status_code == 422


def test_update_rev_conflict_and_success(client: TestClient) -> None:
    created = _create(client)
    stale = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 99, "name": "renamed"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_rev"] == 1

    ok = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "renamed"},
    )
    assert ok.status_code == 200
    assert ok.json()["artifact_rev"] == 2
    assert ok.json()["name"] == "renamed"


def test_delete_then_404(client: TestClient) -> None:
    created = _create(client)
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 204
    assert client.get(f"{API}/artifacts/{created['id']}").status_code == 404
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 404


def test_writes_broadcast_artifact_events(client: TestClient) -> None:
    events: list[dict] = []
    hub = get_session().hub
    original = hub.broadcast
    hub.broadcast = events.append  # type: ignore[method-assign]
    try:
        created = _create(client)
        client.put(
            f"{API}/artifacts/{created['id']}",
            json={"artifact_rev": 1, "name": "n2"},
        )
        client.delete(f"{API}/artifacts/{created['id']}")
    finally:
        hub.broadcast = original  # type: ignore[method-assign]
    kinds = [(e["type"], e["action"]) for e in events]
    assert kinds == [("artifact", "created"), ("artifact", "updated"),
                     ("artifact", "deleted")]
    assert events[0]["artifact"]["name"] == "My nav"
