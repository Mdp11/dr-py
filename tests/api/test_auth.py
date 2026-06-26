from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import HTTPConnection

from data_rover.api import auth, db, tenancy
from data_rover.api.db_models import User
from data_rover.api.identity import CookieIdentityProvider, Identity
from data_rover.api.main import create_app

pytestmark = pytest.mark.usefixtures("cookie_provider")


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
# The module-level pytestmark applies the conftest ``cookie_provider`` fixture
# to every test in this module (cookie identity mode, real JWT secret).
# ---------------------------------------------------------------------------


def _client() -> TestClient:
    return TestClient(create_app())


def _make_user(email: str, pw: str, *, admin: bool = False, active: bool = True) -> None:
    gen = db.get_db()
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


# ---------------------------------------------------------------------------
# change-password route tests
# ---------------------------------------------------------------------------

_CSRF = {"x-requested-with": "data-rover"}


def test_change_password_happy_path() -> None:
    """Change password succeeds; new password works, old password is rejected."""
    _make_user("b@x.com", "oldpassword")
    c = _client()
    # Login to get session cookie.
    assert c.post("/api/v1/auth/login",
                  json={"email": "b@x.com", "password": "oldpassword"}).status_code == 200
    # Change the password.
    r = c.post(
        "/api/v1/auth/change-password",
        json={"old_password": "oldpassword", "new_password": "newpassword"},
        headers=_CSRF,
    )
    assert r.status_code == 204
    # New password now works.
    c2 = _client()
    assert c2.post("/api/v1/auth/login",
                   json={"email": "b@x.com", "password": "newpassword"}).status_code == 200
    # Old password is rejected.
    c3 = _client()
    assert c3.post("/api/v1/auth/login",
                   json={"email": "b@x.com", "password": "oldpassword"}).status_code == 401


def test_change_password_wrong_old_password_401() -> None:
    """Supplying the wrong current password returns 401."""
    _make_user("c@x.com", "correctpassword")
    c = _client()
    assert c.post("/api/v1/auth/login",
                  json={"email": "c@x.com", "password": "correctpassword"}).status_code == 200
    r = c.post(
        "/api/v1/auth/change-password",
        json={"old_password": "wrongpassword", "new_password": "newpassword"},
        headers=_CSRF,
    )
    assert r.status_code == 401


def test_change_password_too_short_new_password_422() -> None:
    """New password shorter than 8 chars returns 422."""
    _make_user("d@x.com", "somepassword")
    c = _client()
    assert c.post("/api/v1/auth/login",
                  json={"email": "d@x.com", "password": "somepassword"}).status_code == 200
    r = c.post(
        "/api/v1/auth/change-password",
        json={"old_password": "somepassword", "new_password": "short"},
        headers=_CSRF,
    )
    assert r.status_code == 422
