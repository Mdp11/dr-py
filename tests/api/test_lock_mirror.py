"""Lease mirror (Phase 7, scoped): seam, clock conversion, write-through,
restore-on-hydrate, degradation. Redis itself is only touched by the
integration-marked test in test_lock_mirror_redis.py."""

from __future__ import annotations

import time
import time as _time

import pytest
from fastapi.testclient import TestClient

from data_rover.api.lock_mirror import (
    MemoryLeaseMirror,
    MirroredLease,
    NullLeaseMirror,
    build_mirror_from_settings,
    get_lease_mirror,
    set_lease_mirror,
    to_leases,
    to_mirrored,
)
from data_rover.api.locking import Lease, LockIntent, LockMode
from data_rover.api.main import create_app
from data_rover.api.session import reset_session
from data_rover.api.settings import Settings

from .conftest import AUTH_HEADERS, papi, seed_default_project


def _lease(rid: str = "e1", *, expires_at: float, token: str = "tok1") -> Lease:
    return Lease(
        resource_id=rid,
        mode=LockMode.EXCLUSIVE,
        holder="test-user",
        token=token,
        intent=LockIntent.EDIT,
        expires_at=expires_at,
        holder_email="test@example.com",
    )


def test_round_trip_preserves_identity_and_remaining_ttl() -> None:
    mono, wall = 1000.0, 5000.0
    src = _lease(expires_at=mono + 120.0)
    [m] = to_mirrored([src], mono_now=mono, wall_now=wall)
    assert m.expires_at_epoch == wall + 120.0
    assert (m.resource_id, m.mode, m.holder, m.token, m.intent, m.holder_email) == (
        "e1", "exclusive", "test-user", "tok1", "edit", "test@example.com",
    )
    # restore into a "restarted" process: different monotonic origin, +10s wall
    [back] = to_leases([m], mono_now=50.0, wall_now=wall + 10.0)
    assert back.expires_at == 50.0 + 110.0  # remaining shrank by wall elapsed
    assert back.token == "tok1" and back.mode is LockMode.EXCLUSIVE
    assert back.intent is LockIntent.EDIT and back.holder == "test-user"


def test_expired_entries_dropped_on_both_conversions() -> None:
    mono, wall = 1000.0, 5000.0
    assert to_mirrored([_lease(expires_at=mono - 1.0)], mono_now=mono, wall_now=wall) == []
    stale = MirroredLease("e1", "exclusive", "u", "t", "edit", wall - 1.0)
    assert to_leases([stale], mono_now=mono, wall_now=wall) == []


def test_memory_mirror_write_load_and_empty_deletes() -> None:
    m = MemoryLeaseMirror()
    lease = MirroredLease("e1", "exclusive", "u", "t", "edit", time.time() + 60)
    m.write("p1", [lease])
    assert m.load("p1") == [lease]
    m.write("p1", [])
    assert m.load("p1") == []
    assert m.load("never-written") == []


def test_null_mirror_is_inert() -> None:
    n = NullLeaseMirror()
    n.write("p1", [MirroredLease("e1", "exclusive", "u", "t", "edit", 1.0)])
    assert n.load("p1") == []


def test_build_from_settings_empty_url_is_null() -> None:
    s = Settings(redis_url="")
    assert isinstance(build_mirror_from_settings(s), NullLeaseMirror)


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
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def _create_element(c: TestClient) -> str:
    r = c.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(c),
            "ops": [{"kind": "create_element", "temp_id": "tmp_n",
                     "type_name": "Node", "properties": {}}],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_n"]


