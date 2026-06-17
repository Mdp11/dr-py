from __future__ import annotations

import asyncio

from data_rover.api.feed import ClientConn
from data_rover.api.session import Session, SessionRegistry


def test_session_has_feed_hub() -> None:
    s = Session()
    assert s.hub.has_clients() is False


def test_evict_skipped_while_clients_connected() -> None:
    reg = SessionRegistry()
    evicted: list[str] = []
    reg.set_evict_hook(lambda pid, sess: evicted.append(pid))
    s = reg.get("p1")  # hydrate empty session
    s.hub.register(ClientConn(user_id="bob", queue=asyncio.Queue()))
    reg.evict("p1")
    assert evicted == []  # not evicted: a client is connected
    assert "p1" in reg.project_ids()
