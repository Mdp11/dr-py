# Phase 5 Realtime Feed (WebSocket) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-way server→client WebSocket feed that broadcasts commit deltas, lock-state changes, and minimal presence, plus a thin SvelteKit client transport store that consumes it — without touching the existing editing path.

**Architecture:** A per-`Session` `FeedHub` holds connected clients, each with a bounded `asyncio.Queue` drained by a sender coroutine. The synchronous mutation path (commit route, lock routes, lock sweeper) broadcasts by enqueuing via `loop.call_soon_threadsafe(...)`, so it never blocks. A new `@router.websocket("/feed")` authenticates through the existing `IdentityProvider` seam (extended to read the WS handshake), sends an initial snapshot, then streams events. The client store reduces lock/presence events into reactive state and applies commit deltas through the existing `applyDelta`.

**Tech Stack:** Python 3.14 / FastAPI 0.115 / Starlette WebSockets / SQLAlchemy 2.0 (sync). SvelteKit + Svelte 5 runes / Vitest + happy-dom. pixi for every command.

## Global Constraints

- **Toolchain:** every command goes through `pixi run` — there is no global `python`/`node`. Backend tests: `pixi run -e core-dev pytest <path>`. Frontend: `pixi run -e frontend npm test`, `pixi run -e frontend npm run check`.
- **Three checkers must pass** for Python: `pixi run lint-backend` runs ruff + mypy + pyright. Frontend: `pixi run -e frontend npm run check` (svelte-check) + lint.
- **Python version gotcha:** runtime is 3.14 but pyright floor is 3.10 — import `Self`/`assert_never`/etc. from `typing_extensions`, not `typing`. Use `from __future__ import annotations` (every module here does).
- **Store convention (frontend):** state lives in `*.svelte.ts` modules exposed as **accessor functions** (`getX()`/`setX()`), never exported `$state` bindings. Match `state/ui.svelte.ts`.
- **API tests need no DB service:** `tests/api/conftest.py` forces in-memory SQLite + `MemorySnapshotStore` + disabled sweepers. Use the `AUTH_HEADERS`, `papi`, `seed_default_project` helpers.
- **Docs are gitignored** (`docs/superpowers/**`); do not `git add` plan/spec files.
- **Commit message footer:** end every commit body with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Spec:** `docs/superpowers/specs/2026-06-17-phase-5-realtime-feed-design.md`.

---

## File Structure

**Backend (create):**
- `src/data_rover/api/feed.py` — `FeedHub`, `ClientConn`, event builders, loop handle. Dependency-free (no DB/schemas imports) so `session.py` can import it.
- `src/data_rover/api/routes/feed.py` — the `@router.websocket("/feed")` endpoint + sender pump.

**Backend (modify):**
- `src/data_rover/api/identity.py` — retype `identify` to `HTTPConnection`; dev provider reads query-param fallback.
- `src/data_rover/api/session.py` — `Session.hub` field; `SessionRegistry.evict` guard.
- `src/data_rover/api/settings.py` — `feed_queue_max`.
- `src/data_rover/api/routes/commits.py` — broadcast `commit` + `lock{released}` on commit.
- `src/data_rover/api/routes/locks.py` — broadcast `lock{acquired|released}`.
- `src/data_rover/api/main.py` — mount the feed router; broadcast `lock{expired}` from the sweeper.
- `pixi.toml` — add the `websockets` runtime dep (uvicorn WS support).

**Frontend (create):**
- `src/lib/api/feed.ts` — WS connection wrapper (injectable socket factory + reconnect/backoff) + `FeedEvent` types.
- `src/lib/state/realtime.svelte.ts` — feed store: `connected`, `presence`, `lockState`, commit-delta application.

**Frontend (modify):**
- `src/lib/state/index.ts` — re-export the realtime store accessors.
- `src/lib/components/StatusBar.svelte` — connection dot + presence count.
- `src/routes/+page.svelte` — start/stop the feed on mount/unmount.
- `vite.config.ts` — `ws: true` on the `/api/v1` proxy.

**Tests (create):**
- `tests/api/test_feed_ws.py` — connect/auth/snapshot/presence/commit/lock integration tests.
- `tests/api/test_feed_hub.py` — `FeedHub` unit tests (enqueue/drop/presence/event builders).
- `frontend/src/lib/api/__tests__/feed.test.ts` — connection wrapper with a fake socket.
- `frontend/src/lib/state/__tests__/realtime.test.ts` — store reducers + commit application.

---

## Task 1: Identity seam reads the WebSocket handshake

**Files:**
- Modify: `src/data_rover/api/identity.py`
- Test: `tests/api/test_identity_ws.py` (create)

