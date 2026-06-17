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
