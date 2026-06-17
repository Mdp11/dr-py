from __future__ import annotations

import threading

from data_rover.api.session import (
    DEFAULT_PROJECT_ID,
    Session,
    SessionRegistry,
)


def test_get_creates_session_on_first_access() -> None:
    reg = SessionRegistry()
    assert isinstance(reg.get("p1"), Session)


def test_get_returns_same_instance_for_same_id() -> None:
    reg = SessionRegistry()
    assert reg.get("p1") is reg.get("p1")


def test_distinct_ids_get_distinct_sessions() -> None:
    reg = SessionRegistry()
    assert reg.get("p1") is not reg.get("p2")


def test_sessions_are_isolated() -> None:
    reg = SessionRegistry()
    reg.get("p1").model_rev = 5
    assert reg.get("p2").model_rev == 0


def test_evict_drops_session_so_next_get_is_fresh() -> None:
    reg = SessionRegistry()
    first = reg.get("p1")
    reg.evict("p1")
    assert reg.get("p1") is not first


def test_evict_unknown_id_is_noop() -> None:
    reg = SessionRegistry()
    reg.evict("never-created")  # must not raise


def test_reset_drops_all_sessions() -> None:
    reg = SessionRegistry()
    first = reg.get("p1")
    reg.reset()
    assert reg.get("p1") is not first


def test_default_project_id_is_default() -> None:
    assert DEFAULT_PROJECT_ID == "default"


def test_project_ids_lists_live_sessions() -> None:
    reg = SessionRegistry()
    reg.get("a")
    reg.get("b")
    assert reg.project_ids() == ["a", "b"]
    reg.evict("a")
    assert reg.project_ids() == ["b"]


def test_get_session_returns_default_project_session() -> None:
    from data_rover.api.session import (
        DEFAULT_PROJECT_ID,
        get_registry,
        get_session,
        reset_session,
    )

    reset_session()
    assert get_session() is get_registry().get(DEFAULT_PROJECT_ID)


def test_get_session_is_stable_across_calls() -> None:
    from data_rover.api.session import get_session, reset_session

    reset_session()
    assert get_session() is get_session()


def test_reset_session_clears_all_projects() -> None:
    from data_rover.api.session import get_registry, get_session, reset_session

    reset_session()
    before = get_session()
    get_registry().get("other").model_rev = 9
    reset_session()
    assert get_session() is not before
    assert get_registry().get("other").model_rev == 0


def test_get_request_session_resolves_path_project() -> None:
    from data_rover.api.db_models import Membership, Role
    from data_rover.api.deps import get_request_session
    from data_rover.api.session import get_registry, reset_session

    reset_session()
    # require_membership is the auth gate (Depends-injected); calling
    # get_request_session directly with a stub membership exercises only the
    # registry resolution (full auth is covered by test_authz.py).
    stub = Membership(user_id="u", project_id="proj-a", role=Role.owner)
    assert get_request_session("proj-a", stub) is get_registry().get("proj-a")


def test_get_uses_loader_once_per_project() -> None:
    calls: list[str] = []

    def loader(pid: str) -> Session:
        calls.append(pid)
        return Session(model_rev=42)

    reg = SessionRegistry()
    reg.set_loader(loader)
    a = reg.get("p1")
    b = reg.get("p1")
    assert a is b and a.model_rev == 42
    assert calls == ["p1"]  # loaded once, then cached


def test_loader_init_once_under_concurrency() -> None:
    # The barrier is in the WORKER (not the loader) so all 8 threads race into
    # reg.get() simultaneously. The key-lock inside get() serialises them: only
    # 1 thread can call the loader; the other 7 re-check _sessions after
    # acquiring the lock and find the cached session, so calls==1.
    calls: list[str] = []
    barrier = threading.Barrier(8)

    def loader(pid: str) -> Session:
        calls.append(pid)
        return Session()

    reg = SessionRegistry()
    reg.set_loader(loader)
    out: list[Session] = []

    def worker() -> None:
        barrier.wait()  # sync all 8 threads before the first get()
        out.append(reg.get("p1"))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1  # init-once guard held
    assert all(s is out[0] for s in out)


def test_evict_runs_snapshot_hook_then_drops() -> None:
    evicted: list[str] = []
    reg = SessionRegistry()
    reg.set_loader(lambda pid: Session(model_rev=1))
    reg.set_evict_hook(lambda pid, sess: evicted.append(pid))
    reg.get("p1")
    reg.evict("p1")
    assert evicted == ["p1"]
    assert reg.project_ids() == []


def test_evict_hook_skipped_when_nothing_to_persist() -> None:
    reg = SessionRegistry()
    reg.set_evict_hook(lambda pid, sess: (_ for _ in ()).throw(AssertionError("called")))
    reg.evict("absent")  # no session -> hook not called, no error


def test_idle_lists_stale_projects() -> None:
    reg = SessionRegistry()
    reg.set_loader(lambda pid: Session())
    reg.get("p1")
    reg.touch("p1")
    assert reg.idle(now=1000.0, ttl=10.0) == []  # just touched (last_access ~ monotonic)


def test_evict_skips_session_with_live_locks() -> None:
    import time as _time

    from data_rover.api.locking import LockIntent, LockMode, RequiredLock
    from data_rover.api.session import Session, SessionRegistry

    evicted: list[str] = []
    reg = SessionRegistry()
    reg.set_loader(lambda pid: Session())
    reg.set_evict_hook(lambda pid, s: evicted.append(pid))

    sess = reg.get("p1")
    sess.lock_table.acquire(
        "u1",
        [RequiredLock(resource_id="e1", mode=LockMode.EXCLUSIVE, intent=LockIntent.EDIT)],
        now=_time.monotonic(),
        ttl=300.0,
    )
    reg.evict("p1")
    assert evicted == []  # refused: live lease held
    assert "p1" in reg.project_ids()
