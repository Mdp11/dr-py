"""Realtime feed plumbing (Phase 5). A per-``Session`` ``FeedHub`` fans
server-side events out to connected WebSocket clients.

The mutation path is SYNCHRONOUS (threadpool + write_mutex); WebSockets are
ASYNC. ``broadcast`` bridges the two by enqueuing onto each client's bounded
``asyncio.Queue`` via ``loop.call_soon_threadsafe`` — a non-blocking call that
is therefore safe to make while holding the write_mutex. A client whose queue
overflows (cannot keep up) is dropped and told to close; it reconnects and
re-syncs from the next snapshot. This module is intentionally dependency-free
(no DB, no schemas) so ``session.py`` can import it without pulling in the
persistence stack.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field
from typing import Any

#: Pushed onto a client queue to tell its sender pump to close the socket
#: (used when the client fell behind and was dropped).
CLOSE_SENTINEL: Any = object()

#: The running event loop, captured lazily on the first WebSocket connect
#: (the WS endpoint runs inside the loop). ``broadcast`` needs it to schedule
#: cross-thread enqueues; with no connected clients it is never needed.
_loop: asyncio.AbstractEventLoop | None = None


def set_loop_if_unset(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    if _loop is None:
        _loop = loop


def get_loop() -> asyncio.AbstractEventLoop | None:
    return _loop


def reset_loop() -> None:
    """Test isolation — forget the captured loop."""
    global _loop
    _loop = None


@dataclass(eq=False)
class ClientConn:
    """One connected feed subscriber. ``eq=False`` keeps identity-hashing so a
    conn can live in the hub's ``set`` (queues are not hashable)."""

    user_id: str
    queue: "asyncio.Queue[Any]"


@dataclass
class FeedHub:
    """Per-session set of connected clients with sync, thread-safe broadcast."""

    _conns: set[ClientConn] = field(default_factory=set)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def register(self, conn: ClientConn) -> None:
        with self._lock:
            self._conns.add(conn)

    def unregister(self, conn: ClientConn) -> None:
        with self._lock:
            self._conns.discard(conn)

    def connected_user_ids(self) -> list[str]:
        with self._lock:
            return sorted({c.user_id for c in self._conns})

    def has_clients(self) -> bool:
        with self._lock:
            return bool(self._conns)

    def broadcast(self, event: dict[str, Any]) -> None:
        """Enqueue ``event`` for every connected client. Safe to call from any
        thread (and while holding the write_mutex): the actual enqueue runs on
        the event-loop thread via ``call_soon_threadsafe`` and never blocks."""
        loop = get_loop()
        if loop is None:
            return  # no client has ever connected -> nothing to deliver
        with self._lock:
            conns = tuple(self._conns)
        for conn in conns:
            loop.call_soon_threadsafe(self._deliver, conn, event)

    def _deliver(self, conn: ClientConn, event: dict[str, Any]) -> None:
        """Loop-thread callback: enqueue, or drop+close a client that fell
        behind (drain its queue, then push the close sentinel so the sender
        pump wakes and closes the socket)."""
        try:
            conn.queue.put_nowait(event)
        except asyncio.QueueFull:
            while not conn.queue.empty():
                conn.queue.get_nowait()
            conn.queue.put_nowait(CLOSE_SENTINEL)
            self.unregister(conn)


# --- event builders (plain dicts; serialized by ws.send_json) --------------


def snapshot_event(
    *, model_rev: int, locks: list[dict[str, Any]], connected: list[str]
) -> dict[str, Any]:
    return {
        "type": "snapshot",
        "model_rev": model_rev,
        "locks": locks,
        "connected": connected,
    }


def commit_event(
    *,
    rev: int,
    commit_id: str,
    author_id: str,
    message: str,
    validation_error_count: int,
    changed_elements: list[dict[str, Any]],
    changed_relationships: list[dict[str, Any]],
    deleted_element_ids: list[str],
    deleted_relationship_ids: list[str],
) -> dict[str, Any]:
    return {
        "type": "commit",
        "rev": rev,
        "commit_id": commit_id,
        "author_id": author_id,
        "message": message,
        "validation_error_count": validation_error_count,
        "changed_elements": changed_elements,
        "changed_relationships": changed_relationships,
        "deleted_element_ids": deleted_element_ids,
        "deleted_relationship_ids": deleted_relationship_ids,
    }


def lock_event(action: str, leases: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "lock", "action": action, "leases": leases}


def presence_event(
    action: str, user_id: str, connected: list[str]
) -> dict[str, Any]:
    return {
        "type": "presence",
        "action": action,
        "user_id": user_id,
        "connected": connected,
    }
