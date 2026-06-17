from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from data_rover.api.feed import reset_loop
from data_rover.api.locking import LockIntent, LockMode, RequiredLock
from data_rover.api.main import create_app
from data_rover.api.session import get_registry

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


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()  # each TestClient creates its own event loop; clear the cached one
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def feed_client() -> TestClient:
    """Client with a metamodel+model loaded, suitable for feed tests."""
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    ).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def _feed_url(user: str = "test-user") -> str:
    return papi(f"/feed?x-user-id={user}&x-user-email={user}@example.com")


def _lock(client: TestClient, rid: str) -> str:
    res = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": rid, "mode": "exclusive"}], "intent": "edit"},
    )
    assert res.status_code == 200, res.text
    return res.json()["token"]


def test_sweep_releases_expired_across_sessions(client) -> None:
    from data_rover.api.main import _sweep_expired_locks

    sess = get_registry().get("default")
    now = time.monotonic()
    sess.lock_table.acquire(
        "u1",
        [RequiredLock(resource_id="e1", mode=LockMode.EXCLUSIVE, intent=LockIntent.EDIT)],
        now=now,
        ttl=0.0,  # already expired
    )
    released = _sweep_expired_locks(now + 1.0)
    assert released >= 1
    assert sess.lock_table.active_leases(now + 1.0) == []


def test_sweep_does_not_bump_last_access(client) -> None:
    """_sweep_expired_locks must NOT refresh last_access on warm sessions —
    if it did, the idle-evict sweeper could never evict them."""
    from data_rover.api.main import _sweep_expired_locks

    sess = get_registry().get("default")
    before = sess.last_access
    now = time.monotonic()
    _sweep_expired_locks(now)
    # last_access must be unchanged (or at least not later than it was before
    # the sweep — a monotonic clock never goes backwards, so equality suffices
    # here; we just confirm the sweep didn't touch it).
    assert sess.last_access == before, (
        f"lock sweeper bumped last_access: was {before}, now {sess.last_access}"
    )


def test_sweep_does_not_hydrate_cold_project(client) -> None:
    """_sweep_expired_locks must NOT hydrate a project that is not warm.

    A cold project id absent from warm_items() must stay absent after a sweep —
    the sweeper must only visit sessions already in memory, never call
    registry.get() which would resurrect evicted sessions."""
    from data_rover.api.main import _idle_sweep_once, _sweep_expired_locks

    registry = get_registry()
    # Touch the default session (the client fixture called registry.get already
    # via the request path; call it explicitly to be certain it is warm).
    registry.get("default")
    assert "default" in registry.project_ids(), "setup: default must be warm"

    # Evict it so the session is cold (not in _sessions).
    _idle_sweep_once(now=time.monotonic() + 10_000, ttl=1.0)
    assert "default" not in registry.project_ids(), "setup: default must be evicted"

    # A project that was never hydrated also must not appear.
    cold_pid = "never-hydrated-project"
    assert cold_pid not in registry.project_ids()

    _sweep_expired_locks(time.monotonic())

    # Neither project should have been resurrected by the lock sweeper.
    assert "default" not in registry.project_ids(), (
        "lock sweeper resurrected an evicted session"
    )
    assert cold_pid not in registry.project_ids()


def test_sweep_expiry_broadcasts_lock_expired(feed_client: TestClient) -> None:
    """_sweep_expired_locks broadcasts lock{expired} on the feed for leases it
    drops, so connected peers learn which resources were freed."""
    from data_rover.api.main import _sweep_expired_locks

    # Create an element so we have a real resource id to lock.
    create = feed_client.post(
        papi("/model/ops"),
        json={
            "base_rev": feed_client.get(papi("/open")).json()["model_rev"],
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_1", "type_name": "Node", "properties": {}}
            ],
        },
    )
    assert create.status_code == 200, create.text
    eid = create.json()["id_map"]["tmp_1"]

    with feed_client.websocket_connect(_feed_url()) as ws:
        ws.receive_json()  # snapshot

        # Acquire a lease. After Task 6 is implemented, this also broadcasts
        # "acquired" — drain any intervening events in the loop below.
        _lock(feed_client, eid)

        # Sweep with a far-future now so the lease is definitely expired.
        _sweep_expired_locks(time.monotonic() + 10_000)

        # Drain events until we see the lock{expired} event.
        evt = ws.receive_json()
        while evt["type"] != "lock" or evt["action"] != "expired":
            evt = ws.receive_json()
        assert evt["leases"][0]["resource_id"] == eid
