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
