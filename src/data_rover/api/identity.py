"""Authentication seam.

The backend trusts a *verified* identity and exposes one interface:
``IdentityProvider.identify(request) -> Identity``. Phase 2 ships a dev
provider that trusts ``X-User-Id`` / ``X-User-Email`` request headers (suitable
behind a header-injecting gateway, or for local dev). A real OIDC/SAML client
is a later swap via ``set_identity_provider`` — no caller changes.

Authentication (who you are) is delegated here; authorization (what you may do)
lives in ``authz`` against the ``Membership`` table.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session
from starlette.requests import HTTPConnection, Request

from .auth import TokenError, decode_token
from .db import get_db
from .db_models import User
from .settings import get_settings
from .tenancy import upsert_user


@dataclass(frozen=True)
class Identity:
    user_id: str
    #: may be "" when the provider has no email claim (a first-class value,
    #: not a sentinel — ``upsert_user`` won't overwrite a stored email with "")
    email: str


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


class CookieIdentityProvider:
    """Trusts a signed session JWT in an httpOnly cookie (local email+password
    auth). Verification (signature + expiry) happens in ``auth.decode_token``;
    the email claim is intentionally absent from the token (looked up from the
    User row by ``get_current_user``), so Identity.email is "" here."""

    def __init__(self, cookie_name: str) -> None:
        self._cookie_name = cookie_name

    def identify(self, conn: HTTPConnection) -> Identity:
        token = conn.cookies.get(self._cookie_name)
        if not token:
            raise HTTPException(status_code=401, detail="missing session")
        try:
            payload = decode_token(token)
        except TokenError as exc:
            raise HTTPException(status_code=401, detail="invalid session") from exc
        return Identity(user_id=str(payload["sub"]), email="")


_provider: IdentityProvider | None = None


def get_identity_provider() -> IdentityProvider:
    """Return the process-wide provider, building the configured default on
    first use. ``identity_provider`` selects cookie (local auth, default) or
    header (gateway/tests)."""
    global _provider
    if _provider is None:
        settings = get_settings()
        if settings.identity_provider == "header":
            _provider = DevHeaderIdentityProvider(
                settings.identity_user_header, settings.identity_email_header
            )
        else:
            _provider = CookieIdentityProvider(settings.auth_cookie_name)
    return _provider


def set_identity_provider(provider: IdentityProvider | None) -> None:
    """Swap the provider (real SSO in prod; reset to default with ``None``).

    The provider is a process-global singleton. Tests that call this MUST reset
    it (``set_identity_provider(None)``) afterwards or they leak into later
    tests — the API test conftest does this automatically in ``_fresh_db``.
    """
    global _provider
    _provider = provider


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Resolve the requesting user.

    Header provider (gateway/dev/tests): auto-provision on first sight, keeping
    that flow zero-setup. Cookie provider (local auth): the user MUST already
    exist and be active — admin-only provisioning means there is no self-signup,
    and ``is_active`` is the per-request revocation check.
    """
    provider = get_identity_provider()
    identity = provider.identify(request)
    if isinstance(provider, CookieIdentityProvider):
        user = db.get(User, identity.user_id)
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="unknown or inactive user")
        return user
    return upsert_user(db, identity.user_id, identity.email)
