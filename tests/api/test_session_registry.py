from __future__ import annotations

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
