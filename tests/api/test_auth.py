from __future__ import annotations

import pytest

from data_rover.api import auth, db
from data_rover.api.db_models import User


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


from starlette.requests import HTTPConnection

from data_rover.api.identity import CookieIdentityProvider, Identity


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
    with pytest.raises(Exception):  # HTTPException 401
        CookieIdentityProvider("session").identify(conn)
