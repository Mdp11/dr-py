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
