"""Tests for the lock acquire/release/renew/list endpoints (Phase 4).

POST /locks, POST /locks/release, POST /locks/renew, GET /locks.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db as _db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

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


def test_acquire_and_list_leases_carry_holder_email(client: TestClient) -> None:
    """Every lease surfaced to the client must carry the holder's email so the UI
    can render "Locked by <email>" instead of the opaque user id."""
    a, _b = _seed_two_elements(client)
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    leases = r.json()["leases"]
    assert leases and all(le["holder_email"] == "test@example.com" for le in leases)

    lst = client.get(papi("/locks"), headers=AUTH_HEADERS)
    assert lst.status_code == 200, lst.text
    by_id = {le["resource_id"]: le for le in lst.json()["leases"]}
    assert by_id[a]["holder_email"] == "test@example.com"


def test_conflict_reports_holder_email(client: TestClient) -> None:
    """A 409 lock conflict must name the current holder by email, not just id."""
    U2_ID = "u2"
    U2_EMAIL = "u2@example.com"
    U2_HEADERS = {"X-User-Id": U2_ID, "X-User-Email": U2_EMAIL}
    _seed_second_member(U2_ID, U2_EMAIL)

    a, _b = _seed_two_elements(client)
    body = {"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"}

    first = client.post(papi("/locks"), headers=AUTH_HEADERS, json=body)
    assert first.status_code == 200, first.text

    second = client.post(papi("/locks"), headers=U2_HEADERS, json=body)
    assert second.status_code == 409, second.text
    conflicts = second.json()["conflicts"]
    assert conflicts and conflicts[0]["held_by_email"] == "test@example.com"


def test_lock_conflict_returns_403_for_non_member(client: TestClient) -> None:
    """A non-member trying to acquire a lock must get 403 from authz.

    The default conftest seeds only TEST_USER_ID as owner; u2 is not a member,
    so the authz middleware raises 403 before the lock logic is reached.
    """
    a, _b = _seed_two_elements(client)
    body = {"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"}

    first = client.post(papi("/locks"), headers=AUTH_HEADERS, json=body)
    assert first.status_code == 200, first.text

    # u2 is not a project member → 403 from require_membership.
    other_headers = {"X-User-Id": "u2", "X-User-Email": "u2@x"}
    second = client.post(papi("/locks"), headers=other_headers, json=body)
    assert second.status_code == 403, (
        f"Expected 403 (non-member must be rejected), got {second.status_code}: {second.text}"
    )


def _seed_second_member(user_id: str, email: str) -> None:
    """Add *user_id* as an editor of the default project using the tenancy layer.

    Mirrors ``seed_default_project`` in conftest.py: opens the shared in-memory
    DB session, upserts the user row, then calls ``add_member`` which handles
    both insert and update.
    """
    gen = _db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()


def test_lock_conflict_returns_409_for_second_member(client: TestClient) -> None:
    """A second *member* acquiring an EXCLUSIVE lock on an already-locked resource
    must receive 409 with a non-empty ``conflicts`` list naming the resource.

    The LockTable's same-holder exemption means we MUST use a truly distinct user
    id for the second request; we seed u2 as an editor of the default project so
    the authz layer lets the request through and the conflict is handled by
    ``acquire_locks`` returning 409.
    """
    U2_ID = "u2"
    U2_EMAIL = "u2@example.com"
    U2_HEADERS = {"X-User-Id": U2_ID, "X-User-Email": U2_EMAIL}

    _seed_second_member(U2_ID, U2_EMAIL)

    a, _b = _seed_two_elements(client)
    body = {"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"}

    # User 1 acquires the exclusive lock first.
    first = client.post(papi("/locks"), headers=AUTH_HEADERS, json=body)
    assert first.status_code == 200, first.text

    # User 2 (a different member) attempts the same exclusive lock → 409 conflict.
    second = client.post(papi("/locks"), headers=U2_HEADERS, json=body)
    assert second.status_code == 409, (
        f"Expected 409 (lock conflict for second member), "
        f"got {second.status_code}: {second.text}"
    )
    data = second.json()
    conflicts = data.get("conflicts", [])
    assert len(conflicts) > 0, "409 response must include a non-empty 'conflicts' list"
    conflict_resource_ids = {c["resource_id"] for c in conflicts}
    assert a in conflict_resource_ids, (
        f"Expected locked resource {a!r} in conflicts, got {conflict_resource_ids}"
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
