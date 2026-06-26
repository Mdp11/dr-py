"""Local-auth primitives: password hashing, session JWTs, cookie helpers.

This is the interim (email+password) implementation behind the identity seam;
a real SSO provider would replace ``CookieIdentityProvider`` (identity.py) and
leave this module's hashing/token helpers unused. Kept dependency-light:
argon2-cffi for hashing, PyJWT for the signed session token.
"""

from __future__ import annotations

import time

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from fastapi import Response

from .settings import get_settings

_ALGO = "HS256"
_hasher = PasswordHasher()


class TokenError(Exception):
    """Raised when a session token is missing, malformed, or expired."""


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return _hasher.verify(hashed, plain)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def mint_token(user_id: str, is_admin: bool) -> str:
    settings = get_settings()
    now = int(time.time())
    payload = {
        "sub": user_id,
        "is_admin": is_admin,
        "iat": now,
        "exp": now + settings.jwt_ttl_seconds,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGO)


def decode_token(token: str) -> dict:  # type: ignore[type-arg]
    try:
        return jwt.decode(token, get_settings().jwt_secret, algorithms=[_ALGO])
    except jwt.PyJWTError as exc:  # ExpiredSignatureError, InvalidTokenError, ...
        raise TokenError(str(exc)) from exc


def set_session_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=settings.auth_cookie_name,
        value=token,
        max_age=settings.jwt_ttl_seconds,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="strict",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=get_settings().auth_cookie_name, path="/", samesite="strict"
    )