def _acquire(c: TestClient, eid: str) -> str:
    r = c.post(
        papi("/locks"),
        json={"targets": [{"resource_id": eid, "mode": "exclusive"}],
              "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_acquire_release_write_through(client: TestClient) -> None:
    eid = _create_element(client)
    token = _acquire(client, eid)
    mirrored = get_lease_mirror().load("default")
    assert [(m.resource_id, m.token, m.mode) for m in mirrored] == [
        (eid, token, "exclusive")
    ]
    r = client.post(papi("/locks/release"), json={"token": token})
    assert r.status_code == 200 and r.json()["released"] == 1
    assert get_lease_mirror().load("default") == []


def test_renew_write_through_extends_epoch(client: TestClient) -> None:
    eid = _create_element(client)
    _acquire(client, eid)
    [before] = get_lease_mirror().load("default")
    token = before.token
    r = client.post(papi("/locks/renew"), json={"token": token})
    assert r.status_code == 200 and r.json()["ok"] is True
    [after] = get_lease_mirror().load("default")
    # strict >: renew recomputes expiry from a LATER wall clock than acquire
    # did, so the mirrored epoch must strictly increase. If this were `>=`,
    # deleting the write-through call from renew_locks would still pass
    # (load() would just return the untouched acquire-time entry unchanged —
    # X >= X). Strict > is the only assertion that actually pins the wiring.
    assert after.expires_at_epoch > before.expires_at_epoch


def test_commit_release_write_through(client: TestClient) -> None:
    # stage an update to an existing element: needs an edit lease, and the
    # commit (sent the token) must release it in the mirror too
    eid = _create_element(client)
    token = _acquire(client, eid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "update_element", "id": eid,
                     "properties_patch": {}}],
            "message": "noop-ish edit",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert get_lease_mirror().load("default") == []


def test_mirror_failure_never_fails_the_route(client: TestClient) -> None:
    class ExplodingMirror:
        def write(self, project_id, leases):  # noqa: ANN001
            raise RuntimeError("redis is on fire")

        def load(self, project_id):  # noqa: ANN001
            raise RuntimeError("redis is on fire")

    eid = _create_element(client)
    set_lease_mirror(ExplodingMirror())
    token = _acquire(client, eid)  # 200 despite the exploding mirror
    r = client.post(papi("/locks/release"), json={"token": token})
    assert r.status_code == 200


OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _add_member(user_id: str, email: str) -> None:
    from data_rover.api import db as _db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = _db.get_db()
    s = next(gen)
    try:
        s.add(User(id=user_id, email=email))
        s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()


def test_leases_survive_restart(client: TestClient) -> None:
    """The point of the phase: acquire -> 'restart' -> same token still works,
    peers still conflict."""
    eid = _create_element(client)
    token = _acquire(client, eid)

    # simulate a backend restart: drop every in-memory session; the process-
    # global MemoryLeaseMirror survives (it plays the role of Redis)
    reset_session()

    # next request re-hydrates through the persistent loader -> restore
    r = client.post(papi("/locks/renew"), json={"token": token})
    assert r.status_code == 200 and r.json()["ok"] is True

    listed = client.get(papi("/locks")).json()["leases"]
    assert [(le["resource_id"], le["token"]) for le in listed] == [(eid, token)]

    # a peer editor still conflicts with the restored exclusive lease
    _add_member("user-2", "user2@example.com")
    r = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": eid, "mode": "exclusive"}],
              "intent": "edit"},
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 409, r.text
    assert r.json()["conflicts"][0]["resource_id"] == eid


def test_expired_mirrored_lease_not_restored(client: TestClient) -> None:
    eid = _create_element(client)
    _acquire(client, eid)
    # rewrite the mirror entry as long-expired, then "restart"
    get_lease_mirror().write(
        "default",
        [MirroredLease(eid, "exclusive", "test-user", "tok-old", "edit",
                       _time.time() - 5.0)],
    )
    reset_session()
    assert client.get(papi("/locks")).json()["leases"] == []


def test_restore_failure_degrades_to_cold_start(client: TestClient) -> None:
    class ExplodingLoad:
        def write(self, project_id, leases):  # noqa: ANN001
            return None

        def load(self, project_id):  # noqa: ANN001
            raise RuntimeError("redis is on fire")

    eid = _create_element(client)
    _acquire(client, eid)
    set_lease_mirror(ExplodingLoad())
    reset_session()
    # hydration succeeds; table is simply empty (today's cold start)
    assert client.get(papi("/locks")).json()["leases"] == []
