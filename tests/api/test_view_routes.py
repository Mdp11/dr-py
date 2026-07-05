from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, seed_default_project

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"
API = "/api/v1/projects/default"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _bootstrap(client: TestClient) -> tuple[str, str]:
    """Upload metamodel + a tiny model with two Blocks; return their ids."""
    client.post(
        f"{API}/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post(f"{API}/model", json={"elements": [], "relationships": []})
    a = client.post(
        f"{API}/model/elements",
        json={"type": "Block", "properties": {"name": "A", "mass": 1.0}},
    ).json()
    b = client.post(
        f"{API}/model/elements",
        json={"type": "Block", "properties": {"name": "B", "mass": 2.0}},
    ).json()
    return a["id"], b["id"]


def test_get_view_returns_null_when_unset(client: TestClient) -> None:
    _bootstrap(client)
    res = client.get(f"{API}/view")
    assert res.status_code == 200
    body = res.json()
    assert body["view"] is None
    assert body["warnings"] == []


def test_put_view_snapshot_round_trip(client: TestClient) -> None:
    a_id, _b_id = _bootstrap(client)
    res = client.put(
        f"{API}/view/snapshot",
        json={
            "name": "Operational",
            "folders": [
                {"name": "Group", "folders": [], "elements": [a_id]},
            ],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["view"]["name"] == "Operational"
    assert body["view"]["folders"][0]["elements"] == [a_id]
    assert body["warnings"] == []

    res = client.get(f"{API}/view")
    assert res.status_code == 200
    assert res.json()["view"]["name"] == "Operational"

    # element b_id never placed; it stays implicit at root — view warnings are silent
    res = client.delete(f"{API}/view")
    assert res.status_code == 204
    assert client.get(f"{API}/view").json()["view"] is None


def test_put_view_with_missing_element_warns(client: TestClient) -> None:
    _bootstrap(client)
    res = client.put(
        f"{API}/view/snapshot",
        json={
            "name": "V",
            "folders": [{"name": "G", "folders": [], "elements": ["does_not_exist"]}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["warnings"]) == 1
    assert body["warnings"][0]["severity"] == "warning"
    assert "does_not_exist" in body["warnings"][0]["message"]


def test_put_view_requires_loaded_model(client: TestClient) -> None:
    res = client.put(
        f"{API}/view/snapshot",
        json={"name": "V", "folders": []},
    )
    assert res.status_code == 404


def test_put_view_rejects_invalid_payload(client: TestClient) -> None:
    _bootstrap(client)
    res = client.put(f"{API}/view/snapshot", json={"folders": []})
    assert res.status_code == 422


def test_view_snapshot_round_trips_artifact_refs(client: TestClient) -> None:
    _bootstrap(client)
    res = client.put(
        f"{API}/view/snapshot",
        json={"name": "V", "folders": [{
            "name": "F", "folders": [], "elements": [],
            "artifacts": [{"id": "a1", "kind": "navigation"}],
        }]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["view"]["folders"][0]["artifacts"] == [
        {"id": "a1", "kind": "navigation"}
    ]
    got = client.get(f"{API}/view")
    assert got.json()["view"]["folders"][0]["artifacts"] == [
        {"id": "a1", "kind": "navigation"}
    ]
