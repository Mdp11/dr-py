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
import contextlib
import time

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from ..feed import (
    CLOSE_SENTINEL,
    ClientConn,
    presence_event,
    set_loop_if_unset,
    snapshot_event,
)
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
        {
            "resource_id": le.resource_id,
            "mode": le.mode.value,
            "holder_id": le.holder,
            "holder_email": le.holder_email,
        }
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

    try:
        await websocket.accept()
    except WebSocketDisconnect:
        return  # client aborted the handshake before we accepted; nothing to clean up
    conn = ClientConn(
        user_id=user_id,
        queue=asyncio.Queue(maxsize=get_settings().feed_queue_max),
    )
    session.hub.register(conn)
    session.hub.broadcast(
        presence_event("join", user_id, session.hub.connected_user_ids())
    )
    pump: asyncio.Task[None] | None = None
    try:
        # The initial snapshot send sits INSIDE the guarded region: a client
        # can vanish between accept() and this send (e.g. the page reloads
        # mid-project-open and the browser aborts the socket without a close
        # frame), and that must unwind through the same unregister/presence
        # cleanup as a normal disconnect — never as an unhandled ASGI error.
        await websocket.send_json(
            snapshot_event(
                model_rev=session.model_rev,
                locks=_lease_dicts(session, time.monotonic()),
                connected=session.hub.connected_user_ids(),
            )
        )
        pump = asyncio.create_task(_pump(websocket, conn))
        while True:
            await websocket.receive_text()  # raises on disconnect; ignore payloads
    except WebSocketDisconnect:
        pass
    finally:
        if pump is not None:
            pump.cancel()
        session.hub.unregister(conn)
        session.hub.broadcast(
            presence_event("leave", user_id, session.hub.connected_user_ids())
        )


async def _pump(websocket: WebSocket, conn: ClientConn) -> None:
    """Drain the client's queue to the socket; close on the drop sentinel."""
    try:
        while True:
            event = await conn.queue.get()
            if event is CLOSE_SENTINEL:
                await websocket.close(code=4408)
                return
            await websocket.send_json(event)
    except Exception:
        # A send failure (peer gone mid-send, or a bad event) must not leave a
        # dead pump with a live, blocked connection. Best-effort close so the
        # receive loop unblocks and the endpoint's finally cleans up.
        with contextlib.suppress(Exception):
            await websocket.close()
