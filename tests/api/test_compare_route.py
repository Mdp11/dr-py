"""POST /api/v1/projects/{id}/model/compare — diff the session model against a
raw other-model body (session -> other). Read-only."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200, res.text
    return c


@pytest.fixture
def seeded(client: TestClient) -> TestClient:
    res = client.post(
        f"{API}/model",
        json={
            "elements": [_el("a", "A"), _el("b", "B")],
            "relationships": [_rel("r-ab", "a", "b")],
        },
    )
    assert res.status_code == 200, res.text
    return client


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


def _el(eid: str, name: str, type_name: str = "Item") -> dict:
    return {"id": eid, "type_name": type_name, "properties": {"name": name}}


def _rel(rid: str, src: str, tgt: str) -> dict:
    return {"id": rid, "type_name": "Contains", "source_id": src, "target_id": tgt}


def _compare(client: TestClient, other: dict, **kw):
    return client.post(f"{API}/model/compare", content=json.dumps(other).encode(), **kw)


def test_compare_is_session_to_other(seeded: TestClient) -> None:
    other = {"elements": [_el("a", "A2"), _el("c", "C")], "relationships": []}
    res = _compare(seeded, other)
    assert res.status_code == 200, res.text
    body = res.json()
    ops = body["cr"]["ops"]
    assert [e["id"] for e in ops["elements"]["added"]] == ["c"]
    assert [(m["id"], m["before"]["properties"], m["after"]["properties"]) for m in ops["elements"]["modified"]] == [
        ("a", {"name": "A"}, {"name": "A2"})
    ]
    assert [e["id"] for e in ops["elements"]["deleted"]] == ["b"]
    assert [r["id"] for r in ops["relationships"]["deleted"]] == ["r-ab"]
    assert body["cr"]["baseline"] == {"filename": None, "elementCount": 2, "relationshipCount": 1}
    assert (body["other_element_count"], body["other_relationship_count"]) == (2, 0)
    assert body["model_rev"] == seeded.get(f"{API}/model/summary").json()["model_rev"]


def test_compare_identical_is_empty(seeded: TestClient) -> None:
    other = seeded.get(f"{API}/model").json()
    body = _compare(seeded, other).json()
    assert body["cr"]["ops"]["elements"] == {"added": [], "modified": [], "deleted": []}


def test_compare_tolerates_unknown_types(seeded: TestClient) -> None:
    other = {"elements": [_el("a", "A"), _el("b", "B"), _el("g", "G", type_name="Ghost")], "relationships": [_rel("r-ab", "a", "b")]}
    res = _compare(seeded, other)
    assert res.status_code == 200, res.text
    assert [e["id"] for e in res.json()["cr"]["ops"]["elements"]["added"]] == ["g"]


def test_compare_rejects_invalid_json_422(seeded: TestClient) -> None:
    res = seeded.post(f"{API}/model/compare", content=b"{not json")
    assert res.status_code == 422
    assert "not valid JSON" in res.json()["detail"]


def test_compare_rejects_dangling_endpoint_422(seeded: TestClient) -> None:
    other = {"elements": [_el("a", "A")], "relationships": [_rel("r-ax", "a", "x")]}
    assert _compare(seeded, other).status_code == 422


def test_compare_without_model_404(client: TestClient) -> None:
    assert _compare(client, {"elements": [], "relationships": []}).status_code == 404


def test_compare_viewer_allowed(seeded: TestClient, viewer_headers: dict[str, str]) -> None:
    res = _compare(seeded, {"elements": [], "relationships": []}, headers=viewer_headers)
    assert res.status_code == 200, res.text
    assert [e["id"] for e in res.json()["cr"]["ops"]["elements"]["deleted"]] == ["a", "b"]
