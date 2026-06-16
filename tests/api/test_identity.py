from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from data_rover.api import db
from data_rover.api.identity import (
    DevHeaderIdentityProvider,
    Identity,
    get_current_user,
    get_identity_provider,
    set_identity_provider,
)


def _request(headers: list[tuple[bytes, bytes]]) -> Request:
    return Request({"type": "http", "headers": headers})


def test_dev_provider_reads_headers() -> None:
    p = DevHeaderIdentityProvider("x-user-id", "x-user-email")
    ident = p.identify(
        _request([(b"x-user-id", b"u1"), (b"x-user-email", b"u1@x.com")])
    )
    assert ident == Identity(user_id="u1", email="u1@x.com")


def test_dev_provider_missing_id_is_401() -> None:
    p = DevHeaderIdentityProvider("x-user-id", "x-user-email")
    with pytest.raises(HTTPException) as exc:
        p.identify(_request([]))
    assert exc.value.status_code == 401


def test_get_current_user_autoprovisions() -> None:
    # Pin the provider so the test exercises get_current_user's own contract,
    # not "whatever the global default header names happen to be".
    set_identity_provider(DevHeaderIdentityProvider("x-user-id", "x-user-email"))
    gen = db.get_db()
    session = next(gen)
    try:
        user = get_current_user(
            _request([(b"x-user-id", b"u1"), (b"x-user-email", b"u1@x.com")]),
            session,
        )
        assert user.id == "u1"
        assert user.email == "u1@x.com"
    finally:
        gen.close()


def test_set_and_reset_provider() -> None:
    original = get_identity_provider()
    assert isinstance(original, DevHeaderIdentityProvider)

    sentinel = DevHeaderIdentityProvider("x-custom", "x-custom-email")
    set_identity_provider(sentinel)
    assert get_identity_provider() is sentinel

    set_identity_provider(None)
    rebuilt = get_identity_provider()
    assert isinstance(rebuilt, DevHeaderIdentityProvider)
    assert rebuilt is not sentinel
