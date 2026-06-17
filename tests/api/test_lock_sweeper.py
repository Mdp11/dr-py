from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from data_rover.api.locking import LockIntent, LockMode, RequiredLock
from data_rover.api.main import create_app
from data_rover.api.session import get_registry

from .conftest import AUTH_HEADERS, seed_default_project


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


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
