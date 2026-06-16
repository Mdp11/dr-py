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


def test_default_project_id_is_a_nonempty_str() -> None:
    assert DEFAULT_PROJECT_ID == "default"


def test_project_ids_lists_live_sessions() -> None:
    reg = SessionRegistry()
    reg.get("a")
    reg.get("b")
    assert reg.project_ids() == ["a", "b"]
    reg.evict("a")
    assert reg.project_ids() == ["b"]
