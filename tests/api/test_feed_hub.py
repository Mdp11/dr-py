from __future__ import annotations

import asyncio

import pytest

from data_rover.api import feed
from data_rover.api.feed import ClientConn, FeedHub


@pytest.fixture(autouse=True)
def _reset_loop() -> "object":
    feed.reset_loop()
    yield
    feed.reset_loop()


def _conn(user_id: str, maxsize: int = 8) -> ClientConn:
    return ClientConn(user_id=user_id, queue=asyncio.Queue(maxsize=maxsize))


def test_connected_user_ids_dedupes_and_sorts() -> None:
    hub = FeedHub()
    hub.register(_conn("bob"))
    hub.register(_conn("alice"))
    hub.register(_conn("alice"))
    assert hub.connected_user_ids() == ["alice", "bob"]


def test_unregister_and_has_clients() -> None:
    hub = FeedHub()
    c = _conn("bob")
    hub.register(c)
    assert hub.has_clients() is True
    hub.unregister(c)
    assert hub.has_clients() is False


def test_deliver_enqueues_event() -> None:
    hub = FeedHub()
    c = _conn("bob")
    hub.register(c)
    hub._deliver(c, {"type": "ping"})
    assert c.queue.get_nowait() == {"type": "ping"}


def test_deliver_on_full_queue_drops_and_closes() -> None:
    hub = FeedHub()
    c = _conn("bob", maxsize=1)
    hub.register(c)
    c.queue.put_nowait({"type": "stale"})  # queue now full
    hub._deliver(c, {"type": "fresh"})
    # connection dropped from the hub...
    assert hub.has_clients() is False
    # ...and the sender is told to close (stale event drained first)
    assert c.queue.get_nowait() is feed.CLOSE_SENTINEL


def test_broadcast_without_loop_is_noop() -> None:
    hub = FeedHub()
    c = _conn("bob")
    hub.register(c)
    hub.broadcast({"type": "ping"})  # no loop set -> nothing scheduled
    assert c.queue.empty()


def test_event_builders_shapes() -> None:
    assert feed.presence_event("join", "bob", ["bob"]) == {
        "type": "presence",
        "action": "join",
        "user_id": "bob",
        "connected": ["bob"],
    }
    assert feed.lock_event("acquired", [{"resource_id": "e1"}]) == {
        "type": "lock",
        "action": "acquired",
        "leases": [{"resource_id": "e1"}],
    }
    snap = feed.snapshot_event(model_rev=3, locks=[], connected=["bob"])
    assert snap["type"] == "snapshot" and snap["model_rev"] == 3
    commit = feed.commit_event(
        rev=4,
        commit_id="c1",
        author_id="bob",
        message="msg",
        validation_error_count=0,
        changed_elements=[{"id": "e1"}],
        changed_relationships=[],
        deleted_element_ids=[],
        deleted_relationship_ids=[],
    )
    assert commit["type"] == "commit" and commit["rev"] == 4
    assert commit["changed_elements"] == [{"id": "e1"}]
