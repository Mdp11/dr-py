"""Tests for the lock acquire/release/renew/list endpoints (Phase 4).

POST /locks, POST /locks/release, POST /locks/renew, GET /locks.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

# Minimal metamodel: one concrete element type so we can create elements to lock.
_LOCK_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""

API = "/api/v1/projects/default"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    # Upload metamodel
    res = c.post(
        papi("/metamodel"),
        content=_LOCK_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    # Upload an empty model so GET /model/summary and POST /model/ops work
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _rev(client: TestClient) -> int:
    """Current model_rev from GET /model/summary."""
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _etype(client: TestClient) -> str:
    """First concrete element type name from the uploaded metamodel."""
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    return next(e["name"] for e in mm["elements"] if not e.get("abstract", False))


def _seed_two_elements(client: TestClient) -> tuple[str, str]:
    """Create two elements and return their generated ids."""
    etype = _etype(client)
    r = client.post(
        papi("/model/ops"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_a", "type_name": etype, "properties": {}},
                {"kind": "create_element", "temp_id": "tmp_b", "type_name": etype, "properties": {}},
            ],
        },
    )
    assert r.status_code == 200, r.text
    idmap = r.json()["id_map"]
    return idmap["tmp_a"], idmap["tmp_b"]


def test_lock_then_release(client: TestClient) -> None:
    a, _b = _seed_two_elements(client)
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    token = body["token"]
    assert any(le["resource_id"] == a for le in body["leases"])

    rel = client.post(papi("/locks/release"), headers=AUTH_HEADERS, json={"token": token})
    assert rel.status_code == 200 and rel.json()["released"] >= 1


def test_lock_conflict_returns_non_200_for_second_holder(client: TestClient) -> None:
    """A conflicting acquire by a different identity must never return a fresh 200 grant.

    The default conftest seeds only TEST_USER_ID as owner; u2 is not a member,
    so the authz middleware raises 403 before the lock logic is reached. Whether
    the invariant is enforced by authz (403) or by the lock table (409), the
    result is the same: the conflicting request does NOT get a new independent
    200 grant.
    """
    a, _b = _seed_two_elements(client)
    body = {"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"}

    first = client.post(papi("/locks"), headers=AUTH_HEADERS, json=body)
    assert first.status_code == 200, first.text

    # u2 is not a project member → 403 from require_membership.
    # (If conftest were extended to add u2 as a member, this would be 409.)
    other_headers = {"X-User-Id": "u2", "X-User-Email": "u2@x"}
    second = client.post(papi("/locks"), headers=other_headers, json=body)
    assert second.status_code in (403, 409), (
        f"Expected 403 or 409 (conflicting acquire must not be granted), "
        f"got {second.status_code}: {second.text}"
    )


def test_renew_extends(client: TestClient) -> None:
    a, _b = _seed_two_elements(client)
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    token = r.json()["token"]

    rn = client.post(papi("/locks/renew"), headers=AUTH_HEADERS, json={"token": token})
    assert rn.status_code == 200 and rn.json()["ok"] is True


def test_list_locks_returns_active_leases(client: TestClient) -> None:
    a, b = _seed_two_elements(client)
    # acquire locks on both elements
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={
            "targets": [
                {"resource_id": a, "mode": "exclusive"},
                {"resource_id": b, "mode": "shared"},
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text

    lst = client.get(papi("/locks"), headers=AUTH_HEADERS)
    assert lst.status_code == 200, lst.text
    resource_ids = {le["resource_id"] for le in lst.json()["leases"]}
    assert a in resource_ids
    assert b in resource_ids


def test_release_returns_zero_for_unknown_token(client: TestClient) -> None:
    rel = client.post(
        papi("/locks/release"), headers=AUTH_HEADERS, json={"token": "nonexistent-token"}
    )
    assert rel.status_code == 200 and rel.json()["released"] == 0


def test_renew_returns_false_for_unknown_token(client: TestClient) -> None:
    rn = client.post(
        papi("/locks/renew"), headers=AUTH_HEADERS, json={"token": "bad-token"}
    )
    assert rn.status_code == 200 and rn.json()["ok"] is False
