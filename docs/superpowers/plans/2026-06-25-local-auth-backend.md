# Local Auth + Admin — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real email+password authentication (JWT in an httpOnly cookie), a global `is_admin` permission, admin user/membership management, and an admin-only create-project wizard to the FastAPI backend — implementing the deferred `IdentityProvider` seam without disturbing the existing per-project model.

**Architecture:** A new `auth.py` (Argon2id hashing + JWT mint/verify + cookie helpers) feeds a new `CookieIdentityProvider` slotted behind the existing `identity.py` seam. `authz.py` gains `require_admin`; membership/project-create routes re-gate to it. New `routes/auth.py` and `routes/admin.py` expose login/logout/me and user CRUD + membership management. A CSRF middleware guards cookie-authenticated writes. The existing per-project `Role` and all model/data routes are untouched except for gating.

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI 0.115, SQLAlchemy 2.0, Alembic 1.14, `pyjwt`, `argon2-cffi`. Tests: pytest (in-memory SQLite, `tests/api/conftest.py`).

## Global Constraints

- Run everything through **pixi**: `pixi run -e core-dev pytest tests/api/...`, `pixi run lint-backend`, `pixi run tidy`. No global `python`.
- Python floor is **3.10** for pyright: import `Self`/`assert_never` from `typing_extensions`, not `typing`. Runtime is 3.14.
- New runtime deps go in `pixi.toml` under `[feature.api.dependencies]` (conda-forge names).
- API tests use **in-memory SQLite** via `tests/api/conftest.py` — no DB service. Schema for tests comes from `db.create_all()`, **not** Alembic; the Alembic migration is for Postgres only and is tested separately (offline `--sql` render).
- Identity is a **process-global singleton**. Tests that swap it must reset (`set_identity_provider(None)`); conftest does this automatically.
- Lint/format/typecheck all three must pass (ruff, mypy, pyright) before each commit: `pixi run lint-backend`.
- Preserve the dense "why" docstring style of `db_models.py` / `identity.py` / `authz.py`.

---

## File Structure

**Create:**
- `src/data_rover/api/auth.py` — password hashing + JWT mint/verify + cookie set/clear helpers.
- `src/data_rover/api/csrf.py` — `CSRFMiddleware` (guards cookie-authed unsafe methods).
- `src/data_rover/api/routes/auth.py` — `/auth/login|logout|me|change-password`.
- `src/data_rover/api/routes/admin.py` — `/admin/users*` + `/admin/projects/{id}/members*`.
- `alembic/versions/0006_user_auth_columns.py` — `password_hash`/`is_admin`/`is_active` on `users`.
- `tests/api/test_auth.py`, `tests/api/test_admin.py`, `tests/api/test_projects_wizard.py`, `tests/api/test_csrf.py`.

**Modify:**
- `src/data_rover/api/db_models.py` — three new `User` columns.
- `src/data_rover/api/settings.py` — auth/jwt/bootstrap settings.
- `src/data_rover/api/identity.py` — `CookieIdentityProvider`; provider selection; no-autoprovision on cookie path.
- `src/data_rover/api/authz.py` — `require_admin`.
- `src/data_rover/api/tenancy.py` — user-management service functions.
- `src/data_rover/api/routes/projects.py` — admin-gate create/delete, list-all-for-admin, multipart wizard.
- `src/data_rover/api/main.py` — mount new routers, add CSRF middleware, bootstrap admin, prod secret check.
- `pixi.toml` — add `pyjwt`, `argon2-cffi`.
- `tests/api/conftest.py` — pin `DATA_ROVER_IDENTITY_PROVIDER=header` so existing data tests keep header auth; add a cookie-login helper.

---

## Task 1: Dependencies + `User` auth columns + migration

**Files:**
- Modify: `pixi.toml:20-29` (`[feature.api.dependencies]`)
- Modify: `src/data_rover/api/db_models.py:39-62` (`User`)
- Create: `alembic/versions/0006_user_auth_columns.py`
- Test: `tests/api/test_auth.py` (new)

**Interfaces:**
- Produces: `User.password_hash: str | None`, `User.is_admin: bool`, `User.is_active: bool`.

- [ ] **Step 1: Add dependencies to pixi.toml**

In `pixi.toml`, under `[feature.api.dependencies]` (after line 29), add:

```toml
pyjwt = "2.*"
argon2-cffi = "23.*"
```

Run: `pixi install` (regenerates the lock). Expected: resolves without error.

- [ ] **Step 2: Write the failing test for the new columns**

Create `tests/api/test_auth.py`:

```python
from __future__ import annotations

from data_rover.api import db
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py::test_user_has_auth_columns -v`
Expected: FAIL — `TypeError: 'password_hash' is an invalid keyword argument for User` (column missing).

- [ ] **Step 4: Add the columns to the `User` model**

In `db_models.py`, inside `class User`, after the `email` column (line 54), add:

```python
    #: Argon2id hash of the local password. NULL for users that authenticate
    #: only via a future SSO provider (no local credential). The cookie auth
    #: path rejects a NULL-hash user at login.
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Global role. The single system-level permission (see authz.require_admin):
    #: admins manage users, all project memberships, and create projects.
    is_admin: Mapped[bool] = mapped_column(default=False, nullable=False)
    #: Deactivation = revocation. An inactive user is rejected 401 on the next
    #: request even with a still-valid JWT (identity layer re-checks per request).
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
```

