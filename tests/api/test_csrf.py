from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.csrf import CSRFMiddleware


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(CSRFMiddleware)

    @app.post("/echo")
    def echo() -> dict:
        return {"ok": True}

    return app


def test_no_cookie_request_passes() -> None:
    c = TestClient(_app())
    assert c.post("/echo").status_code == 200


def test_cookie_write_without_csrf_header_is_403() -> None:
    c = TestClient(_app())
    c.cookies.set("session", "whatever")
    assert c.post("/echo").status_code == 403


def test_cookie_write_with_csrf_header_passes() -> None:
    c = TestClient(_app())
    c.cookies.set("session", "whatever")
    r = c.post("/echo", headers={"x-requested-with": "data-rover"})
    assert r.status_code == 200
