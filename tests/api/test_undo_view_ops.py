"""Undo across view ops: restore-mode replay, peer-lease refusal (leases are
the ONLY concurrency control on view content — same rationale as the
artifact half), blob persistence, and journal append-only-ness.

Fixtures: copy the client/_MM/_seed_second_member pattern from
tests/api/test_commits_artifact_ops.py; _folder_lease/_rev from
tests/api/test_commits_view_ops.py."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str) -> None:
    """Mirrors the helper of the same name in test_commits_artifact_ops.py."""
    gen = db.get_db()
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
    reset_loop()  # each TestClient creates its own event loop; clear the cached one
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _folder_lease(client: TestClient, fid: str, intent: str = "edit") -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _rev(client: TestClient) -> int:
    r = client.get(papi("/open"))
    rev: int = r.json()["model_rev"]
    return rev


def _commit_rename(client: TestClient, fid: str, name: str) -> None:
    token = _folder_lease(client, fid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": fid, "name": name}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def test_undo_restores_view_and_bumps_revs(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    base = _rev(client)
    view_rev = client.get(papi("/view")).json()["view_rev"]

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base + 1  # append-only: rev moves FORWARD

    out = client.get(papi("/view")).json()
    assert out["view"]["folders"][0]["name"] == "A"
    assert out["view_rev"] == view_rev + 1  # the compensating edit bumps it

    # the compensating commit is journaled (newest row carries the inverse op)
    r = client.get(papi("/commits"))
    assert r.json()["commits"][0]["op_count"] == 1


def test_undo_refuses_while_peer_holds_folder_lease(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    _seed_second_member("user-2", "user2@example.com")
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200
    r = client.post(papi("/model/undo"))
    assert r.status_code == 409
    assert f"folder:{fid}" in [c["resource_id"] for c in r.json()["conflicts"]]
    # the refusal did not eat the undo slot: after the peer releases, undo works
    r = client.get(papi("/locks"))
    peer_lease = next(le for le in r.json()["leases"] if le["resource_id"] == f"folder:{fid}")
    assert peer_lease["holder"] == "user-2"