Add `Boolean` to the `from sqlalchemy import (...)` block if mypy/pyright needs it — `mapped_column(default=...)` infers the type from the `Mapped[bool]` annotation, so no explicit `Boolean()` is required. Leave the import block as-is unless lint complains.

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py::test_user_has_auth_columns -v`
Expected: PASS.

- [ ] **Step 6: Write the Alembic migration (Postgres path)**

Create `alembic/versions/0006_user_auth_columns.py`:

```python
"""user auth columns: password_hash, is_admin, is_active

Revision ID: 0006
Revises: 0005
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_hash", sa.String(), nullable=True))
    op.add_column(
        "users",
        sa.Column(
            "is_admin", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "is_active")
    op.drop_column("users", "is_admin")
    op.drop_column("users", "password_hash")
```

(Note: `server_default` is required because the columns are NOT NULL and existing rows need a value; the ORM-level `default` does not backfill existing rows.)

- [ ] **Step 7: Verify the migration renders offline**

Run: `pixi run -e api alembic upgrade 0005:0006 --sql`
Expected: prints `ALTER TABLE users ADD COLUMN ...` SQL for all three columns, no error.

- [ ] **Step 8: Lint + commit**

Run: `pixi run lint-backend`
Expected: clean.

```bash
git add pixi.toml pixi.lock src/data_rover/api/db_models.py alembic/versions/0006_user_auth_columns.py tests/api/test_auth.py
git commit -m "feat(api): add password_hash/is_admin/is_active to User + migration 0006

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `auth.py` — hashing, JWT, cookie helpers + settings

**Files:**
- Create: `src/data_rover/api/auth.py`
- Modify: `src/data_rover/api/settings.py:22-78`
- Test: `tests/api/test_auth.py`

**Interfaces:**
- Produces:
  - `hash_password(plain: str) -> str`
  - `verify_password(plain: str, hashed: str) -> bool`
  - `mint_token(user_id: str, is_admin: bool) -> str`
  - `decode_token(token: str) -> dict` (raises `TokenError` on invalid/expired)
  - `class TokenError(Exception)`
  - `set_session_cookie(response, token) -> None`, `clear_session_cookie(response) -> None`
  - Settings fields: `jwt_secret`, `jwt_ttl_seconds`, `auth_cookie_name`, `auth_cookie_secure`, `bootstrap_admin_email`, `bootstrap_admin_password`, `identity_provider`.

- [ ] **Step 1: Add the settings fields**

In `settings.py`, inside `class Settings`, after the `identity_email_header` field (line 37), add:

```python
    #: Which IdentityProvider get_identity_provider() builds: "cookie" (local
    #: email+password auth, the default) or "header" (trust gateway headers /
    #: tests). A real SSO provider is a third option installed via code.
    identity_provider: str = "cookie"
    #: HMAC secret for signing session JWTs. The default is INSECURE and only
    #: tolerated in dev; create_app refuses to boot the cookie provider in a
    #: non-dev deploy that still uses it.
    jwt_secret: str = "dev-insecure-secret-change-me"
    #: Session token lifetime (seconds). Default 8h.
    jwt_ttl_seconds: int = 28800
    #: Session cookie name.
    auth_cookie_name: str = "session"
    #: Set the cookie Secure flag (HTTPS only). False for localhost dev.
    auth_cookie_secure: bool = True
    #: Idempotently ensure an admin user exists on startup (independent of
    #: dev_seed, so prod can seed its first admin). Empty email ⇒ no bootstrap.
    bootstrap_admin_email: str = ""
    bootstrap_admin_password: str = ""
```

- [ ] **Step 2: Write failing tests for hashing + JWT**

Append to `tests/api/test_auth.py`:

```python
import pytest

from data_rover.api import auth


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
```

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py -k "hash_roundtrip or token" -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.auth`.

- [ ] **Step 4: Implement `auth.py`**

Create `src/data_rover/api/auth.py`:

```python
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


def decode_token(token: str) -> dict:
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
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py -k "hash_roundtrip or token or garbage" -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Lint + commit**

Run: `pixi run lint-backend`

```bash
git add src/data_rover/api/auth.py src/data_rover/api/settings.py tests/api/test_auth.py
git commit -m "feat(api): auth primitives (argon2 hashing, JWT session tokens, cookie helpers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `CookieIdentityProvider` + provider selection + no-autoprovision

**Files:**
- Modify: `src/data_rover/api/identity.py`
- Modify: `tests/api/conftest.py:11-15` (env) and add a login helper
- Test: `tests/api/test_auth.py`

**Interfaces:**
- Consumes: `auth.decode_token`, `auth.TokenError`, `Settings.identity_provider`, `Settings.auth_cookie_name`.
- Produces: `class CookieIdentityProvider`; `get_identity_provider()` returns cookie or header provider per settings; `get_current_user` raises 401 for unknown/inactive users on the cookie path.

- [ ] **Step 1: Pin the existing data tests to the header provider**

In `tests/api/conftest.py`, in the env block (after line 15), add:

```python
os.environ.setdefault("DATA_ROVER_IDENTITY_PROVIDER", "header")
```

This keeps every existing `AUTH_HEADERS`-based data test authenticating via headers after the default flips to cookie. Add a cookie-login helper for the new tests, after `papi()` (around line 81):

```python
def login(c: TestClient, email: str, password: str) -> None:
    """Log a TestClient in via cookie auth; the cookie persists on the client."""
    r = c.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text


#: CSRF header the SPA (and cookie-authed tests) send on unsafe requests.
CSRF_HEADERS = {"x-requested-with": "data-rover"}
```

- [ ] **Step 2: Write failing tests for the cookie provider**

Append to `tests/api/test_auth.py`:

```python
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
```

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py -k cookie_provider -v`
Expected: FAIL — `ImportError: cannot import name 'CookieIdentityProvider'`.

- [ ] **Step 4: Implement the provider + selection + no-autoprovision**

In `identity.py`, add the import at the top:

```python
from .auth import TokenError, decode_token
```

Add the provider class after `DevHeaderIdentityProvider` (line 58):

```python
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
```

Rewrite `get_identity_provider()` to select by settings:

```python
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
```

Rewrite `get_current_user` to stop auto-provisioning on the cookie path and enforce `is_active`:

```python
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
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py -k cookie_provider -v`
Expected: PASS.

- [ ] **Step 6: Run the whole API suite to confirm no regression from the default flip**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS (existing data tests still use the header provider via the conftest env pin).

- [ ] **Step 7: Lint + commit**

Run: `pixi run lint-backend`

```bash
git add src/data_rover/api/identity.py tests/api/conftest.py tests/api/test_auth.py
git commit -m "feat(api): CookieIdentityProvider + provider selection; no autoprovision on cookie path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Tenancy user-management service functions

**Files:**
- Modify: `src/data_rover/api/tenancy.py`
- Test: `tests/api/test_admin.py` (new)

**Interfaces:**
- Consumes: `auth.hash_password`.
- Produces (all take a `db: Session`):
  - `get_user_by_email(db, email) -> User | None`
  - `create_user(db, email, password, is_admin) -> User` (raises `ValueError` on duplicate email)
  - `list_users(db, q="") -> list[User]`
  - `set_user_fields(db, user_id, *, is_admin=None, is_active=None, password=None) -> User`
  - `delete_user(db, user_id) -> None`

- [ ] **Step 1: Write failing tests**

Create `tests/api/test_admin.py`:

```python
from __future__ import annotations

import pytest

from data_rover.api import auth, db, tenancy


def _session():
    db.init_engine("sqlite://")
    db.create_all()
    return next(db.get_db())


def test_create_and_get_user_by_email() -> None:
    s = _session()
    u = tenancy.create_user(s, "a@x.com", "pw", is_admin=True)
    assert u.is_admin is True
    assert auth.verify_password("pw", u.password_hash)
    assert tenancy.get_user_by_email(s, "a@x.com").id == u.id


def test_create_user_duplicate_email_raises() -> None:
    s = _session()
    tenancy.create_user(s, "a@x.com", "pw", is_admin=False)
    with pytest.raises(ValueError):
        tenancy.create_user(s, "a@x.com", "pw2", is_admin=False)


def test_set_user_fields_and_list_and_delete() -> None:
    s = _session()
    u = tenancy.create_user(s, "a@x.com", "pw", is_admin=False)
    tenancy.set_user_fields(s, u.id, is_admin=True, is_active=False, password="new")
    u2 = tenancy.get_user_by_email(s, "a@x.com")
    assert u2.is_admin is True and u2.is_active is False
    assert auth.verify_password("new", u2.password_hash)
    assert len(tenancy.list_users(s)) == 1
    assert len(tenancy.list_users(s, q="zzz")) == 0
    tenancy.delete_user(s, u.id)
    assert tenancy.get_user_by_email(s, "a@x.com") is None
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_admin.py -v`
Expected: FAIL — `AttributeError: module 'data_rover.api.tenancy' has no attribute 'create_user'`.

- [ ] **Step 3: Implement the service functions**

In `tenancy.py`, add the import at the top:

```python
from .auth import hash_password
```

Append these functions (after `upsert_user`, keeping related code together):

```python
def get_user_by_email(db: Session, email: str) -> User | None:
    return db.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()


def create_user(db: Session, email: str, password: str, is_admin: bool) -> User:
    """Create an admin-provisioned local user. Raises ValueError on duplicate
    email (the route maps it to 409). The id is a fresh uuid (decoupled from the
    email so the email can change without breaking membership rows)."""
    if get_user_by_email(db, email) is not None:
        raise ValueError("email already in use")
    user = User(
        id=uuid.uuid4().hex,
        email=email,
        password_hash=hash_password(password),
        is_admin=is_admin,
    )
    db.add(user)
    db.commit()
    return user


def list_users(db: Session, q: str = "") -> list[User]:
    stmt = select(User).order_by(User.email)
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q}%"))
    return list(db.execute(stmt).scalars())


def set_user_fields(
    db: Session,
    user_id: str,
    *,
    is_admin: bool | None = None,
    is_active: bool | None = None,
    password: str | None = None,
) -> User:
    """Patch any subset of admin-editable fields. Raises ValueError if unknown."""
    user = db.get(User, user_id)
    if user is None:
        raise ValueError("unknown user")
    if is_admin is not None:
        user.is_admin = is_admin
    if is_active is not None:
        user.is_active = is_active
    if password is not None:
        user.password_hash = hash_password(password)
    db.commit()
    return user


def delete_user(db: Session, user_id: str) -> None:
    """Delete a user. Memberships cascade (DB FK); commits keep author_id via
    SET NULL so model history survives the author leaving."""
    user = db.get(User, user_id)
    if user is None:
        return
    db.delete(user)
    db.commit()
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_admin.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint + commit**

Run: `pixi run lint-backend`

```bash
git add src/data_rover/api/tenancy.py tests/api/test_admin.py
git commit -m "feat(api): tenancy user-management service functions (create/list/patch/delete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `require_admin` authorization dependency

**Files:**
- Modify: `src/data_rover/api/authz.py`
- Test: `tests/api/test_admin.py`

**Interfaces:**
- Consumes: `get_current_user`.
- Produces: `require_admin(user) -> User` (403 if not `is_admin`).

- [ ] **Step 1: Write failing test (unit-level on the dependency)**

Append to `tests/api/test_admin.py`:

```python
from fastapi import HTTPException

from data_rover.api.authz import require_admin
from data_rover.api.db_models import User as UserModel


def test_require_admin_allows_admin_and_blocks_others() -> None:
    admin = UserModel(id="a", email="a@x", is_admin=True)
    assert require_admin(user=admin) is admin
    normal = UserModel(id="n", email="n@x", is_admin=False)
    with pytest.raises(HTTPException) as ei:
        require_admin(user=normal)
    assert ei.value.status_code == 403
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_admin.py::test_require_admin_allows_admin_and_blocks_others -v`
Expected: FAIL — `ImportError: cannot import name 'require_admin'`.

- [ ] **Step 3: Implement `require_admin`**

In `authz.py`, add after `require_owner` (line 80):

```python
def require_admin(user: User = Depends(get_current_user)) -> User:
    """Gate a route on the global ``is_admin`` flag (system-level permission:
    user management, all-project membership management, project creation).
    Distinct from ``require_owner``, which is a per-project role check."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin privileges required")
    return user
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_admin.py::test_require_admin_allows_admin_and_blocks_others -v`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
git add src/data_rover/api/authz.py tests/api/test_admin.py
git commit -m "feat(api): require_admin authorization dependency

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: CSRF middleware for cookie-authed writes

**Files:**
- Create: `src/data_rover/api/csrf.py`
- Modify: `src/data_rover/api/main.py:215-222` (add middleware)
- Test: `tests/api/test_csrf.py` (new)

**Interfaces:**
- Consumes: `Settings.auth_cookie_name`.
- Produces: `CSRFMiddleware` (Starlette `BaseHTTPMiddleware`). Rejects (403) an unsafe-method request that carries the session cookie but lacks the `X-Requested-With: data-rover` header. Requests without the cookie (header-auth/tests, login) are unaffected.

- [ ] **Step 1: Write failing test**

Create `tests/api/test_csrf.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_csrf.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.csrf`.

- [ ] **Step 3: Implement the middleware**

Create `src/data_rover/api/csrf.py`:

```python
"""CSRF guard for cookie-authenticated writes.

The session cookie is SameSite=Strict, but as defense-in-depth every unsafe
request that carries the cookie must ALSO send a custom header that a browser
cannot attach on a cross-site request (no CORS preflight allowance for it).
Header-authenticated requests (gateway/tests) send no cookie and are exempt;
login itself has no cookie yet and is exempt.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from .settings import get_settings

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
_CSRF_HEADER = "x-requested-with"
_CSRF_VALUE = "data-rover"


class CSRFMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.method not in _SAFE_METHODS:
            cookie_name = get_settings().auth_cookie_name
            if cookie_name in request.cookies:
                if request.headers.get(_CSRF_HEADER) != _CSRF_VALUE:
                    return JSONResponse(
                        {"detail": "missing or invalid CSRF header"},
                        status_code=403,
                    )
        return await call_next(request)
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_csrf.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the middleware into the app**

In `main.py` `create_app`, after `add_middleware(CORSMiddleware, ...)` (line 221) add the import at top (`from .csrf import CSRFMiddleware`) and:

```python
    app.add_middleware(CSRFMiddleware)
```

(Order note: Starlette runs middleware in reverse add-order; CSRF after CORS is fine — CORS preflight is OPTIONS, a safe method, so CSRF lets it through.)

- [ ] **Step 6: Run full API suite (no regression)**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS — existing tests send no `session` cookie (header auth), so CSRF is inert for them.

- [ ] **Step 7: Lint + commit**

```bash
git add src/data_rover/api/csrf.py src/data_rover/api/main.py tests/api/test_csrf.py
git commit -m "feat(api): CSRF middleware guarding cookie-authenticated writes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Auth routes (`/auth/login|logout|me|change-password`)

**Files:**
- Create: `src/data_rover/api/routes/auth.py`
- Modify: `src/data_rover/api/main.py` (mount router)
- Test: `tests/api/test_auth.py`

**Interfaces:**
- Consumes: `auth.*`, `tenancy.get_user_by_email`, `get_current_user`, `verify_password`.
- Produces: router mounted at `/api/v1/auth`; `MeOut {user_id, email, is_admin}`.

- [ ] **Step 1: Write failing route tests**

Append to `tests/api/test_auth.py` (self-contained — each test builds its own `TestClient(create_app())` via the `_client()` helper below; the conftest's in-memory SQLite + per-test schema reset still apply):

```python
from fastapi.testclient import TestClient

from data_rover.api import tenancy, db as _db
from data_rover.api.main import create_app


def _client() -> TestClient:
    return TestClient(create_app())


def _make_user(email: str, pw: str, *, admin: bool = False, active: bool = True):
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
```

Note: `create_app()` runs against the conftest's in-memory SQLite (env pins `DATA_ROVER_DEV_SEED=false`). The default provider would be `cookie` here because these tests don't rely on the conftest env pin of `header` — but `create_app` reads `identity_provider` from settings, which the conftest pins to `header`. To force cookie auth for THIS app instance, set it explicitly before `create_app`: in `_client()` use a monkeypatch-free approach — set `os.environ["DATA_ROVER_IDENTITY_PROVIDER"] = "cookie"` at the top of `test_auth.py`'s route-test section via a module-level fixture:

```python
@pytest.fixture(autouse=True)
def _cookie_provider(monkeypatch):
    monkeypatch.setenv("DATA_ROVER_IDENTITY_PROVIDER", "cookie")
    # a real secret so create_app()'s _guard_prod_secret doesn't refuse to boot
    # (tests run with dev_seed=false, which would otherwise trip the guard).
    monkeypatch.setenv("DATA_ROVER_JWT_SECRET", "test-secret-not-the-default")
    from data_rover.api.identity import set_identity_provider
    set_identity_provider(None)  # rebuild from the patched setting
    yield
    set_identity_provider(None)
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py -k "login_me_logout or bad_password or inactive" -v`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Implement `routes/auth.py`**

Create `src/data_rover/api/routes/auth.py`:

```python
"""Local-auth routes: login (issue cookie), logout (clear), me, change-password.

