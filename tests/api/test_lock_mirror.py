"""Lease mirror (Phase 7, scoped): seam, clock conversion, write-through,
restore-on-hydrate, degradation. Redis itself is only touched by the
integration-marked test in test_lock_mirror_redis.py."""

from __future__ import annotations

import time

from data_rover.api.lock_mirror import (
    MemoryLeaseMirror,
    MirroredLease,
    NullLeaseMirror,
    build_mirror_from_settings,
    to_leases,
    to_mirrored,
)
from data_rover.api.locking import Lease, LockIntent, LockMode
from data_rover.api.settings import Settings


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
