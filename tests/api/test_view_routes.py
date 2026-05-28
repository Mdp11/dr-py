from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import reset_session

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


@pytest.fixture
def client() -> TestClient:
    reset_session()
    app = create_app()
    return TestClient(app)


def _bootstrap(client: TestClient) -> tuple[str, str]:
    """Upload metamodel + a tiny model with two Blocks; return their ids."""
    client.post(
        "/api/v1/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post("/api/v1/model", json={"elements": [], "relationships": []})
    a = client.post(
        "/api/v1/model/elements",
        json={"type": "Block", "properties": {"name": "A", "mass": 1.0}},
    ).json()
    b = client.post(
        "/api/v1/model/elements",
        json={"type": "Block", "properties": {"name": "B", "mass": 2.0}},
    ).json()
    return a["id"], b["id"]


def test_get_view_returns_null_when_unset(client: TestClient) -> None:
    _bootstrap(client)
    res = client.get("/api/v1/view")
    assert res.status_code == 200
    body = res.json()
    assert body["view"] is None
    assert body["warnings"] == []


def test_put_view_snapshot_round_trip(client: TestClient) -> None:
    a_id, _b_id = _bootstrap(client)
    res = client.put(
        "/api/v1/view/snapshot",
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

    res = client.get("/api/v1/view")
    assert res.status_code == 200
    assert res.json()["view"]["name"] == "Operational"

    # element b_id never placed; it stays implicit at root — view warnings are silent
    res = client.delete("/api/v1/view")
    assert res.status_code == 204
    assert client.get("/api/v1/view").json()["view"] is None


def test_put_view_with_missing_element_warns(client: TestClient) -> None:
    _bootstrap(client)
    res = client.put(
        "/api/v1/view/snapshot",
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
        "/api/v1/view/snapshot",
        json={"name": "V", "folders": []},
    )
    assert res.status_code == 404


def test_put_view_rejects_invalid_payload(client: TestClient) -> None:
    _bootstrap(client)
    res = client.put("/api/v1/view/snapshot", json={"folders": []})
    assert res.status_code == 422