Unauthenticated except /me and /change-password. Login failures are uniform
(no user-enumeration: unknown email and wrong password both 401 'invalid
credentials'). These mount at /api/v1/auth (not project-scoped)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, tenancy
from ..db import get_db
from ..db_models import User
from ..identity import get_current_user

router = APIRouter()


class LoginIn(BaseModel):
    email: str
    password: str


class MeOut(BaseModel):
    user_id: str
    email: str
    is_admin: bool


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str


_MIN_PW_LEN = 8


@router.post("/auth/login", response_model=MeOut)
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)) -> MeOut:
    user = tenancy.get_user_by_email(db, body.email)
    if (
        user is None
        or not user.is_active
        or not auth.verify_password(body.password, user.password_hash)
    ):
        raise HTTPException(status_code=401, detail="invalid credentials")
    auth.set_session_cookie(response, auth.mint_token(user.id, user.is_admin))
    return MeOut(user_id=user.id, email=user.email, is_admin=user.is_admin)


@router.post("/auth/logout", status_code=204)
def logout(response: Response) -> Response:
    auth.clear_session_cookie(response)
    return Response(status_code=204)


@router.get("/auth/me", response_model=MeOut)
def me(user: User = Depends(get_current_user)) -> MeOut:
    return MeOut(user_id=user.id, email=user.email, is_admin=user.is_admin)