**Interfaces:**
- Produces: `IdentityProvider.identify(conn: HTTPConnection) -> Identity`; `DevHeaderIdentityProvider.identify` accepts a `WebSocket` and falls back to query params keyed by the same header names (`settings.identity_user_header` / `identity_email_header`).

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_identity_ws.py`:

```python
"""DevHeaderIdentityProvider must work over a WebSocket handshake (query params)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from data_rover.api.identity import DevHeaderIdentityProvider


def _app() -> FastAPI:
    app = FastAPI()
    provider = DevHeaderIdentityProvider("x-user-id", "x-user-email")

    @app.websocket("/probe")
    async def probe(ws: WebSocket) -> None:
        identity = provider.identify(ws)
        await ws.accept()
        await ws.send_json({"user_id": identity.user_id, "email": identity.email})
        await ws.close()

    return app


def test_identify_reads_query_params_on_ws() -> None:
    client = TestClient(_app())
    with client.websocket_connect(
        "/probe?x-user-id=alice&x-user-email=alice@example.com"
    ) as ws:
        assert ws.receive_json() == {"user_id": "alice", "email": "alice@example.com"}


def test_identify_missing_identity_raises() -> None:
    client = TestClient(_app())
    with pytest.raises(Exception):
        with client.websocket_connect("/probe") as ws:
            ws.receive_json()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_identity_ws.py -v`
Expected: FAIL — current `identify` reads only `request.headers`, so the query-param connect returns nothing / errors on type.

- [ ] **Step 3: Implement the seam change**

In `src/data_rover/api/identity.py`: change the import and signatures from `Request` to `HTTPConnection` (the shared base of `Request` and `WebSocket`; both expose `.headers` and `.query_params`). `get_current_user` keeps its `Request` parameter (a `Request` *is* an `HTTPConnection`).

Replace the import line:

```python
from fastapi import Depends, HTTPException
from starlette.requests import HTTPConnection, Request
```

Change the Protocol and dev provider:

```python
class IdentityProvider(Protocol):
    def identify(self, conn: HTTPConnection) -> Identity: ...


class DevHeaderIdentityProvider:
    """Trusts identity headers (HTTP) or query params (WebSocket handshakes,
    which browsers cannot attach custom headers to). Dev/gateway use only —
    never trust these on an endpoint reachable directly by untrusted clients."""

    def __init__(self, user_header: str, email_header: str) -> None:
        self._user_header = user_header
        self._email_header = email_header

    def identify(self, conn: HTTPConnection) -> Identity:
        user_id = conn.headers.get(self._user_header) or conn.query_params.get(
            self._user_header
        )
        if not user_id:
            raise HTTPException(status_code=401, detail="missing identity")
        email = conn.headers.get(self._email_header) or conn.query_params.get(
            self._email_header, ""
        )
        return Identity(user_id=user_id, email=email)
```

Leave `get_current_user(request: Request, ...)` as-is (it passes `request` to `identify`, still valid).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_identity_ws.py -v`
Expected: PASS (both tests).

- [ ] **Step 5: Run the existing identity/authz tests + linters**

Run: `pixi run -e core-dev pytest tests/api/test_authz.py -q && pixi run lint-backend`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/identity.py tests/api/test_identity_ws.py
git commit -m "$(cat <<'EOF'
feat(api): identity seam reads WebSocket handshake (query-param fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `FeedHub` + event builders (pure, dependency-free)

**Files:**
- Create: `src/data_rover/api/feed.py`
- Test: `tests/api/test_feed_hub.py`

**Interfaces:**
- Produces:
  - `ClientConn(user_id: str, queue: asyncio.Queue[Any])` (dataclass, `eq=False` so it is hashable by identity).
  - `FeedHub` with `register(conn)`, `unregister(conn)`, `connected_user_ids() -> list[str]`, `has_clients() -> bool`, `broadcast(event: dict) -> None`, and `_deliver(conn, event) -> None` (loop-thread callback; drop+close on overflow).
  - Module loop handle: `set_loop_if_unset(loop)`, `get_loop() -> AbstractEventLoop | None`, `reset_loop()` (test isolation).
  - Sentinel `CLOSE_SENTINEL` (enqueued to tell a sender pump to close).
  - Event builders: `snapshot_event(*, model_rev, locks, connected)`, `commit_event(*, rev, commit_id, author_id, message, validation_error_count, changed_elements, changed_relationships, deleted_element_ids, deleted_relationship_ids)`, `lock_event(action, leases)`, `presence_event(action, user_id, connected)` — all return plain `dict`s.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_feed_hub.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_feed_hub.py -v`
Expected: FAIL — `data_rover.api.feed` does not exist.

- [ ] **Step 3: Implement `feed.py`**

Create `src/data_rover/api/feed.py`:

```python
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

    def register(self, conn: ClientConn) -> None:
        self._conns.add(conn)

    def unregister(self, conn: ClientConn) -> None:
        self._conns.discard(conn)

    def connected_user_ids(self) -> list[str]:
        return sorted({c.user_id for c in self._conns})

    def has_clients(self) -> bool:
        return bool(self._conns)

    def broadcast(self, event: dict[str, Any]) -> None:
        """Enqueue ``event`` for every connected client. Safe to call from any
        thread (and while holding the write_mutex): the actual enqueue runs on
        the event-loop thread via ``call_soon_threadsafe`` and never blocks."""
        loop = get_loop()
        if loop is None:
            return  # no client has ever connected -> nothing to deliver
        for conn in list(self._conns):
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_feed_hub.py -v`
Expected: PASS (all cases).

- [ ] **Step 5: Lint**

Run: `pixi run lint-backend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/feed.py tests/api/test_feed_hub.py
git commit -m "$(cat <<'EOF'
feat(api): FeedHub + event builders for the realtime feed (Phase 5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire the hub into `Session`, settings, and the eviction guard

**Files:**
- Modify: `src/data_rover/api/session.py`
- Modify: `src/data_rover/api/settings.py`
- Test: `tests/api/test_feed_session.py` (create)

**Interfaces:**
- Consumes: `FeedHub` from Task 2.
- Produces: `Session.hub: FeedHub`; `Settings.feed_queue_max: int = 256`; `SessionRegistry.evict` refuses while `session.hub.has_clients()`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_feed_session.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_feed_session.py -v`
Expected: FAIL — `Session` has no `hub`; evict ignores clients.

- [ ] **Step 3: Add the `hub` field**

In `src/data_rover/api/session.py`, add the import near the `LockTable` import:

```python
from .feed import FeedHub
from .locking import LockTable
```

Add the field to the `Session` dataclass (after `lock_table`):

```python
    #: per-project realtime feed subscribers (Phase 5). Populated by the WS
    #: endpoint; broadcast to at the commit/lock sites. The eviction guard
    #: refuses to drop a session while it has connected clients.
    hub: FeedHub = field(default_factory=FeedHub, repr=False)
```

- [ ] **Step 4: Extend the eviction guard**

In `SessionRegistry.evict`, change the live-lease guard to also refuse while clients are connected:

```python
            if (
                session.lock_table.active_leases(time.monotonic())
                or session.hub.has_clients()
            ):
                # A holder still has a check-out open, or a feed client is
                # connected. The session was never removed, so it stays
                # registered — no re-insert needed.
                return
```

- [ ] **Step 5: Add the setting**

In `src/data_rover/api/settings.py`, add after `lock_sweep_seconds`:

```python
    #: bounded per-client feed queue. A client whose queue overflows is dropped
    #: and reconnects (Phase 5). Large enough to absorb a burst of commits.
    feed_queue_max: int = 256
```

- [ ] **Step 6: Run the test + the eviction suite**

Run: `pixi run -e core-dev pytest tests/api/test_feed_session.py tests/api/test_eviction.py -v`
Expected: PASS.

- [ ] **Step 7: Lint**

Run: `pixi run lint-backend`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/session.py src/data_rover/api/settings.py tests/api/test_feed_session.py
git commit -m "$(cat <<'EOF'
feat(api): Session.hub + feed_queue_max + evict-guard for connected clients

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: WebSocket endpoint — connect, authz, snapshot, presence

**Files:**
- Create: `src/data_rover/api/routes/feed.py`
- Modify: `src/data_rover/api/main.py` (mount the router)
- Modify: `pixi.toml` (add `websockets` so the real uvicorn server speaks WS)
- Test: `tests/api/test_feed_ws.py` (create — connect/auth/snapshot/presence cases)

**Interfaces:**
- Consumes: `FeedHub`/`ClientConn`/`set_loop_if_unset`/`CLOSE_SENTINEL`/`snapshot_event`/`presence_event` (Task 2), `Session.hub` (Task 3), `get_identity_provider` (Task 1), `get_registry`, `get_db`, `get_membership`, `upsert_user`, `Project`.
- Produces: `GET (WebSocket) /api/v1/projects/{project_id}/feed`. Close codes: `4401` unauthenticated, `4403` non-member, `4404` unknown project, `4408` dropped-behind.

- [ ] **Step 1: Add the `websockets` runtime dependency**

In `pixi.toml`, in the dependency table that holds `fastapi`/`uvicorn` (the `api` feature deps), add:

```toml
websockets = "13.*"
```

Then run `pixi install` (or `pixi run -e core-dev python -c "import websockets"` to confirm it resolves). Expected: resolves without error. (Starlette's `TestClient.websocket_connect` works at the ASGI level without this package, but the real `uvicorn` server needs it to accept WS upgrades.)

- [ ] **Step 2: Write the failing test**

Create `tests/api/test_feed_ws.py`:

```python
"""WebSocket feed endpoint (Phase 5): connect, authz, snapshot, presence."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

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
    assert c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    ).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def _feed_url(user: str = "test-user") -> str:
    # browsers cannot set headers on a WS handshake -> identity via query params
    return papi(f"/feed?x-user-id={user}&x-user-email={user}@example.com")


