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

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

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
    def identify(self, request: Request) -> Identity: ...


class DevHeaderIdentityProvider:
    """Trusts identity headers. Dev/gateway use only — never trust these
    headers on an endpoint reachable directly by untrusted clients."""

    def __init__(self, user_header: str, email_header: str) -> None:
        self._user_header = user_header
        self._email_header = email_header

    def identify(self, request: Request) -> Identity:
        user_id = request.headers.get(self._user_header)
        if not user_id:
            raise HTTPException(status_code=401, detail="missing identity")
        email = request.headers.get(self._email_header, "")
        return Identity(user_id=user_id, email=email)


_provider: IdentityProvider | None = None


def get_identity_provider() -> IdentityProvider:
    """Return the process-wide provider, building the dev default on first use."""
    global _provider
    if _provider is None:
        settings = get_settings()
        _provider = DevHeaderIdentityProvider(
            settings.identity_user_header, settings.identity_email_header
        )
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
    """Resolve and auto-provision the requesting user.

    Auto-provision on first sight keeps the dev/gateway flow zero-setup; a
    later SSO integration can pre-create users instead without changing this.
    """
    identity = get_identity_provider().identify(request)
    return upsert_user(db, identity.user_id, identity.email)