@router.post("/auth/change-password", status_code=204)
def change_password(
    body: ChangePasswordIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    if not auth.verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid credentials")
    if len(body.new_password) < _MIN_PW_LEN:
        raise HTTPException(status_code=422, detail="password too short")
    tenancy.set_user_fields(db, user.id, password=body.new_password)
    return Response(status_code=204)
```

- [ ] **Step 4: Mount the router**

In `main.py`, add `auth` to the `from .routes import (...)` block, and after `register_exception_handlers(app)` / before the projects router (line 223-224) add:

```python
    app.include_router(auth.router, prefix="/api/v1", tags=["auth"])
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py -v`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
git add src/data_rover/api/routes/auth.py src/data_rover/api/main.py tests/api/test_auth.py
git commit -m "feat(api): /auth login/logout/me/change-password routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Admin routes (user CRUD + membership management)

**Files:**
- Create: `src/data_rover/api/routes/admin.py`
- Modify: `src/data_rover/api/main.py` (mount)
- Test: `tests/api/test_admin.py`

**Interfaces:**
- Consumes: `require_admin`, `tenancy.{create_user,list_users,set_user_fields,delete_user,list_members,add_member,remove_member}`.
- Produces: router at `/api/v1/admin`; `AdminUserOut {id,email,is_admin,is_active}`.

- [ ] **Step 1: Write failing route tests**

Append to `tests/api/test_admin.py` (reuse the `_cookie_provider` autouse fixture pattern from Task 7 — add it to this module too, or factor it into conftest; here we add it locally):

```python
import pytest
from fastapi.testclient import TestClient

from data_rover.api import db as _db, tenancy
from data_rover.api.main import create_app

CSRF = {"x-requested-with": "data-rover"}


@pytest.fixture(autouse=True)
def _cookie_provider(monkeypatch):
    monkeypatch.setenv("DATA_ROVER_IDENTITY_PROVIDER", "cookie")
    monkeypatch.setenv("DATA_ROVER_JWT_SECRET", "test-secret-not-the-default")
    from data_rover.api.identity import set_identity_provider
    set_identity_provider(None)
    yield
    set_identity_provider(None)


def _seed_admin(email="admin@x", pw="pw"):
    gen = _db.get_db(); s = next(gen)
    try:
        tenancy.create_user(s, email, pw, is_admin=True)
    finally:
        gen.close()


def _as_admin() -> TestClient:
    _seed_admin()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "admin@x", "password": "pw"})
    return c


