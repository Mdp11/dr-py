from __future__ import annotations

from data_rover.api.locking import (
    LockIntent,
    LockMode,
    LockTable,
    RequiredLock,
)


def _ex(rid: str, intent: LockIntent = LockIntent.EDIT) -> RequiredLock:
    return RequiredLock(resource_id=rid, mode=LockMode.EXCLUSIVE, intent=intent)


def _sh(rid: str) -> RequiredLock:
    return RequiredLock(resource_id=rid, mode=LockMode.SHARED, intent=LockIntent.CONNECT)


def test_acquire_grants_and_returns_token() -> None:
    t = LockTable()
    token, leases, conflicts = t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    assert token and not conflicts
    assert [lease.resource_id for lease in leases] == ["e1"]


def test_exclusive_conflicts_with_other_holder_exclusive() -> None:
    t = LockTable()
    t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    token, leases, conflicts = t.acquire("u2", [_ex("e1")], now=1.0, ttl=300.0)
    assert token == "" and leases == []
    assert [c.resource_id for c in conflicts] == ["e1"]


def test_shared_pins_coexist() -> None:
    t = LockTable()
    t.acquire("u1", [_sh("e1")], now=0.0, ttl=300.0)
    token, _leases, conflicts = t.acquire("u2", [_sh("e1")], now=0.0, ttl=300.0)
    assert token and not conflicts  # many shared holders OK


def test_delete_conflicts_with_a_shared_pin() -> None:
    t = LockTable()
    t.acquire("u1", [_sh("e1")], now=0.0, ttl=300.0)  # someone connecting into e1
    _t, _l, conflicts = t.acquire(
        "u2", [_ex("e1", LockIntent.DELETE)], now=0.0, ttl=300.0
    )
    assert [c.resource_id for c in conflicts] == ["e1"]  # pin blocks delete


def test_nondelete_exclusive_coexists_with_shared_pin() -> None:
    t = LockTable()
    t.acquire("u1", [_sh("e1")], now=0.0, ttl=300.0)
    token, _l, conflicts = t.acquire("u2", [_ex("e1", LockIntent.EDIT)], now=0.0, ttl=300.0)
    assert token and not conflicts  # editing props vs incoming connect are compatible


def test_expiry_releases_and_then_reacquire_succeeds() -> None:
    t = LockTable()
    t.acquire("u1", [_ex("e1")], now=0.0, ttl=10.0)
    swept = t.sweep_expired(now=11.0)
    assert [s.resource_id for s in swept] == ["e1"]
    token, _l, conflicts = t.acquire("u2", [_ex("e1")], now=12.0, ttl=10.0)
    assert token and not conflicts


def test_renew_extends_ttl() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1")], now=0.0, ttl=10.0)
    assert t.renew("u1", token, now=9.0, ttl=10.0) is True
    assert t.sweep_expired(now=11.0) == []  # renewed to expire at 19.0
    assert t.sweep_expired(now=20.0)  # now expired


def test_steal_evicts_other_holder() -> None:
    t = LockTable()
    t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    token, leases, conflicts = t.acquire(
        "u2", [_ex("e1")], now=1.0, ttl=300.0, steal=True
    )
    assert token and not conflicts and [lease.holder for lease in leases] == ["u2"]
    # u1's lease is gone
    assert all(lease.holder == "u2" for lease in t.active_leases(now=1.0))


def test_verify_held_reports_missing() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    assert t.verify_held("u1", [token], [_ex("e1")], now=1.0) == []
    missing = t.verify_held("u1", [token], [_ex("e2")], now=1.0)
    assert [m.resource_id for m in missing] == ["e2"]


def test_verify_held_exclusive_covers_shared_requirement() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    assert t.verify_held("u1", [token], [_sh("e1")], now=1.0) == []


def test_release_drops_token_leases() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1"), _ex("e2")], now=0.0, ttl=300.0)
    released = t.release("u1", token)
    assert {r.resource_id for r in released} == {"e1", "e2"}
    assert t.active_leases(now=1.0) == []