def test_connect_receives_snapshot(client: TestClient) -> None:
    with client.websocket_connect(_feed_url()) as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot"
        assert snap["model_rev"] == 1
        assert snap["connected"] == ["test-user"]
        assert snap["locks"] == []


def test_second_client_sees_presence_join(client: TestClient) -> None:
    with client.websocket_connect(_feed_url("test-user")) as ws1:
        ws1.receive_json()  # own snapshot
        with client.websocket_connect(_feed_url("test-user")) as ws2:
            ws2.receive_json()  # ws2 snapshot
            # ws1 is told someone joined
            evt = ws1.receive_json()
            assert evt["type"] == "presence" and evt["action"] == "join"


def test_unknown_project_closes_4404(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    url = "/api/v1/projects/nope/feed?x-user-id=test-user"
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(url) as ws:
            ws.receive_json()
    assert exc.value.code == 4404


def test_missing_identity_closes_4401(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(papi("/feed")) as ws:
            ws.receive_json()
    assert exc.value.code == 4401
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_feed_ws.py -v`
Expected: FAIL — no `/feed` route (connection refused / 403).

- [ ] **Step 4: Implement the endpoint**

Create `src/data_rover/api/routes/feed.py`:

```python
"""WebSocket realtime feed (Phase 5 spec §3.2).

One socket per subscriber. On connect: authenticate via the IdentityProvider
seam (query-param identity in dev — browsers can't set WS headers), authorize
against Membership, register in the project ``Session.hub``, broadcast a
presence-join, send the initial snapshot, then pump the per-client queue to the
socket until disconnect. We never expect inbound application messages; the
receive loop exists only to observe the client closing.
"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from ..feed import CLOSE_SENTINEL, ClientConn, presence_event, set_loop_if_unset, snapshot_event
from ..db import get_db
from ..db_models import Project
from ..identity import get_identity_provider
from ..session import get_registry
from ..settings import get_settings
from ..tenancy import get_membership, upsert_user

router = APIRouter()


def _lease_dicts(session: "object", now: float) -> list[dict]:
    from ..session import Session  # local: avoid a router import cycle

    assert isinstance(session, Session)
    return [
        {"resource_id": le.resource_id, "mode": le.mode.value, "holder_id": le.holder}
        for le in session.lock_table.active_leases(now)
    ]


@router.websocket("/feed")
async def feed_ws(websocket: WebSocket, project_id: str) -> None:
    # The endpoint runs inside the event loop; capture it for cross-thread
    # broadcasts from the (synchronous) commit/lock paths.
    set_loop_if_unset(asyncio.get_running_loop())

    # --- authenticate + authorize over a short-lived DB session ------------
    db_gen = get_db()
    db = next(db_gen)
    try:
        try:
            identity = get_identity_provider().identify(websocket)
        except Exception:
            await websocket.close(code=4401)
            return
        user = upsert_user(db, identity.user_id, identity.email)
        if db.get(Project, project_id) is None:
            await websocket.close(code=4404)
            return
        if get_membership(db, user.id, project_id) is None:
            await websocket.close(code=4403)
            return
        user_id = user.id
    finally:
        db_gen.close()

    session = get_registry().get(project_id)
    session.last_access = time.monotonic()

    await websocket.accept()
    conn = ClientConn(
        user_id=user_id,
        queue=asyncio.Queue(maxsize=get_settings().feed_queue_max),
    )
    session.hub.register(conn)
    session.hub.broadcast(
        presence_event("join", user_id, session.hub.connected_user_ids())
    )
    await websocket.send_json(
        snapshot_event(
            model_rev=session.model_rev,
            locks=_lease_dicts(session, time.monotonic()),
            connected=session.hub.connected_user_ids(),
        )
    )

    pump = asyncio.create_task(_pump(websocket, conn))
    try:
        while True:
            await websocket.receive_text()  # raises on disconnect; ignore payloads
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        session.hub.unregister(conn)
        session.hub.broadcast(
            presence_event("leave", user_id, session.hub.connected_user_ids())
        )


async def _pump(websocket: WebSocket, conn: ClientConn) -> None:
    """Drain the client's queue to the socket; close on the drop sentinel."""
    while True:
        event = await conn.queue.get()
        if event is CLOSE_SENTINEL:
            await websocket.close(code=4408)
            return
        await websocket.send_json(event)
```

- [ ] **Step 5: Mount the router**

In `src/data_rover/api/main.py`, add `feed` to the `from .routes import (...)` block and mount it after `commits` in `create_app`:

```python
    app.include_router(feed.router, prefix=proj, tags=["feed"])
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_feed_ws.py -v`
Expected: PASS (all four cases).

- [ ] **Step 7: Lint**

Run: `pixi run lint-backend`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/routes/feed.py src/data_rover/api/main.py pixi.toml pixi.lock tests/api/test_feed_ws.py
git commit -m "$(cat <<'EOF'
feat(api): WebSocket feed endpoint — authz, snapshot, presence (Phase 5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Broadcast commit deltas (+ lock release) on commit

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_feed_ws.py` (add a commit-broadcast case)

**Interfaces:**
- Consumes: `feed.commit_event`, `feed.lock_event`, `session.hub` (Tasks 2–3); the existing `CommitResponse` fields in `create_commit`.
- Produces: a `commit` event (and a `lock{released}` event when the commit released leases) broadcast to the project after a successful commit.

- [ ] **Step 1: Write the failing test (append to `tests/api/test_feed_ws.py`)**

Add these helpers + test:

```python
def _etype(client: TestClient) -> str:
    types = client.get(papi("/metamodel/element-types")).json()
    return types[0]["name"] if isinstance(types, list) else "Node"


def _lock(client: TestClient, rid: str) -> str:
    res = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": rid, "mode": "exclusive"}], "intent": "edit"},
    )
    assert res.status_code == 200, res.text
    return res.json()["token"]


def test_commit_broadcasts_delta_to_feed(client: TestClient) -> None:
    # seed one element so we have something to lock+update
    create = client.post(
        papi("/model/ops"),
        json={
            "base_rev": client.get(papi("/open")).json()["model_rev"],
            "ops": [
                {"op": "create_element", "temp_id": "tmp_1", "type": "Node", "properties": {}}
            ],
        },
    )
    assert create.status_code == 200, create.text
    eid = create.json()["id_map"]["tmp_1"]

    with client.websocket_connect(_feed_url()) as ws:
        ws.receive_json()  # snapshot
        rev = client.get(papi("/open")).json()["model_rev"]
        token = _lock(client, eid)
        # ws sees the lock acquired event (Task 6 also asserts this; harmless here)
        evt = ws.receive_json()
        while evt["type"] != "lock":
            evt = ws.receive_json()
        commit = client.post(
            papi("/commits"),
            json={
                "base_rev": rev,
                "ops": [{"op": "update_element", "id": eid, "properties": {"name": "x"}}],
                "message": "rename",
                "lock_tokens": [token],
            },
        )
        assert commit.status_code == 200, commit.text
        # the committed delta arrives on the feed
        seen = ws.receive_json()
        while seen["type"] != "commit":
            seen = ws.receive_json()
        assert seen["message"] == "rename"
        assert any(e["id"] == eid for e in seen["changed_elements"])
        assert seen["rev"] == commit.json()["model_rev"]
```

(If `/metamodel/element-types` is not the exact read route, the `_etype` helper is unused here — the test hardcodes `"Node"` from `_MM`. Keep `_etype` only if a later test needs it; otherwise drop it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_feed_ws.py::test_commit_broadcasts_delta_to_feed -v`
Expected: FAIL — no `commit` event ever arrives (broadcast not wired), so `receive_json` times out / loops.

- [ ] **Step 3: Implement the broadcast in `create_commit`**

In `src/data_rover/api/routes/commits.py`, import the feed builders at the top:

```python
from ..feed import commit_event, lock_event
```

Inside `create_commit`, capture released leases in step (g) and broadcast after the `with session.write_mutex:` block. Change step (g) to collect what it releases:

```python
        # g. release the caller's locks (explicit loop — no helper)
        released = []
        for tok in payload.lock_tokens:
            released.extend(session.lock_table.release(user.id, tok))
```

Then, AFTER the `with session.write_mutex:` block and BEFORE building/returning `CommitResponse`, broadcast (the model is already mutated and rev-bumped; enqueue is non-blocking):

```python
    changed_elements = [
        ElementOut.from_core(model.elements[eid]).model_dump()
        for eid in res.changed_element_ids
    ]
    changed_relationships = [
        RelationshipOut.from_core(model.relationships[rid]).model_dump()
        for rid in res.changed_relationship_ids
    ]
    session.hub.broadcast(
        commit_event(
            rev=session.model_rev,
            commit_id=commit_id,
            author_id=user.id,
            message=payload.message,
            validation_error_count=len(conformance),
            changed_elements=changed_elements,
            changed_relationships=changed_relationships,
            deleted_element_ids=list(res.deleted_element_ids),
            deleted_relationship_ids=list(res.deleted_relationship_ids),
        )
    )
    if released:
        session.hub.broadcast(
            lock_event(
                "released",
                [
                    {"resource_id": le.resource_id, "mode": le.mode.value, "holder_id": le.holder}
                    for le in released
                ],
            )
        )
```

Reuse `changed_elements`/`changed_relationships` in the `CommitResponse` return by constructing the `ElementOut`/`RelationshipOut` lists as before (the existing return block already builds `ElementOut.from_core(...)`; leave it — the `.model_dump()` versions above are separate locals for the event). Note `conformance` and `commit_id` are already in scope from earlier in the function.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_feed_ws.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full commit-route suite + lint**

Run: `pixi run -e core-dev pytest tests/api/test_commits_route.py -q && pixi run lint-backend`
Expected: PASS (commit behaviour unchanged; broadcast is additive).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_feed_ws.py
git commit -m "$(cat <<'EOF'
feat(api): broadcast commit delta + lock release on the realtime feed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Broadcast lock acquire/release + sweeper expiry

**Files:**
- Modify: `src/data_rover/api/routes/locks.py`
- Modify: `src/data_rover/api/main.py` (sweeper broadcasts expiries)
- Test: `tests/api/test_feed_ws.py` (lock-event cases), `tests/api/test_lock_sweeper.py` (expiry broadcast — add a case)

**Interfaces:**
- Consumes: `feed.lock_event`, `session.hub`.
- Produces: `lock{acquired}` on `POST /locks`, `lock{released}` on `POST /locks/release`, `lock{expired}` from `_sweep_expired_locks`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_feed_ws.py`:

```python
def test_lock_acquire_broadcasts(client: TestClient) -> None:
    create = client.post(
        papi("/model/ops"),
        json={
            "base_rev": client.get(papi("/open")).json()["model_rev"],
            "ops": [
                {"op": "create_element", "temp_id": "tmp_1", "type": "Node", "properties": {}}
            ],
        },
    )
    eid = create.json()["id_map"]["tmp_1"]
    with client.websocket_connect(_feed_url()) as ws:
        ws.receive_json()  # snapshot
        token = _lock(client, eid)
        evt = ws.receive_json()
        while evt["type"] != "lock":
            evt = ws.receive_json()
        assert evt["action"] == "acquired"
        assert evt["leases"][0]["resource_id"] == eid
        client.post(papi("/locks/release"), json={"token": token})
        rel = ws.receive_json()
        while rel["type"] != "lock":
            rel = ws.receive_json()
        assert rel["action"] == "released"
```

Add a sweeper-expiry broadcast test in `tests/api/test_lock_sweeper.py` (follow the existing file's fixture style; it builds an app and acquires a lease, then sweeps with a future `now`). The new assertion: connect a feed socket, acquire a lease, call `_sweep_expired_locks(now=<far future>)`, and assert a `lock{expired}` event arrives. Use the module's existing helpers; mirror `test_commit_broadcasts_delta_to_feed`'s receive-until-`lock` loop.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_feed_ws.py::test_lock_acquire_broadcasts -v`
Expected: FAIL — no lock events broadcast yet.

- [ ] **Step 3: Broadcast from the lock routes**

In `src/data_rover/api/routes/locks.py`, import the builder and add a small lease→dict helper, then broadcast after acquire/release.

Add import:

```python
from ..feed import lock_event
```

Add near `_lease_out`:

```python
def _lease_event_dicts(leases: list[Lease]) -> list[dict]:
    return [
        {"resource_id": le.resource_id, "mode": le.mode.value, "holder_id": le.holder}
        for le in leases
    ]
```

In `acquire_locks`, after the conflict check passes (just before the success `return`):

```python
    session.hub.broadcast(lock_event("acquired", _lease_event_dicts(leases)))
    return LockResponse(token=token, leases=[_lease_out(le) for le in leases])
```

In `release_locks`, broadcast the released set:

```python
    with session.write_mutex:
        released = session.lock_table.release(user.id, payload.token)
    if released:
        session.hub.broadcast(lock_event("released", _lease_event_dicts(released)))
    return {"released": len(released)}
```

(`renew_locks` does NOT broadcast — a TTL extension changes no peer-visible lock state.)

- [ ] **Step 4: Broadcast expiries from the sweeper**

In `src/data_rover/api/main.py`, update `_sweep_expired_locks` to broadcast per session whose leases expired. Add the import at the top:

```python
from .feed import lock_event
```

Change the loop body:

```python
def _sweep_expired_locks(now: float) -> int:
    released = 0
    for _pid, session in get_registry().warm_items():
        with session.write_mutex:
            expired = session.lock_table.sweep_expired(now)
        if expired:
            session.hub.broadcast(
                lock_event(
                    "expired",
                    [
                        {"resource_id": le.resource_id, "mode": le.mode.value, "holder_id": le.holder}
                        for le in expired
                    ],
                )
            )
        released += len(expired)
    return released
```

(The broadcast is outside the `write_mutex` block — enqueue is non-blocking and needs no mutex.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_feed_ws.py tests/api/test_lock_sweeper.py -v`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `pixi run lint-backend`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/locks.py src/data_rover/api/main.py tests/api/test_feed_ws.py tests/api/test_lock_sweeper.py
git commit -m "$(cat <<'EOF'
feat(api): broadcast lock acquire/release/expire on the realtime feed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend feed connection wrapper

**Files:**
- Create: `frontend/src/lib/api/feed.ts`
- Test: `frontend/src/lib/api/__tests__/feed.test.ts`

**Interfaces:**
- Produces:
  - Types `FeedEvent` (union of `snapshot`/`commit`/`lock`/`presence`), `LeaseLite { resource_id; mode; holder_id }`.
  - `WebSocketLike` (minimal interface: `addEventListener`, `close`, `readyState`) for injection.
  - `connectFeed(config: FeedConfig): FeedConnection` where `FeedConfig = { onEvent; onStatus; url?; socketFactory?; reconnect? }` and `FeedConnection = { close(): void }`.
  - `defaultFeedUrl(): string` — derives `ws(s)://<host>/api/v1/projects/default/feed?...` from `window.location` + dev identity.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/api/__tests__/feed.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectFeed, type FeedEvent, type WebSocketLike } from '../feed';

class FakeSocket implements WebSocketLike {
	readyState = 0;
	listeners: Record<string, ((e: unknown) => void)[]> = {};
	closed = false;
	static last: FakeSocket | null = null;
	constructor(public url: string) {
		FakeSocket.last = this;
	}
	addEventListener(type: string, cb: (e: unknown) => void): void {
		(this.listeners[type] ??= []).push(cb);
	}
	close(): void {
		this.closed = true;
		this.emit('close', {});
	}
	emit(type: string, e: unknown): void {
		for (const cb of this.listeners[type] ?? []) cb(e);
	}
	open(): void {
		this.readyState = 1;
		this.emit('open', {});
	}
	message(data: unknown): void {
		this.emit('message', { data: JSON.stringify(data) });
	}
}

afterEach(() => vi.restoreAllMocks());

describe('connectFeed', () => {
	it('reports open status and parses events', () => {
		const events: FeedEvent[] = [];
		const statuses: boolean[] = [];
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: (e) => events.push(e),
			onStatus: (s) => statuses.push(s)
		});
		const sock = FakeSocket.last!;
		sock.open();
		sock.message({ type: 'presence', action: 'join', user_id: 'bob', connected: ['bob'] });
		expect(statuses).toEqual([true]);
		expect(events[0]).toMatchObject({ type: 'presence', user_id: 'bob' });
	});

	it('reconnects after an unexpected close', () => {
		vi.useFakeTimers();
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			reconnect: { baseMs: 10, maxMs: 100 }
		});
		const first = FakeSocket.last!;
		first.open();
		first.emit('close', {});
		vi.advanceTimersByTime(10);
		expect(FakeSocket.last).not.toBe(first); // a new socket was created
		vi.useRealTimers();
	});

	it('close() stops reconnection', () => {
		vi.useFakeTimers();
		const conn = connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			reconnect: { baseMs: 10, maxMs: 100 }
		});
		const first = FakeSocket.last!;
		first.open();
		conn.close();
		first.emit('close', {});
		vi.advanceTimersByTime(1000);
		expect(FakeSocket.last).toBe(first); // no reconnect after explicit close
		vi.useRealTimers();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend npx vitest run src/lib/api/__tests__/feed.test.ts`
(from `frontend/`; or `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/feed.test.ts'`)
Expected: FAIL — `../feed` does not exist.

- [ ] **Step 3: Implement `feed.ts`**

Create `frontend/src/lib/api/feed.ts`:

```ts
/**
 * One-way realtime feed client (Phase 5). Opens a WebSocket to the project
 * feed, auto-reconnects with exponential backoff, and hands parsed events to a
 * callback. Pure transport — no app state. The socket is injectable
 * (`socketFactory`) so tests can drive it without a real server.
 */

export interface LeaseLite {
	resource_id: string;
	mode: string;
	holder_id: string;
}

export type FeedEvent =
	| { type: 'snapshot'; model_rev: number; locks: LeaseLite[]; connected: string[] }
	| {
			type: 'commit';
			rev: number;
			commit_id: string;
			author_id: string;
			message: string;
			validation_error_count: number;
			changed_elements: unknown[];
			changed_relationships: unknown[];
			deleted_element_ids: string[];
			deleted_relationship_ids: string[];
	  }
	| { type: 'lock'; action: 'acquired' | 'released' | 'expired'; leases: LeaseLite[] }
	| { type: 'presence'; action: 'join' | 'leave'; user_id: string; connected: string[] };

export interface WebSocketLike {
	readyState: number;
	addEventListener(type: string, cb: (e: unknown) => void): void;
	close(): void;
}

export interface FeedConfig {
	onEvent: (e: FeedEvent) => void;
	onStatus: (connected: boolean) => void;
	url?: string;
	socketFactory?: (url: string) => WebSocketLike;
	reconnect?: { baseMs: number; maxMs: number };
}

export interface FeedConnection {
	close(): void;
}

// Single-user dev identity, mirroring api/client.ts DEV_IDENTITY_HEADERS.
const DEV_USER = 'default-user';
const DEV_EMAIL = 'dev@example.com';

export function defaultFeedUrl(): string {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const q = `x-user-id=${encodeURIComponent(DEV_USER)}&x-user-email=${encodeURIComponent(DEV_EMAIL)}`;
	return `${proto}//${location.host}/api/v1/projects/default/feed?${q}`;
}

export function connectFeed(config: FeedConfig): FeedConnection {
	const url = config.url ?? defaultFeedUrl();
	const factory = config.socketFactory ?? ((u: string) => new WebSocket(u) as WebSocketLike);
	const base = config.reconnect?.baseMs ?? 500;
	const max = config.reconnect?.maxMs ?? 10_000;

	let stopped = false;
	let attempt = 0;
	let sock: WebSocketLike | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function open(): void {
		if (stopped) return;
		const s = factory(url);
		sock = s;
		s.addEventListener('open', () => {
			attempt = 0;
			config.onStatus(true);
		});
		s.addEventListener('message', (e) => {
			const data = (e as MessageEvent).data as string;
			try {
				config.onEvent(JSON.parse(data) as FeedEvent);
			} catch {
				/* ignore malformed frames */
			}
		});
		s.addEventListener('close', () => {
			config.onStatus(false);
			if (stopped) return;
			const delay = Math.min(max, base * 2 ** attempt);
			attempt += 1;
			timer = setTimeout(open, delay);
		});
		s.addEventListener('error', () => {
			/* close fires after error; reconnect handled there */
		});
	}

	open();

	return {
		close(): void {
			stopped = true;
			if (timer) clearTimeout(timer);
			sock?.close();
		}
	};
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/feed.test.ts'`
Expected: PASS (all three cases).

- [ ] **Step 5: Type-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no svelte-check errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/feed.ts frontend/src/lib/api/__tests__/feed.test.ts
git commit -m "$(cat <<'EOF'
feat(frontend): realtime feed WebSocket connection wrapper (Phase 5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Frontend realtime store (presence / lock state / commit deltas)

**Files:**
- Create: `frontend/src/lib/state/realtime.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (re-export accessors)
- Test: `frontend/src/lib/state/__tests__/realtime.test.ts`

**Interfaces:**
- Consumes: `connectFeed`, `FeedEvent`, `LeaseLite` (Task 7); `applyDelta`, `getIssueCounts`, `refreshSummary` from `state/model.svelte`.
- Produces accessor API: `startRealtime(config?)`, `stopRealtime()`, `getFeedConnected(): boolean`, `getPresence(): string[]`, `getLockState(): Map<string, LeaseLite>`, `getLockFor(id): LeaseLite | undefined`, and a test seam `handleFeedEvent(e)` exported for unit tests.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/realtime.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
	getLockFor,
	getLockState,
	getPresence,
	handleFeedEvent,
	resetRealtime
} from '../realtime.svelte';
import { getCachedElements, resetModelStore, seedElements } from '../model.svelte';

beforeEach(() => {
	resetRealtime();
	resetModelStore();
});

describe('realtime store reducers', () => {
	it('tracks presence from snapshot + presence events', () => {
		handleFeedEvent({ type: 'snapshot', model_rev: 1, locks: [], connected: ['a'] });
		expect(getPresence()).toEqual(['a']);
		handleFeedEvent({ type: 'presence', action: 'join', user_id: 'b', connected: ['a', 'b'] });
		expect(getPresence()).toEqual(['a', 'b']);
	});

	it('reduces lock acquired/released into lockState', () => {
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'a' }]
		});
		expect(getLockFor('e1')?.holder_id).toBe('a');
		handleFeedEvent({
			type: 'lock',
			action: 'released',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'a' }]
		});
		expect(getLockState().has('e1')).toBe(false);
	});

	it('applies a commit delta into the model cache', () => {
		seedElements([{ id: 'e1', type_name: 'Node', properties: { name: 'old' }, rev: 0 }]);
		handleFeedEvent({
			type: 'commit',
			rev: 5,
			commit_id: 'c1',
			author_id: 'a',
			message: 'rename',
			validation_error_count: 0,
			changed_elements: [{ id: 'e1', type_name: 'Node', properties: { name: 'new' }, rev: 1 }],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: []
		});
		expect(getCachedElements().get('e1')?.properties.name).toBe('new');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/realtime.test.ts'`
Expected: FAIL — `../realtime.svelte` does not exist. (If `resetModelStore`/`getCachedElements`/`seedElements` are not already exported from `model.svelte`, confirm via `state/index.ts` — they are listed there.)

- [ ] **Step 3: Implement the store**

Create `frontend/src/lib/state/realtime.svelte.ts`:

```ts
/**
 * Realtime feed store (Phase 5, Spec A — thin). Subscribes to the project feed
 * and reduces its events into reactive state: connection status, the set of
 * connected users (presence), and the live lock table (resource_id -> lease).
 * Commit deltas from OTHER clients are applied into the existing model cache
 * via `applyDelta`. This store does NOT change the editing path; lock-badge
 * RENDERING and the lock->edit->commit UI land in Spec B.
 */

import {
	connectFeed,
	type FeedConfig,
	type FeedConnection,
	type FeedEvent,
	type LeaseLite
} from '$lib/api/feed';
import { applyDelta, getIssueCounts, getModelRev, refreshSummary } from './model.svelte';

let _connected = $state(false);
let _presence = $state<string[]>([]);
let _lockState = $state<Map<string, LeaseLite>>(new Map());
let _conn: FeedConnection | null = null;

export function getFeedConnected(): boolean {
	return _connected;
}

export function getPresence(): string[] {
	return _presence;
}

export function getLockState(): Map<string, LeaseLite> {
	return _lockState;
}

export function getLockFor(id: string): LeaseLite | undefined {
	return _lockState.get(id);
}

function setLeases(leases: LeaseLite[]): void {
	const next = new Map(_lockState);
	for (const le of leases) next.set(le.resource_id, le);
	_lockState = next;
}

function clearLeases(leases: LeaseLite[]): void {
	const next = new Map(_lockState);
	for (const le of leases) next.delete(le.resource_id);
	_lockState = next;
}

/** Exported for unit tests; also the single dispatch point for `connectFeed`. */
export function handleFeedEvent(e: FeedEvent): void {
	switch (e.type) {
		case 'snapshot': {
			_presence = e.connected;
			_lockState = new Map(e.locks.map((le) => [le.resource_id, le] as const));
			// If we are behind the server's rev, our cached subset may be stale.
			// Spec A keeps this light: refresh the model-wide summary counters.
			// (Spec B wires a full reload of the affected subset.)
			if (e.model_rev > getModelRev()) void refreshSummary();
			break;
		}
		case 'presence':
			_presence = e.connected;
			break;
		case 'lock':
			if (e.action === 'acquired') setLeases(e.leases);
			else clearLeases(e.leases);
			break;
		case 'commit':
			applyDelta({
				model_rev: e.rev,
				id_map: {},
				changed_elements: e.changed_elements as never,
				changed_relationships: e.changed_relationships as never,
				deleted_element_ids: e.deleted_element_ids,
				deleted_relationship_ids: e.deleted_relationship_ids,
				issues_removed_owner_ids: [],
				issues_added: [],
				issue_counts: getIssueCounts() ?? {}
			});
			break;
	}
}

export function startRealtime(config?: Partial<FeedConfig>): void {
	if (_conn) return;
	_conn = connectFeed({
		onEvent: handleFeedEvent,
		onStatus: (c) => {
			_connected = c;
		},
		...config
	});
}

export function stopRealtime(): void {
	_conn?.close();
	_conn = null;
	_connected = false;
}

/** Test isolation. */
export function resetRealtime(): void {
	stopRealtime();
	_presence = [];
	_lockState = new Map();
}
```

Note on `applyDelta`'s argument: it expects the `OpsResponse` shape (`model_rev`, `id_map`, `changed_elements`, `changed_relationships`, `deleted_element_ids`, `deleted_relationship_ids`, `issues_removed_owner_ids`, `issues_added`, `issue_counts`). The commit event carries everything except `id_map`/`issues_*`/`issue_counts`; we pass `{}`/`[]`/current-counts so remote commits never clobber local issue counts. If `applyDelta`'s exact type rejects the `as never` casts under svelte-check, import the `OpsResponse` type from `$lib/api/types` and build a typed object instead.

- [ ] **Step 4: Re-export from the state index**

In `frontend/src/lib/state/index.ts`, add:

```ts
export {
	getFeedConnected,
	getLockFor,
	getLockState,
	getPresence,
	startRealtime,
	stopRealtime
} from './realtime.svelte';
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/realtime.test.ts'`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no errors. (If `as never` triggers a warning, switch to the typed-`OpsResponse` construction described above.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/state/realtime.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/realtime.test.ts
git commit -m "$(cat <<'EOF'
feat(frontend): realtime store — presence, lock state, commit deltas (Phase 5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire the feed into the app (StatusBar indicator + lifecycle + proxy)

**Files:**
- Modify: `frontend/vite.config.ts` (`ws: true` on the proxy)
- Modify: `frontend/src/routes/+page.svelte` (start/stop the feed)
- Modify: `frontend/src/lib/components/StatusBar.svelte` (connection dot + presence count)
- Test: covered by `npm run check` + an assertion in the existing Playwright smoke is optional; this task ships UI wiring verified by type-check + a manual run.

**Interfaces:**
- Consumes: `startRealtime`, `stopRealtime`, `getFeedConnected`, `getPresence` (Task 8).

- [ ] **Step 1: Enable WebSocket proxying in dev**

In `frontend/vite.config.ts`, add `ws: true` to the `/api/v1` proxy entry:

```ts
			proxy: {
				'/api/v1': {
					target: 'http://127.0.0.1:8000',
					changeOrigin: true,
					ws: true
				}
			}
```

- [ ] **Step 2: Start/stop the feed with the page lifecycle**

In `frontend/src/routes/+page.svelte`, inside the existing `<script>` import the lifecycle helpers and `onMount`/`onDestroy` from `svelte`, then start the feed on mount:

```ts
	import { onDestroy, onMount } from 'svelte';
	import { startRealtime, stopRealtime } from '$lib/state';

	onMount(() => startRealtime());
	onDestroy(() => stopRealtime());
```

(If `onMount`/`onDestroy` are already imported, add only the missing names and the two calls. Place them alongside the other top-level store wiring in the component.)

- [ ] **Step 3: Show connection + presence in the StatusBar**

In `frontend/src/lib/components/StatusBar.svelte`, add to the imports:

```ts
	import { getFeedConnected, getPresence } from '$lib/state';
```

Add derived state in the `<script>`:

```ts
	const feedConnected = $derived(getFeedConnected());
	const presenceCount = $derived(getPresence().length);
```

Add markup at the end of the `<footer>` (before the closing tag), after the filename span:

```svelte
	<span class="text-zinc-700">·</span>
	<span
		class={feedConnected ? 'text-emerald-400' : 'text-zinc-600'}
		title={feedConnected ? 'Live feed connected' : 'Live feed disconnected'}
	>
		● {feedConnected ? 'live' : 'offline'}
	</span>
	{#if presenceCount > 0}
		<span class="text-zinc-700">·</span>
		<span title="People connected to this project">{presenceCount} here</span>
	{/if}
```

- [ ] **Step 4: Type-check + lint the frontend**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm run lint'`
Expected: no errors.

- [ ] **Step 5: Run the full frontend unit suite**

Run: `pixi run -e frontend npm test`
Expected: PASS (new feed + realtime tests included; no regressions).

- [ ] **Step 6: Manual smoke (optional but recommended)**

Start backend + frontend (`pixi run start-backend` and `pixi run start-frontend`), open two browser tabs on `http://127.0.0.1:5173`. Confirm the StatusBar shows `● live` and `2 here`. (No commit UI exists yet — that is Spec B — so live deltas are exercised by the backend tests, not the manual smoke.)

- [ ] **Step 7: Commit**

```bash
git add frontend/vite.config.ts frontend/src/routes/+page.svelte frontend/src/lib/components/StatusBar.svelte
git commit -m "$(cat <<'EOF'
feat(frontend): wire realtime feed — StatusBar live/presence indicator + WS proxy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Documentation

**Files:**
- Modify: `frontend/README.md` (note the realtime feed store)
- Modify: `CLAUDE.md` (add a Phase 5 subsection under the API architecture)

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the backend feed in `CLAUDE.md`**

After the "Check-out/commit + locking (Phase 4)" section, add a terse "Realtime feed (Phase 5)" subsection matching the existing style. Cover, one line each: `feed.py` (`FeedHub` per `Session`, bounded per-client `asyncio.Queue`, sync `broadcast` via `loop.call_soon_threadsafe`, drop+close on overflow); `routes/feed.py` (`@router.websocket("/feed")`, query-param identity through the seam, close codes 4401/4403/4404/4408, snapshot-then-stream); the broadcast hook sites (commit delta + lock acquire/release in the routes, lock expiry in the sweeper; renew is silent); the `IdentityProvider.identify(HTTPConnection)` retype; the evict-guard extension (no eviction while clients connected); and that the feed is server→client only — the lock→edit→commit UI is Spec B.

- [ ] **Step 2: Document the client store in `frontend/README.md`**

In the "Where to find things" / state section, add a line for `state/realtime.svelte.ts` (feed transport store: connection status, presence, lock state, applies remote commit deltas) and `api/feed.ts` (WebSocket wrapper, auto-reconnect, injectable socket). Note it is thin — lock-badge rendering and the commit UI are a later phase.

- [ ] **Step 3: Verify nothing else references the feed incorrectly**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run -e frontend npm test`
Expected: full PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md frontend/README.md
git commit -m "$(cat <<'EOF'
docs: document the Phase 5 realtime feed (backend hub + client store)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §2 sync↔async bridge (per-conn queue + `call_soon_threadsafe`) → Task 2 + Task 4. ✓
- §3.1 `FeedHub`/`ClientConn`/loop handle → Task 2; `Session.hub` → Task 3. ✓
- §3.2 WS endpoint (authn, membership, accept, snapshot, presence, pump) → Task 4. ✓
- §3.3 broadcast hooks: commit → Task 5; lock acquire/release → Task 6; sweeper expiry → Task 6; renew silent → Task 6 (explicitly not broadcast). ✓
- §3.4 identity seam `HTTPConnection` + query-param dev → Task 1. ✓
- §3.5 evict guard for connected clients → Task 3. ✓
- §3.6 client `api/feed.ts` (reconnect/backoff, injectable socket) → Task 7; `realtime.svelte.ts` (connected/presence/lockState, commit-delta application, stale-rev refresh) → Task 8. ✓
- §3.7 StatusBar connection + presence; lock-badge rendering deferred → Task 9 (deferral honored — only the dot + count ship). ✓
- §3.9 `feed_queue_max` + loop capture → Task 3 + Task 4 (lazy capture). ✓
- §4 event payloads (snapshot/commit/lock/presence) → Task 2 builders; commit carries the delta form incl. `issue_counts`-free payload consumed with current counts → Task 8. ✓
- §5 ordering (write-mutex-serialized enqueue), recovery (snapshot rev → refresh), backpressure (drop+close) → Tasks 2/4/8. ✓
- §6 testing: backend integration (connect/auth/snapshot/presence/commit/lock/expiry) → Tasks 4–6; frontend (reconnect, reducers, commit application) → Tasks 7–8. ✓
- §7 out-of-scope items (editing UI, legacy `/model/ops` broadcast, live cursors, Redis) → none implemented. ✓

**Placeholder scan:** no TBD/TODO; every code step shows real code; the only conditional guidance (`_etype` helper in Task 5, `as never` fallback in Task 8) gives an explicit concrete alternative. ✓

**Type consistency:** `FeedHub`/`ClientConn`/`CLOSE_SENTINEL`/`set_loop_if_unset`/`get_loop`/`reset_loop` and the four event builders are defined in Task 2 and consumed with matching names/signatures in Tasks 3–6. `commit_event` keyword args match the call in Task 5. Client `FeedEvent`/`LeaseLite`/`connectFeed`/`FeedConnection` defined in Task 7, consumed in Task 8. `applyDelta` argument shape matches the `OpsResponse` fields confirmed from `model.svelte.ts`. ✓

**Notable refinement vs spec:** §5 says "queue full → drop + close." Implemented faithfully (drain queue → push `CLOSE_SENTINEL` → sender closes with 4408 → client reconnects). Equivalent guarantee, fully testable (Task 2 `test_deliver_on_full_queue_drops_and_closes`).