def test_admin_can_create_list_patch_delete_user() -> None:
    c = _as_admin()
    r = c.post("/api/v1/admin/users",
               json={"email": "bob@x", "password": "secret12", "is_admin": False},
               headers=CSRF)
    assert r.status_code == 201, r.text
    uid = r.json()["id"]
    assert any(u["email"] == "bob@x" for u in c.get("/api/v1/admin/users").json())
    assert c.patch(f"/api/v1/admin/users/{uid}", json={"is_admin": True},
                   headers=CSRF).status_code == 200
    assert c.delete(f"/api/v1/admin/users/{uid}", headers=CSRF).status_code == 204


def test_create_user_duplicate_email_409() -> None:
    c = _as_admin()
    body = {"email": "bob@x", "password": "secret12", "is_admin": False}
    assert c.post("/api/v1/admin/users", json=body, headers=CSRF).status_code == 201
    assert c.post("/api/v1/admin/users", json=body, headers=CSRF).status_code == 409


def test_non_admin_blocked_403() -> None:
    _seed_admin()
    gen = _db.get_db(); s = next(gen)
    try:
        tenancy.create_user(s, "joe@x", "pw123456", is_admin=False)
    finally:
        gen.close()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "joe@x", "password": "pw123456"})
    assert c.get("/api/v1/admin/users").status_code == 403
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_admin.py -k "create_list_patch or duplicate_email_409 or non_admin_blocked" -v`
Expected: FAIL — 404 (routes not mounted).

- [ ] **Step 3: Implement `routes/admin.py`**

Create `src/data_rover/api/routes/admin.py`:

```python
"""Admin console routes (all require_admin): user CRUD + system-wide project
membership management. Membership management lives here (not on per-project
owner routes) per the centralized-admin design decision."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import tenancy
from ..authz import require_admin
from ..db import get_db
from ..db_models import Role, User

router = APIRouter(dependencies=[Depends(require_admin)])


class AdminUserCreate(BaseModel):
    email: str
    password: str
    is_admin: bool = False


class AdminUserPatch(BaseModel):
    is_admin: bool | None = None
    is_active: bool | None = None
    password: str | None = None


class AdminUserOut(BaseModel):
    id: str
    email: str
    is_admin: bool
    is_active: bool


class MemberIn(BaseModel):
    user_id: str
    role: Role


class MemberOut(BaseModel):
    user_id: str
    email: str
    role: Role


def _out(u: User) -> AdminUserOut:
    return AdminUserOut(
        id=u.id, email=u.email, is_admin=u.is_admin, is_active=u.is_active
    )


@router.get("/admin/users", response_model=list[AdminUserOut])
def list_users(q: str = "", db: Session = Depends(get_db)) -> list[AdminUserOut]:
    return [_out(u) for u in tenancy.list_users(db, q)]


@router.post("/admin/users", response_model=AdminUserOut, status_code=201)
def create_user(body: AdminUserCreate, db: Session = Depends(get_db)) -> AdminUserOut:
    try:
        u = tenancy.create_user(db, body.email, body.password, body.is_admin)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _out(u)


@router.patch("/admin/users/{user_id}", response_model=AdminUserOut)
def patch_user(
    user_id: str, body: AdminUserPatch, db: Session = Depends(get_db)
) -> AdminUserOut:
    try:
        u = tenancy.set_user_fields(
            db,
            user_id,
            is_admin=body.is_admin,
            is_active=body.is_active,
            password=body.password,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _out(u)


@router.delete("/admin/users/{user_id}", status_code=204)
def delete_user(user_id: str, db: Session = Depends(get_db)) -> Response:
    tenancy.delete_user(db, user_id)
    return Response(status_code=204)


@router.get("/admin/projects/{project_id}/members", response_model=list[MemberOut])
def list_members(project_id: str, db: Session = Depends(get_db)) -> list[MemberOut]:
    return [
        MemberOut(user_id=m.user_id, email=m.user.email, role=m.role)
        for m in tenancy.list_members(db, project_id)
    ]


@router.post(
    "/admin/projects/{project_id}/members", response_model=MemberOut, status_code=201
)
def add_member(
    project_id: str, body: MemberIn, db: Session = Depends(get_db)
) -> MemberOut:
    user = db.get(User, body.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="unknown user")
    m = tenancy.add_member(db, project_id, body.user_id, body.role)
    return MemberOut(user_id=m.user_id, email=user.email, role=m.role)


@router.delete(
    "/admin/projects/{project_id}/members/{user_id}", status_code=204
)
def remove_member(
    project_id: str, user_id: str, db: Session = Depends(get_db)
) -> Response:
    try:
        tenancy.remove_member(db, project_id, user_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(status_code=204)
```

- [ ] **Step 4: Mount the router**

In `main.py`, add `admin` to `from .routes import (...)`, and after the auth router mount add:

```python
    app.include_router(admin.router, prefix="/api/v1", tags=["admin"])
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_admin.py -v`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
git add src/data_rover/api/routes/admin.py src/data_rover/api/main.py tests/api/test_admin.py
git commit -m "feat(api): admin routes for user CRUD + project membership management

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Re-gate projects + admin-sees-all + create-project wizard

**Files:**
- Modify: `src/data_rover/api/routes/projects.py`
- Modify: `src/data_rover/api/tenancy.py` (`list_all_projects`)
- Modify: `pixi.toml` (ensure `python-multipart` present for `Form`/`UploadFile`)
- Test: `tests/api/test_projects_wizard.py` (new)

**Interfaces:**
- Consumes: `require_admin`, `importer.import_project`, `tenancy.list_projects_for_user`.
- Produces: `tenancy.list_all_projects(db) -> list[Project]`; `GET /projects` returns all for admins; `POST /projects` is admin-only multipart wizard.

- [ ] **Step 1: Ensure the multipart dependency**

FastAPI needs `python-multipart` for `Form`/`UploadFile`. Check it resolves; if `import multipart` fails, add to `pixi.toml` `[feature.api.dependencies]`:

```toml
python-multipart = "0.0.*"
```

Run: `pixi run -e api python -c "import multipart; print('ok')"`
Expected: `ok` (add the dep and `pixi install` if it errors).

- [ ] **Step 2: Write failing wizard + visibility tests**

Create `tests/api/test_projects_wizard.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db as _db, tenancy
from data_rover.api.main import create_app

CSRF = {"x-requested-with": "data-rover"}
_MM = (Path(__file__).resolve().parents[2] / "examples" / "smart-city.metamodel.yaml")


@pytest.fixture(autouse=True)
def _cookie_provider(monkeypatch):
    monkeypatch.setenv("DATA_ROVER_IDENTITY_PROVIDER", "cookie")
    monkeypatch.setenv("DATA_ROVER_JWT_SECRET", "test-secret-not-the-default")
    from data_rover.api.identity import set_identity_provider
    set_identity_provider(None)
    yield
    set_identity_provider(None)


def _as_admin() -> TestClient:
    gen = _db.get_db(); s = next(gen)
    try:
        tenancy.create_user(s, "admin@x", "pw123456", is_admin=True)
    finally:
        gen.close()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "admin@x", "password": "pw123456"})
    return c


def test_wizard_creates_project_with_empty_model() -> None:
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Fresh"},
            files={"metamodel": ("mm.yaml", fh, "application/yaml")},
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    summary = c.get(f"/api/v1/projects/{pid}/model/summary")
    assert summary.status_code == 200
    assert summary.json()["element_count"] == 0


def test_wizard_rejects_bad_metamodel_422_no_orphan() -> None:
    c = _as_admin()
    r = c.post(
        "/api/v1/projects",
        data={"name": "Bad"},
        files={"metamodel": ("mm.yaml", b"not: [valid", "application/yaml")},
        headers=CSRF,
    )
    assert r.status_code == 422
    assert c.get("/api/v1/projects").json() == [] or all(
        p["name"] != "Bad" for p in c.get("/api/v1/projects").json()
    )


def test_admin_sees_all_projects() -> None:
    from data_rover.api.db_models import Project, Role
    c = _as_admin()
    # a project the admin is NOT a member of
    gen = _db.get_db(); s = next(gen)
    try:
        other = tenancy.create_user(s, "other@x", "pw123456", is_admin=False)
        s.add(Project(id="p-other", name="Other")); s.commit()
        tenancy.add_member(s, "p-other", other.id, Role.owner)
    finally:
        gen.close()
    names = {p["name"] for p in c.get("/api/v1/projects").json()}
    assert "Other" in names


def test_non_admin_cannot_create_project_403() -> None:
    _as_admin()  # ensure schema/admin exist
    gen = _db.get_db(); s = next(gen)
    try:
        tenancy.create_user(s, "joe@x", "pw123456", is_admin=False)
    finally:
        gen.close()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "joe@x", "password": "pw123456"})
    r = c.post("/api/v1/projects", data={"name": "Nope"},
               files={"metamodel": ("mm.yaml", b"x", "application/yaml")}, headers=CSRF)
    assert r.status_code == 403
```

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_projects_wizard.py -v`
Expected: FAIL — current `POST /projects` is JSON-only / not admin-gated; multipart call 422s on body parsing or returns wrong status.

- [ ] **Step 4: Add `list_all_projects` to tenancy**

In `tenancy.py`, after `list_projects_for_user`:

```python
def list_all_projects(db: Session) -> list[Project]:
    """Every project (admin view). Role is synthesized as owner by the caller."""
    return list(db.execute(select(Project).order_by(Project.name)).scalars())
```

- [ ] **Step 5: Rewrite the project routes**

In `routes/projects.py`:

Replace the imports block to add what we need (and the pre-validation imports):

```python
import json
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile

from data_rover.core.metamodel.loader import load_metamodel_str

from .. import importer, tenancy
from ..authz import require_admin, require_membership  # require_owner no longer used here
from ._snapshot import build_model_from_dicts
```

The empty-model JSON (verified against `build_model_from_dicts`, which reads `elements`/`relationships` as **lists**, missing keys ⇒ empty) is:

```python
#: model JSON for a project created with no uploaded model (conforms to any
#: metamodel — no entities to guard). build_model_from_dicts reads these as lists.
EMPTY_MODEL_JSON = '{"elements": [], "relationships": []}'
```

**Pre-validation is required:** `importer.import_project` commits the project/metamodel rows *before* it parses the metamodel and builds the model (see `importer.py:38-69`), so a bad upload would leave an orphan project. The route therefore parses the metamodel and builds the model itself first (same guards, raising 422), and only then calls `import_project` (whose re-parse of the identical input then cannot fail).

Rewrite `create_project` and `list_projects`:

```python
@router.get("/projects", response_model=list[ProjectOut])
def list_projects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectOut]:
    if user.is_admin:
        return [ProjectOut(id=p.id, name=p.name, role=Role.owner)
                for p in tenancy.list_all_projects(db)]
    return [
        ProjectOut(id=p.id, name=p.name, role=role)
        for p, role in tenancy.list_projects_for_user(db, user.id)
    ]


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(
    name: str = Form(...),
    metamodel: UploadFile = File(...),
    model: UploadFile | None = File(default=None),
    view: UploadFile | None = File(default=None),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> ProjectOut:
    metamodel_yaml = metamodel.file.read().decode("utf-8")
    model_json = model.file.read().decode("utf-8") if model is not None else EMPTY_MODEL_JSON
    view_json = view.file.read().decode("utf-8") if view is not None else None

    # Pre-validate BEFORE import_project (which commits rows before it parses):
    # a bad metamodel/model must 422 without leaving an orphan project.
    try:
        mm = load_metamodel_str(metamodel_yaml)
        build_model_from_dicts(mm, json.loads(model_json))
    except HTTPException:
        raise  # build_model_from_dicts already raises 422 with a precise detail
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"invalid upload: {exc}") from exc

    project_id = uuid.uuid4().hex
    importer.import_project(
        project_id=project_id,
        name=name,
        owner_id=admin.id,
        metamodel_yaml=metamodel_yaml,
        model_json=model_json,
        view_json=view_json,
    )
    return ProjectOut(id=project_id, name=name, role=Role.owner)
```

(`File(...)` is used rather than `Form(...)` for the upload fields so FastAPI treats them as multipart file parts; `name` stays `Form(...)`.)

Re-gate delete to admin:

```python
@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    tenancy.delete_project(db, project_id)
    get_registry().evict(project_id)
    return Response(status_code=204)
```

The per-project `/members` routes in this file: **remove** them (membership management now lives in `routes/admin.py` under `require_admin`) OR leave them but change `require_owner` → `require_admin`. Choose removal to avoid two entry points; delete `add_member`/`remove_member`/`list_members` and the now-unused `MemberIn`/`MemberOut` from `projects.py`, and drop the `require_owner` import. (If any existing test references `/projects/{id}/members`, update it to the `/admin/...` path.)

- [ ] **Step 6: Check for now-broken existing tests**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: any test that posted JSON to `POST /projects` or used `/projects/{id}/members` now fails. Update those call sites: project creation in tests becomes the multipart wizard (or seed via `tenancy.create_project` directly in setup); membership ops move to `/api/v1/admin/projects/{id}/members`. Fix each until green.

- [ ] **Step 7: Run the wizard tests to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_projects_wizard.py -v`
Expected: PASS.

- [ ] **Step 8: Lint + commit**

```bash
git add src/data_rover/api/routes/projects.py src/data_rover/api/tenancy.py pixi.toml pixi.lock tests/
git commit -m "feat(api): admin-gated project create wizard + admin-sees-all listing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Bootstrap admin + prod secret guard + dev-seed reconciliation

**Files:**
- Modify: `src/data_rover/api/main.py` (`create_app`, new `_ensure_bootstrap_admin`)
- Test: `tests/api/test_auth.py`

**Interfaces:**
- Consumes: `tenancy.get_user_by_email`, `tenancy.create_user`, `tenancy.set_user_fields`, `Settings.bootstrap_admin_*`, `Settings.identity_provider`, `Settings.jwt_secret`, `Settings.dev_seed`.
- Produces: `_ensure_bootstrap_admin(settings) -> None` (idempotent).

- [ ] **Step 1: Write failing test**

Append to `tests/api/test_auth.py`:

```python
def test_bootstrap_admin_created_idempotently(monkeypatch) -> None:
    monkeypatch.setenv("DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL", "root@x")
    monkeypatch.setenv("DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD", "rootpw123")
    monkeypatch.setenv("DATA_ROVER_IDENTITY_PROVIDER", "cookie")
    from data_rover.api.main import _ensure_bootstrap_admin
    from data_rover.api.settings import get_settings
    _ensure_bootstrap_admin(get_settings())
    _ensure_bootstrap_admin(get_settings())  # idempotent: no duplicate / no error
    gen = _db.get_db(); s = next(gen)
    try:
        u = tenancy.get_user_by_email(s, "root@x")
        assert u is not None and u.is_admin is True
    finally:
        gen.close()


def test_guard_refuses_insecure_secret_in_prod() -> None:
    from data_rover.api.main import _guard_prod_secret
    from data_rover.api.settings import Settings
    s = Settings(
        identity_provider="cookie",
        dev_seed=False,
        jwt_secret="dev-insecure-secret-change-me",
    )
    with pytest.raises(RuntimeError):
        _guard_prod_secret(s)
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py -k "bootstrap_admin_created or guard_refuses" -v`
Expected: FAIL — `ImportError: cannot import name '_ensure_bootstrap_admin'` / `_guard_prod_secret`.

- [ ] **Step 3: Implement bootstrap + secret guard in `main.py`**

Add to `main.py` (after `_ensure_dev_seed`):

```python
def _ensure_bootstrap_admin(settings: Settings) -> None:
    """Idempotently ensure an admin exists (from DATA_ROVER_BOOTSTRAP_ADMIN_*),
    so a fresh deploy has a first admin to log in as (admin-only provisioning
    means no self-signup). Independent of dev_seed. No-op if email is unset."""
    if not settings.bootstrap_admin_email:
        return
    from .db import db_session
    with db_session() as s:
        existing = tenancy.get_user_by_email(s, settings.bootstrap_admin_email)
        if existing is None:
            tenancy.create_user(
                s,
                settings.bootstrap_admin_email,
                settings.bootstrap_admin_password,
                is_admin=True,
            )
        elif not existing.is_admin:
            tenancy.set_user_fields(s, existing.id, is_admin=True)


def _guard_prod_secret(settings: Settings) -> None:
    """Refuse to boot the cookie provider in a non-dev deploy still using the
    insecure default JWT secret."""
    insecure_default = "dev-insecure-secret-change-me"
    if (
        settings.identity_provider == "cookie"
        and not settings.dev_seed
        and settings.jwt_secret == insecure_default
    ):
        raise RuntimeError(
            "DATA_ROVER_JWT_SECRET must be set when identity_provider=cookie "
            "and dev_seed=false (refusing to sign tokens with the dev default)"
        )
```

In `create_app`, after `init_engine(...)` and before/after the dev-seed block, call both:

```python
    _guard_prod_secret(settings)
    if settings.dev_seed:
        _ensure_dev_seed(settings)
    _ensure_bootstrap_admin(settings)
```

Also extend `_ensure_dev_seed`: after `_provision_dev_users(...)`, seed a dev admin so local login works out of the box if no bootstrap env is set:

```python
    # dev convenience: a known admin login (overridden by BOOTSTRAP_ADMIN_* if set)
    if not settings.bootstrap_admin_email:
        from .db import db_session
        with db_session() as s:
            if tenancy.get_user_by_email(s, "admin@example.com") is None:
                tenancy.create_user(s, "admin@example.com", "admin12345", is_admin=True)
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_auth.py::test_bootstrap_admin_created_idempotently -v`
Expected: PASS.

- [ ] **Step 5: Full suite + lint**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/main.py tests/api/test_auth.py
git commit -m "feat(api): bootstrap admin on startup + prod JWT-secret guard + dev admin seed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the entire backend test suite: `pixi run -e core-dev pytest tests -q` — all pass.
- [ ] `pixi run lint-backend` — ruff, mypy, pyright all clean.
- [ ] `pixi run -e api alembic upgrade head --sql` renders through 0006 without error.
- [ ] Manual smoke (optional): `DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=root@x DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=rootpw123 DATA_ROVER_AUTH_COOKIE_SECURE=false pixi run start-backend`, then `curl -i -X POST localhost:8000/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"root@x","password":"rootpw123"}'` returns a `set-cookie: session=...` and 200.

## Notes for the frontend plan (separate document)

The frontend plan (`/login`, `/projects`, `/admin`, workspace → `/p/[projectId]`, dynamic base URL, `credentials: 'include'`, CSRF header) depends on this backend being merged. Contract summary the frontend will consume:
- `POST /api/v1/auth/login {email,password}` → 200 `{user_id,email,is_admin}` + cookie; 401 on failure.
- `GET /api/v1/auth/me` → 200 `{user_id,email,is_admin}` / 401.
- `POST /api/v1/auth/logout` → 204 (send CSRF header).
- `GET /api/v1/projects` → `[{id,name,role}]` (all for admins).
- `POST /api/v1/projects` → multipart `{name, metamodel, model?, view?}` → 201 `{id,name,role}`.
- `/api/v1/admin/users` GET/POST, `/admin/users/{id}` PATCH/DELETE, `/admin/projects/{id}/members` GET/POST, `/admin/projects/{id}/members/{user_id}` DELETE — all require admin.
- All unsafe cookie-authed requests must send `X-Requested-With: data-rover`.
