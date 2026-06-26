from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import HTTPConnection

from data_rover.api import auth, db
from data_rover.api import tenancy, db as _db
from data_rover.api.db_models import User
from data_rover.api.identity import CookieIdentityProvider, Identity, set_identity_provider
from data_rover.api.main import create_app


def test_user_has_auth_columns() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="u1", email="u1@x", password_hash="h", is_admin=True))
        s.commit()
        u = s.get(User, "u1")
        assert u is not None
        assert u.password_hash == "h"
        assert u.is_admin is True
        assert u.is_active is True  # default
    finally:
        gen.close()


def test_password_hash_roundtrip() -> None:
    h = auth.hash_password("hunter2")
    assert h != "hunter2"
    assert auth.verify_password("hunter2", h) is True
    assert auth.verify_password("wrong", h) is False


def test_token_roundtrip() -> None:
    tok = auth.mint_token("u1", is_admin=True)
    payload = auth.decode_token(tok)
    assert payload["sub"] == "u1"
    assert payload["is_admin"] is True


def test_decode_rejects_garbage() -> None:
    with pytest.raises(auth.TokenError):
        auth.decode_token("not-a-jwt")


def _conn_with_cookie(token: str) -> HTTPConnection:
    scope = {
        "type": "http",
        "headers": [(b"cookie", f"session={token}".encode())],
        "query_string": b"",
    }
    return HTTPConnection(scope)


def test_cookie_provider_identifies_valid_token() -> None:
    token = auth.mint_token("u1", is_admin=False)
    ident = CookieIdentityProvider("session").identify(_conn_with_cookie(token))
    assert ident == Identity(user_id="u1", email="")


def test_cookie_provider_rejects_missing_cookie() -> None:
    conn = HTTPConnection({"type": "http", "headers": [], "query_string": b""})
    with pytest.raises(HTTPException) as ei:
        CookieIdentityProvider("session").identify(conn)
    assert ei.value.status_code == 401


# ---------------------------------------------------------------------------
# Route tests — use an in-process TestClient per test (no external server).
# The _cookie_provider autouse fixture pins the identity provider to cookie
# mode for every test in this module and restores it afterwards.
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _cookie_provider(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("DATA_ROVER_IDENTITY_PROVIDER", "cookie")
    # a real secret so create_app()'s cookie provider works without the
    # insecure-default guard tripping (tests run with dev_seed=false).
    monkeypatch.setenv("DATA_ROVER_JWT_SECRET", "test-secret-not-the-default")
    # TestClient uses plain HTTP; Secure cookies are dropped unless we disable
    # the flag so the httpx client sends the session cookie on every request.
    monkeypatch.setenv("DATA_ROVER_AUTH_COOKIE_SECURE", "false")
    set_identity_provider(None)  # rebuild from the patched setting
    yield
    set_identity_provider(None)


def _client() -> TestClient:
    return TestClient(create_app())


def _make_user(email: str, pw: str, *, admin: bool = False, active: bool = True) -> None:
    gen = _db.get_db()
    s = next(gen)
    try:
        u = tenancy.create_user(s, email, pw, is_admin=admin)
        if not active:
            tenancy.set_user_fields(s, u.id, is_active=False)
    finally:
        gen.close()


def test_login_me_logout_cycle() -> None:
    _make_user("a@x.com", "pw", admin=True)
    c = _client()
    assert c.post("/api/v1/auth/login",
                  json={"email": "a@x.com", "password": "pw"}).status_code == 200
    me = c.get("/api/v1/auth/me")
    assert me.status_code == 200 and me.json()["is_admin"] is True
    assert c.post("/api/v1/auth/logout",
                  headers={"x-requested-with": "data-rover"}).status_code == 204
    assert c.get("/api/v1/auth/me").status_code == 401


def test_login_bad_password_401() -> None:
    _make_user("a@x.com", "pw")
    c = _client()
    assert c.post("/api/v1/auth/login",
                  json={"email": "a@x.com", "password": "nope"}).status_code == 401


def test_login_inactive_user_401() -> None:
    _make_user("a@x.com", "pw", active=False)
    c = _client()
    assert c.post("/api/v1/auth/login",
                  json={"email": "a@x.com", "password": "pw"}).status_code == 401
