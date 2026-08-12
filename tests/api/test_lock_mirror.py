"""Lease mirror (Phase 7, scoped): seam, clock conversion, write-through,
restore-on-hydrate, degradation. Redis itself is only touched by the
integration-marked test in test_lock_mirror_redis.py."""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from data_rover.api.lock_mirror import (
    MemoryLeaseMirror,
    MirroredLease,
    NullLeaseMirror,
    build_mirror_from_settings,
    get_lease_mirror,
    lease_key,
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


def test_to_leases_clamps_remaining_to_max() -> None:
    # backward wall-clock jump between mirror-write and restore: the entry
    # claims 900s remaining but a lease can never legitimately outlive the
    # TTL it was granted with
    m = MirroredLease("e1", "exclusive", "u", "t", "edit", 5000.0 + 900.0)
    [le] = to_leases([m], mono_now=100.0, wall_now=5000.0, max_remaining_s=300.0)
    assert le.expires_at == 100.0 + 300.0


def test_to_leases_no_clamp_by_default_and_ignores_nonpositive_cap() -> None:
    m = MirroredLease("e1", "exclusive", "u", "t", "edit", 5000.0 + 900.0)
    [default] = to_leases([m], mono_now=100.0, wall_now=5000.0)
    assert default.expires_at == 100.0 + 900.0
    # a 0 TTL means "TTL disabled" elsewhere in settings — it must mean
    # "no cap" here too, never "drop every restored lease"
    [uncapped] = to_leases([m], mono_now=100.0, wall_now=5000.0, max_remaining_s=0.0)
    assert uncapped.expires_at == 100.0 + 900.0


def test_restore_leases_clamps_to_lock_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    # end-to-end wiring: restore_leases must pass settings.lock_ttl_seconds
    # as the cap
    from data_rover.api.lock_mirror import restore_leases
    from data_rover.api.locking import LockTable

    monkeypatch.setenv("DATA_ROVER_LOCK_TTL_SECONDS", "60")
    mirror = MemoryLeaseMirror()
    mirror.write(
        "p1",
        [MirroredLease("e1", "exclusive", "u", "t", "edit", time.time() + 900.0)],
    )
    set_lease_mirror(mirror)
    try:
        table = LockTable()
        restore_leases("p1", table)
        now = time.monotonic()
        [le] = table.active_leases(now)
        assert le.expires_at - now <= 60.0 + 1.0  # clamped, +1s slop
    finally:
        set_lease_mirror(None)


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


def test_get_lease_mirror_sticky_fallback_on_build_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A build failure (bad DATA_ROVER_REDIS_URL, unimportable ``redis``)
    must be memoized: the second call must return the SAME Null fallback
    instance rather than re-attempting (and re-logging) the broken build,
    which would spam a traceback on every acquire/release/renew/commit and
    every cold hydration forever.

    Counts calls to the module's ``logger.warning`` directly rather than
    using ``caplog``: ``alembic.command.upgrade`` (exercised by
    test_alembic.py, which can run earlier in the same session) calls
    ``logging.config.fileConfig``, whose default ``disable_existing_loggers``
    permanently disables every logger not in its own config — including this
    module's — for the rest of the process. That is an unrelated pytest-
    ordering hazard, not a variable of what this test is pinning, so the
    counting stub sidesteps it entirely instead of racing it."""
    import data_rover.api.lock_mirror as lm

    call_count = 0

    def _boom(settings):  # noqa: ANN001
        nonlocal call_count
        call_count += 1
        raise RuntimeError("boom: bad DATA_ROVER_REDIS_URL")

    warn_calls: list[object] = []
    monkeypatch.setattr(lm, "build_mirror_from_settings", _boom)
    monkeypatch.setattr(lm.logger, "warning", lambda *a, **kw: warn_calls.append(a))
    set_lease_mirror(None)  # force the rebuild path this test exercises
    try:
        first = get_lease_mirror()
        second = get_lease_mirror()
        assert isinstance(first, NullLeaseMirror)
        assert first is second  # same fallback instance -> no per-call retry
        assert call_count == 1  # build was attempted exactly once, not twice
        assert len(warn_calls) == 1  # logged once, not once per call
    finally:
        set_lease_mirror(None)  # process-global singleton: reset for other tests


def test_build_from_settings_redis_url_is_redis_mirror() -> None:
    # Pins the single line that decides whether the feature is on in
    # production. redis.Redis.from_url on a valid scheme constructs lazily —
    # no socket is opened — so this is hermetic even though the port refuses
    # connections (same dead-port address the degradation test above uses).
    from data_rover.api.lock_mirror_redis import RedisLeaseMirror

    s = Settings(redis_url="redis://127.0.0.1:1/0")
    assert isinstance(build_mirror_from_settings(s), RedisLeaseMirror)


def test_lease_key_prefix() -> None:
    assert lease_key("p1") == "dr:leases:p1"
    assert lease_key("p1", prefix="site-a:") == "site-a:dr:leases:p1"


def test_build_from_settings_wires_key_prefix() -> None:
    from data_rover.api.lock_mirror_redis import RedisLeaseMirror

    s = Settings(redis_url="redis://127.0.0.1:1/0", redis_key_prefix="site-a:")
    mirror = build_mirror_from_settings(s)
    assert isinstance(mirror, RedisLeaseMirror)
    assert mirror._key("p1") == "site-a:dr:leases:p1"


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


def test_write_throughs_are_serialized_in_snapshot_order() -> None:
    """B-3: snapshot+write are atomic w.r.t. each other, so a slow earlier
    write-through can never land AFTER a later one and leave the mirror
    holding a released lease (the restart-phantom source). Deterministic, not
    a race reproduction: the first write blocks on a gate; the second
    write-through must wait for it rather than overtake it."""
    from data_rover.api.lock_mirror import mirror_session_leases
    from data_rover.api.session import Session

    class GatedRecordingMirror:
        def __init__(self) -> None:
            self.writes: list[list[MirroredLease]] = []
            self.entered = threading.Event()
            self.gate = threading.Event()
            self._first = True

        def write(self, project_id: str, leases: list[MirroredLease]) -> None:
            if self._first:
                self._first = False
                self.entered.set()
                assert self.gate.wait(timeout=5)
            self.writes.append(list(leases))

        def load(self, project_id: str) -> list[MirroredLease]:
            return []

    mirror = GatedRecordingMirror()
    set_lease_mirror(mirror)
    try:
        session = Session()
        lease = _lease(expires_at=time.monotonic() + 60.0)
        session.lock_table.seed([lease])

        t1 = threading.Thread(
            target=mirror_session_leases, args=("p1", session), daemon=True
        )
        t1.start()
        assert mirror.entered.wait(timeout=5)  # t1 snapshotted {lease}, now gated

        # a later mutation + write-through: must queue behind t1, not overtake
        with session.write_mutex:
            session.lock_table.release("test-user", lease.token)
        t2 = threading.Thread(
            target=mirror_session_leases, args=("p1", session), daemon=True
        )
        t2.start()
        assert not mirror.gate.is_set()
        mirror.gate.set()
        t1.join(timeout=5)
        t2.join(timeout=5)
        assert not t1.is_alive() and not t2.is_alive()

        # in-order: the release's (empty) snapshot landed LAST — the mirror
        # ends holding truth, not the phantom
        assert [len(w) for w in mirror.writes] == [1, 0]
    finally:
        set_lease_mirror(None)


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
                       time.time() - 5.0)],
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


def test_unreachable_redis_degrades_without_raising() -> None:
    from data_rover.api.lock_mirror_redis import RedisLeaseMirror

    # port 1 refuses instantly; cooldown makes the second call a pure no-op
    mirror = RedisLeaseMirror("redis://127.0.0.1:1/0", socket_timeout_s=0.2)
    lease = MirroredLease("e1", "exclusive", "u", "t", "edit", time.time() + 60)
    mirror.write("p1", [lease])   # must not raise
    assert mirror.load("p1") == []  # must not raise
    mirror.write("p1", [lease])   # inside cooldown: skipped, still no raise


def test_concurrent_calls_use_a_single_lock_for_transition_bookkeeping() -> None:
    # NOT a race-reproduction test (see the module's design note on why one
    # isn't practical here): this pins the STRUCTURAL invariant the fix
    # relies on -- _mark_down/_mark_up/_in_cooldown all take the SAME lock
    # instance around the read-check-write of `_down`/`_down_until`, so two
    # concurrent callers can never interleave through that region. A thread
    # holding the lock (simulated by acquiring it directly) must make a
    # second, concurrent _mark_down() call block until released rather than
    # run through -- proving the critical section is really guarded, not
    # just plausibly guarded by inspection.
    from data_rover.api.lock_mirror_redis import RedisLeaseMirror

    mirror = RedisLeaseMirror("redis://127.0.0.1:1/0", socket_timeout_s=0.2)
    entered = threading.Event()
    done = threading.Event()

    def worker() -> None:
        entered.set()
        mirror._mark_down(RuntimeError("boom"))  # must block on the held lock
        done.set()

    # daemon=True: if an assertion below fails before the lock is released,
    # the process must still be able to exit rather than hang forever on a
    # non-daemon thread blocked acquiring _state_lock.
    t = threading.Thread(target=worker, daemon=True)
    mirror._state_lock.acquire()  # simulate "inside the critical section"
    try:
        t.start()
        assert entered.wait(timeout=2)
        # The worker is blocked acquiring _state_lock; it must NOT have
        # finished.
        assert not done.wait(timeout=0.2)
    finally:
        mirror._state_lock.release()
    t.join(timeout=2)
    assert done.is_set()  # released -> the worker's call completed
