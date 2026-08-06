"""Typed lock resources: artifact leases share the LockTable with element
leases under a namespace, never containment-expand, and no longer block
metamodel rebinds (only bare model-resource leases do)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db as _db
from data_rover.api.db_models import Role, User
from data_rover.api.locking import (
    ARTIFACT_PREFIX,
    METAMODEL_RESOURCE,
    artifact_resource,
    is_model_resource,
)
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

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

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str) -> None:
    """Add *user_id* as an editor of the default project (mirrors
    ``test_locks_route.py``'s helper of the same name) so a second-holder
    conflict test exercises ``acquire_locks``' 409 path rather than authz's
    403-non-member rejection."""
    gen = _db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def test_resource_helpers() -> None:
    assert artifact_resource("abc") == "art:abc"
    assert is_model_resource("some-element-id")
    assert not is_model_resource(ARTIFACT_PREFIX + "abc")
    assert not is_model_resource("folder:xyz")
    assert not is_model_resource(METAMODEL_RESOURCE)


def test_acquire_artifact_lock_roundtrip(client: TestClient) -> None:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    leases = r.json()["leases"]
    assert [le["resource_id"] for le in leases] == ["art:art-1"]


def test_artifact_delete_lock_does_not_containment_expand(client: TestClient) -> None:
    # DELETE intent on an element expands to its subtree; on an artifact it
    # must stay a single resource (dangling refs are tolerated, no cascade).
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "delete",
        },
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["leases"]) == 1


def test_second_user_conflicts_on_same_artifact(client: TestClient) -> None:
    _seed_second_member(OTHER_HEADERS["x-user-id"], OTHER_HEADERS["x-user-email"])
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200
    r2 = client.post(
        papi("/locks"),
        headers=OTHER_HEADERS,
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r2.status_code == 409
    assert r2.json()["conflicts"][0]["resource_id"] == "art:art-1"


def test_rebind_ignores_artifact_leases(client: TestClient) -> None:
    # an artifact lease is live; rebind must proceed (artifacts degrade
    # tolerantly under a retyped metamodel — spec, locking section)
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "art-1", "mode": "exclusive", "type": "artifact"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200
    rev = client.get(papi("/model/summary")).json()["model_rev"]
    r = client.post(
        papi(f"/metamodel/rebind?base_rev={rev}"),
        content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
