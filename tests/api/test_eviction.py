from __future__ import annotations

import time
from pathlib import Path


from data_rover.api import main
from data_rover.api.main import create_app
from data_rover.api.project_state import get_registry
from tests.api.conftest import (
    seed_default_project,
    install,
    head,
)

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def test_idle_sweep_evicts_stale_states_and_the_data_survives() -> None:
    seed_default_project()
    create_app()
    install(metamodel=MM, model=MODEL)
    get_registry().get("default")
    assert "default" in get_registry().project_ids()

    # sweep far in the future -> the state is stale -> evicted
    evicted = main._idle_sweep_once(now=time.monotonic() + 10_000, ttl=1.0)
    assert "default" in evicted
    assert "default" not in get_registry().project_ids()

    # data survives: it never lived in the state
    assert len(head().elements) > 0


def test_idle_sweep_keeps_fresh_states() -> None:
    seed_default_project()
    create_app()
    install(metamodel=MM, model=MODEL)
    get_registry().get("default")
    assert main._idle_sweep_once(now=time.monotonic(), ttl=10_000.0) == []
    assert "default" in get_registry().project_ids()


def test_idle_sweep_keeps_a_state_with_a_live_lease_or_a_feed_client() -> None:
    import asyncio
    import time as _time

    from data_rover.api.feed import ClientConn
    from data_rover.api.locking import LockIntent, LockMode, RequiredLock

    seed_default_project()
    create_app()
    install(metamodel=MM, model=MODEL)
    state = get_registry().get("default")
    token, _leases, _conflicts = state.lock_table.acquire(
        "u1",
        [RequiredLock("e1", LockMode.EXCLUSIVE, LockIntent.EDIT)],
        now=_time.monotonic(),
        ttl=300.0,
    )
    far = _time.monotonic() + 10_000
    # listed as idle, but kept: a lease is live
    assert main._idle_sweep_once(now=far, ttl=1.0) == ["default"]
    assert get_registry().peek("default") is state

    state.lock_table.release("u1", token)
    conn = ClientConn(user_id="bob", queue=asyncio.Queue())
    state.hub.register(conn)
    assert main._idle_sweep_once(now=far, ttl=1.0) == ["default"]
    assert get_registry().peek("default") is state  # a feed client is connected

    state.hub.unregister(conn)
    main._idle_sweep_once(now=far, ttl=1.0)
    assert get_registry().peek("default") is None
