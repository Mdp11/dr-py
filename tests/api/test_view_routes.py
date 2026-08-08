from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, create_folder_via_commit, papi, seed_default_project

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


def test_get_view_rev_none_without_row(client: TestClient) -> None:
    r = client.get(papi("/view"))
    assert r.status_code == 200
    assert r.json()["view"] is None and r.json()["view_rev"] is None


def test_get_view_surfaces_validate_view_warnings(client: TestClient) -> None:
    """Wire-level coverage for GET /view surfacing ``validate_view`` warnings
    (``IssueOut.from_core`` serialization) now that the only other exerciser
    of this response shape — the retired ``PUT /view/snapshot`` route — is
    gone. ``validate_view`` itself is unit-tested in depth at
    tests/view/test_validation.py; this only proves the wire response still
    carries its findings through GET /view."""
    _bootstrap(client)
    setup = create_folder_via_commit(client, "F")
    fid = setup["id_map"]["tmp_setup"]
    token = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
    ).json()["token"]
    base = client.get(papi("/open")).json()["model_rev"]
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {"kind": "place_element", "element_id": "does_not_exist", "folder_id": fid},
                {
                    "kind": "place_artifact",
                    "artifact_id": "nope",
                    "artifact_kind": "table",
                    "folder_id": fid,
                },
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text

    res = client.get(f"{API}/view")
    assert res.status_code == 200
    warnings = res.json()["warnings"]
    messages = [w["message"] for w in warnings]
    assert any("does_not_exist" in m for m in messages)
    assert any("unknown artifact" in m for m in messages)
