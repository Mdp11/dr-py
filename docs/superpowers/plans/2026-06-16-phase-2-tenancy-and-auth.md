# Phase 2 — Tenancy + Auth Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the per-project in-memory `SessionRegistry` from Phase 1 into a real multi-user, multi-project backend: persist `User`/`Project`/`Membership` in Postgres, authenticate every request through a pluggable `IdentityProvider` seam (a dev/header provider now), authorize each request against project membership, and move project routing from the `X-Project-Id` header to a `/api/v1/projects/{project_id}/...` path segment.

**Architecture:** A new SQLAlchemy 2.0 (sync) persistence layer (`db.py` + `db_models.py` + `tenancy.py`) backs three tables. An `IdentityProvider` seam (`identity.py`) resolves a trusted-header dev identity into a `User` row (auto-provisioned). An authorization dependency (`authz.py`) gates each project-scoped request on membership (404 unknown project / 403 non-member / 403 viewer-writes-blocked). `deps.get_request_session` is rewired to resolve the project from the path param **after** membership passes, so the existing route files need **zero signature changes** — only the router mount prefix moves. A `projects` router adds project + membership CRUD. Production runs Postgres via Alembic migrations; the test suite runs hermetic in-memory SQLite (no external service). A dev-seed bootstrap keeps the existing single-user frontend + e2e working against `/projects/default`.

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI (sync routes), SQLAlchemy 2.0 + psycopg v3 (Postgres) / SQLite (tests), Alembic, Pydantic v2, pytest, pixi (`api`/`core-dev` envs). Reference: `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md` §5, §6, §12; this is **Phase 2** of the 8-phase table.

**Decisions locked (from planning):**
- Postgres now via SQLAlchemy + Alembic; routes stay **sync** (`def`), so SQLAlchemy is used synchronously.
- Project routing moves to the `/projects/{project_id}` **path segment** (the header form from Phase 1 is removed).
- Identity ships as a **dev header provider** behind the seam (`X-User-Id` / `X-User-Email`); real SSO is a later swap.
- The **test suite runs SQLite in-memory**; production/dev runs Postgres. Models are DB-agnostic; Alembic targets Postgres.

**Scope note:** This phase delivers tenancy + auth + path routing. It does **not** add durable model persistence (commit journal + GCS — Phase 3), locking/commit (Phase 4), realtime (Phase 5), or the project-picker UX (later). The in-memory model session is still loaded via the existing load/upload endpoints; the DB only holds tenancy rows. Frontend changes are limited to the minimum needed to keep the current single-user app + e2e green under the new routing.

**Green-at-every-commit strategy:** Tasks 1–7 are purely additive (new modules, new tests, a new `projects` router) — every existing test keeps passing because the data routes and `get_request_session` are untouched. The single breaking change (mount data routers under `{project_id}` + rewire `get_request_session` to require membership + migrate the existing API tests) all lands in **Task 8** as one coherent commit. Tasks 9–11 are productionization (Alembic), integration (frontend/e2e/dev-seed), and docs.

---

## File structure

**New (backend):**
- `src/data_rover/api/db.py` — SQLAlchemy `Base`, engine/sessionmaker lifecycle, `get_db` dependency, `create_all`/`drop_all`.
- `src/data_rover/api/db_models.py` — ORM models `User`, `Project`, `Membership` + `Role` enum.
- `src/data_rover/api/tenancy.py` — tenancy service functions (upsert user, create/delete project, membership CRUD, queries).
- `src/data_rover/api/identity.py` — `Identity`, `IdentityProvider` protocol, `DevHeaderIdentityProvider`, `get_current_user` dependency, provider seam getter/setter.
- `src/data_rover/api/authz.py` — `require_membership` / `require_owner` dependencies + write-method gating.
- `src/data_rover/api/routes/projects.py` — project + membership CRUD router.
- `alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`, `alembic/versions/0001_initial.py` — migrations.

**Modified (backend):**
- `src/data_rover/api/settings.py` — `database_url`, identity header names, `dev_seed`.
- `src/data_rover/api/deps.py` — rewire `get_request_session` (path param + membership).
- `src/data_rover/api/main.py` — `init_engine`, mount `projects` router, mount data routers under `/projects/{project_id}`, dev-seed.
- `pixi.toml` — add `sqlalchemy`, `alembic`, `psycopg` to the `api` feature; add `db-upgrade`/`db-revision` tasks.
- `CLAUDE.md` — document tenancy/auth/routing.

**New / modified (tests):**
- `tests/api/conftest.py` (create) — SQLite engine setup, per-test table create/drop, seed + auth-client fixtures, `papi()` helper.
- `tests/api/test_db.py`, `test_db_models.py`, `test_tenancy.py`, `test_identity.py`, `test_authz.py`, `test_projects_route.py`, `test_alembic.py` (create).
- All existing `tests/api/test_*.py` data tests — migrated to project-scoped URLs + auth client (Task 8).

**New / modified (frontend):**
- `frontend/src/lib/api/client.ts` — `projectId` + identity headers in config; base becomes `/api/v1/projects/{projectId}`.
- `frontend/src/lib/api/__tests__/*` — base URL constants updated.
- `frontend/playwright.config.*` / e2e backend bootstrap — run backend with SQLite + dev-seed.

---

### Task 1: Dependencies + settings

Add the DB/migration toolchain and the new settings fields. No behavior change yet.

**Files:**
- Modify: `pixi.toml` (`[feature.api.dependencies]` + two tasks)
- Modify: `src/data_rover/api/settings.py`
- Test: `tests/api/test_settings.py` (create)

- [ ] **Step 1: Add the dependencies to pixi**

In `pixi.toml`, under `[feature.api.dependencies]`, add three lines after `httpx = "0.27.*"`:

```toml
sqlalchemy = "2.0.*"
alembic = "1.14.*"
psycopg = "3.2.*"
```

(`psycopg` on conda-forge is psycopg v3; the SQLAlchemy URL scheme is `postgresql+psycopg://`. SQLite needs no extra dependency — it is stdlib.)

- [ ] **Step 2: Add the Alembic pixi tasks**

In `pixi.toml`, add after the `[feature.api.tasks.start-backend]` block:

```toml
[feature.api.tasks.db-upgrade]
cmd = "alembic upgrade head"
default-environment = "api"

[feature.api.tasks.db-revision]
args = [{ arg = "message", default = "migration" }]
cmd = "alembic revision --autogenerate -m \"{{ message }}\""
default-environment = "api"
```

- [ ] **Step 3: Install**

Run: `pixi install -e core-dev`
Expected: resolves and installs sqlalchemy, alembic, psycopg (core-dev includes the `api` feature, so test/lint env gets them).

- [ ] **Step 4: Write the failing settings test**

Create `tests/api/test_settings.py`:

```python
from __future__ import annotations

from data_rover.api.settings import Settings


def test_defaults_present() -> None:
    s = Settings()
    assert s.database_url.startswith("postgresql+psycopg://")
    assert s.identity_user_header == "x-user-id"
    assert s.identity_email_header == "x-user-email"
    assert s.dev_seed is True


def test_env_override(monkeypatch) -> None:
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", "sqlite://")
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "false")
    s = Settings()
    assert s.database_url == "sqlite://"
    assert s.dev_seed is False
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_settings.py -v`
Expected: FAIL — `AttributeError`/validation error: `Settings` has no `database_url`/`dev_seed`.

- [ ] **Step 6: Add the settings fields**

In `src/data_rover/api/settings.py`, add to the `Settings` class (after `cors_origins`):

```python
    #: SQLAlchemy URL for the tenancy database. Production/dev default to a
    #: local Postgres (psycopg v3 driver); the test suite overrides this to
    #: ``sqlite://`` (in-memory) via the env. The engine is created lazily, so
    #: importing the app never connects.
    database_url: str = (
        "postgresql+psycopg://data_rover:data_rover@localhost:5432/data_rover"
    )
    #: Request headers the dev IdentityProvider trusts. Case-insensitive
    #: (Starlette headers are). A real SSO provider replaces the provider, not
    #: these names.
    identity_user_header: str = "x-user-id"
    identity_email_header: str = "x-user-email"
    #: When true, ``create_app`` creates the schema (SQLite/dev convenience)
    #: and ensures a ``default`` user+project exist so the single-user frontend
    #: works without a project picker. MUST be false in production (Postgres
    #: schema is owned by Alembic): set ``DATA_ROVER_DEV_SEED=false``.
    dev_seed: bool = True
```

- [ ] **Step 7: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_settings.py -v`
Expected: PASS (2 passed).

- [ ] **Step 8: Commit**

```bash
git add pixi.toml pixi.lock src/data_rover/api/settings.py tests/api/test_settings.py
git commit -m "build(api): add SQLAlchemy/Alembic/psycopg deps + tenancy settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `db.py` — engine lifecycle + test conftest

The SQLAlchemy `Base`, an idempotent engine/sessionmaker, the `get_db` request dependency, and schema helpers. Also lands the shared test conftest (DB fixtures) so every later test task has a clean SQLite DB.

**Files:**
- Create: `src/data_rover/api/db.py`
- Create: `tests/api/conftest.py`
- Test: `tests/api/test_db.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_db.py`:

```python
from __future__ import annotations

from sqlalchemy import text

from data_rover.api import db


def test_init_engine_is_idempotent_for_same_url() -> None:
    e1 = db.init_engine("sqlite://")
    e2 = db.init_engine("sqlite://")
    assert e1 is e2


def test_init_engine_force_rebuilds() -> None:
    e1 = db.init_engine("sqlite://")
    e2 = db.init_engine("sqlite://", force=True)
    assert e1 is not e2


def test_get_db_yields_usable_session() -> None:
    db.init_engine("sqlite://", force=True)
    gen = db.get_db()
    session = next(gen)
    try:
        assert session.execute(text("SELECT 1")).scalar() == 1
    finally:
        gen.close()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_db.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.db`.

- [ ] **Step 3: Implement `db.py`**

Create `src/data_rover/api/db.py`:

```python
"""SQLAlchemy engine lifecycle for the tenancy database.

The engine is process-global and built lazily from a URL. ``init_engine`` is
idempotent for a given URL (so ``create_app`` and the test conftest can both
call it without clobbering each other's engine), with ``force=True`` to rebuild
for test isolation. In-memory SQLite needs a ``StaticPool`` + single connection
so the schema created by one connection is visible to the request handlers
running on the same thread (FastAPI's ``TestClient`` is synchronous).

Production uses Postgres (psycopg v3); the schema there is owned by Alembic, so
``create_all`` is only used for SQLite/dev convenience and the test suite.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    """Declarative base for all tenancy ORM models."""


_engine: Engine | None = None
_engine_url: str | None = None
_SessionLocal: sessionmaker[Session] | None = None


def init_engine(database_url: str, *, force: bool = False) -> Engine:
    """Build (or reuse) the process-global engine + sessionmaker.

    Reuses the existing engine when called again with the same URL so repeated
    ``create_app`` calls in one test process keep the same in-memory SQLite db.
    """
    global _engine, _engine_url, _SessionLocal
    if _engine is not None and not force and database_url == _engine_url:
        return _engine
    if database_url.startswith("sqlite"):
        _engine = create_engine(
            database_url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
    else:
        _engine = create_engine(database_url, pool_pre_ping=True)
    _engine_url = database_url
    _SessionLocal = sessionmaker(
        bind=_engine, autoflush=False, expire_on_commit=False
    )
    return _engine


def get_engine() -> Engine:
    if _engine is None:
        raise RuntimeError("engine not initialised; call init_engine() first")
    return _engine


def create_all() -> None:
    """Create all tenancy tables (SQLite/dev + tests; Postgres uses Alembic)."""
    Base.metadata.create_all(get_engine())


def drop_all() -> None:
    Base.metadata.drop_all(get_engine())


def get_db() -> Iterator[Session]:
    """FastAPI dependency: yield a DB session, closing it afterwards."""
    if _SessionLocal is None:
        raise RuntimeError("engine not initialised; call init_engine() first")
    session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_db.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Add the shared test conftest**

Create `tests/api/conftest.py`. This sets the env to in-memory SQLite and disables dev-seed for **all** API tests, builds the schema once, and recreates tables per test for isolation. (Models are imported in Task 3; the import line is added there. Until then `create_all` finds no tables, which is harmless.)

```python
from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

# Force every API test onto an in-memory SQLite db and disable the dev seed
# BEFORE any app/settings import reads the environment.
os.environ.setdefault("DATA_ROVER_DATABASE_URL", "sqlite://")
os.environ.setdefault("DATA_ROVER_DEV_SEED", "false")

from data_rover.api import db  # noqa: E402
from data_rover.api.session import reset_session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db() -> Iterator[None]:
    """Per-test clean schema + clean in-memory session registry."""
    db.init_engine("sqlite://")
    db.create_all()
    reset_session()
    try:
        yield
    finally:
        db.drop_all()
        reset_session()
```

- [ ] **Step 6: Run the full API suite to confirm nothing regressed**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS (existing tests + the new db/settings tests). The autouse fixture is inert for the legacy tests.

- [ ] **Step 7: Lint/typecheck**

Run: `pixi run lint-backend`
Expected: ruff, mypy, pyright all pass.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/db.py tests/api/conftest.py tests/api/test_db.py
git commit -m "feat(api): SQLAlchemy engine lifecycle + SQLite test conftest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tenancy ORM models (`User`/`Project`/`Membership`)

**Files:**
- Create: `src/data_rover/api/db_models.py`
- Modify: `tests/api/conftest.py` (import models so `create_all` registers them)
- Test: `tests/api/test_db_models.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_db_models.py`:

```python
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User


def test_create_user_project_membership() -> None:
    with db.get_engine().connect():
        pass
    gen = db.get_db()
    session = next(gen)
    try:
        session.add(User(id="u1", email="u1@example.com"))
        session.add(Project(id="p1", name="Proj One"))
        session.add(Membership(user_id="u1", project_id="p1", role=Role.owner))
        session.commit()

        m = session.execute(select(Membership)).scalar_one()
        assert m.role is Role.owner
        assert m.user.email == "u1@example.com"
        assert m.project.name == "Proj One"
    finally:
        gen.close()


def test_membership_user_project_unique() -> None:
    gen = db.get_db()
    session = next(gen)
    try:
        session.add(User(id="u1", email=""))
        session.add(Project(id="p1", name="P"))
        session.add(Membership(user_id="u1", project_id="p1", role=Role.editor))
        session.commit()
        session.add(Membership(user_id="u1", project_id="p1", role=Role.viewer))
        with pytest.raises(IntegrityError):
            session.commit()
    finally:
        gen.close()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_db_models.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.db_models`.

- [ ] **Step 3: Implement the models**

Create `src/data_rover/api/db_models.py`:

```python
"""Tenancy ORM models: who exists, what projects exist, who can touch them.

These rows are the authorization source of truth. They are deliberately small
— the model/metamodel/view data is NOT stored here in Phase 2 (durable model
persistence is Phase 3); the in-memory ``Session`` still holds it. A ``User``'s
``id`` is the external identity subject (from the IdentityProvider), so a real
SSO swap reuses the same primary key space.
"""

from __future__ import annotations

import enum

from sqlalchemy import Enum as SAEnum
from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class Role(str, enum.Enum):
    """Project role. ``owner`` manages membership; ``editor`` writes the model;
    ``viewer`` is read-only (write attempts are rejected 403 in ``authz``)."""

    owner = "owner"
    editor = "editor"
    viewer = "viewer"


class User(Base):
    __tablename__ = "users"

    #: external identity subject id (stable across logins)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str] = mapped_column(String, default="", nullable=False)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)

    memberships: Mapped[list[Membership]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("user_id", "project_id", name="uq_membership_user_project"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[Role] = mapped_column(SAEnum(Role, name="role"), nullable=False)

    user: Mapped[User] = relationship(back_populates="memberships")
    project: Mapped[Project] = relationship(back_populates="memberships")
```

- [ ] **Step 4: Register the models in the test conftest**

In `tests/api/conftest.py`, add an import so `create_all` sees the tables. After the `from data_rover.api import db` line, add:

```python
from data_rover.api import db_models  # noqa: E402,F401  (registers ORM tables)
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_db_models.py -v`
Expected: PASS (2 passed).

- [ ] **Step 6: Lint/typecheck + full suite**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/db_models.py tests/api/conftest.py tests/api/test_db_models.py
git commit -m "feat(api): User/Project/Membership ORM models

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Tenancy service functions

A thin service layer over the ORM so routes/dependencies never hand-write queries. Pure functions taking a SQLAlchemy `Session`.

**Files:**
- Create: `src/data_rover/api/tenancy.py`
- Test: `tests/api/test_tenancy.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_tenancy.py`:

```python
from __future__ import annotations

import pytest

from data_rover.api import db, tenancy
from data_rover.api.db_models import Role


@pytest.fixture
def session():
    gen = db.get_db()
    s = next(gen)
    try:
        yield s
    finally:
        gen.close()


def test_upsert_user_creates_then_updates_email(session) -> None:
    u = tenancy.upsert_user(session, "u1", "a@x.com")
    assert u.email == "a@x.com"
    u2 = tenancy.upsert_user(session, "u1", "b@x.com")
    assert u2.id == "u1"
    assert u2.email == "b@x.com"


def test_create_project_makes_creator_owner(session) -> None:
    tenancy.upsert_user(session, "u1", "")
    p = tenancy.create_project(session, "My Project", "u1")
    assert p.name == "My Project"
    m = tenancy.get_membership(session, "u1", p.id)
    assert m is not None and m.role is Role.owner


def test_get_membership_none_for_non_member(session) -> None:
    tenancy.upsert_user(session, "u1", "")
    tenancy.upsert_user(session, "u2", "")
    p = tenancy.create_project(session, "P", "u1")
    assert tenancy.get_membership(session, "u2", p.id) is None


def test_list_projects_for_user(session) -> None:
    tenancy.upsert_user(session, "u1", "")
    a = tenancy.create_project(session, "A", "u1")
    b = tenancy.create_project(session, "B", "u1")
    got = {p.id for p, _role in tenancy.list_projects_for_user(session, "u1")}
    assert got == {a.id, b.id}


def test_add_update_remove_member(session) -> None:
    tenancy.upsert_user(session, "owner", "")
    tenancy.upsert_user(session, "u2", "")
    p = tenancy.create_project(session, "P", "owner")

    m = tenancy.add_member(session, p.id, "u2", Role.viewer)
    assert m.role is Role.viewer
    m2 = tenancy.add_member(session, p.id, "u2", Role.editor)  # upsert
    assert m2.role is Role.editor

    tenancy.remove_member(session, p.id, "u2")
    assert tenancy.get_membership(session, "u2", p.id) is None


def test_cannot_remove_last_owner(session) -> None:
    tenancy.upsert_user(session, "owner", "")
    p = tenancy.create_project(session, "P", "owner")
    with pytest.raises(ValueError):
        tenancy.remove_member(session, p.id, "owner")


def test_delete_project_cascades(session) -> None:
    tenancy.upsert_user(session, "owner", "")
    p = tenancy.create_project(session, "P", "owner")
    tenancy.delete_project(session, p.id)
    assert tenancy.get_membership(session, "owner", p.id) is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_tenancy.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.tenancy`.

- [ ] **Step 3: Implement the service**

Create `src/data_rover/api/tenancy.py`:

```python
"""Tenancy service functions over the ORM (no FastAPI here).

Each function takes a live SQLAlchemy ``Session`` and commits its own unit of
work. Routes/dependencies call these instead of writing queries inline.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db_models import Membership, Project, Role, User


def upsert_user(db: Session, user_id: str, email: str) -> User:
    """Return the user for *user_id*, creating it (or refreshing its email)."""
    user = db.get(User, user_id)
    if user is None:
        user = User(id=user_id, email=email)
        db.add(user)
        db.commit()
    elif email and user.email != email:
        user.email = email
        db.commit()
    return user


def create_project(db: Session, name: str, owner_id: str) -> Project:
    """Create a project and make *owner_id* its owner (one unit of work)."""
    project = Project(id=uuid.uuid4().hex, name=name)
    db.add(project)
    db.add(Membership(user_id=owner_id, project_id=project.id, role=Role.owner))
    db.commit()
    return project


def get_membership(db: Session, user_id: str, project_id: str) -> Membership | None:
    return db.execute(
        select(Membership).where(
            Membership.user_id == user_id,
            Membership.project_id == project_id,
        )
    ).scalar_one_or_none()


def list_projects_for_user(db: Session, user_id: str) -> list[tuple[Project, Role]]:
    rows = db.execute(
        select(Project, Membership.role)
        .join(Membership, Membership.project_id == Project.id)
        .where(Membership.user_id == user_id)
    ).all()
    return [(project, role) for project, role in rows]


def list_members(db: Session, project_id: str) -> list[Membership]:
    return list(
        db.execute(
            select(Membership).where(Membership.project_id == project_id)
        ).scalars()
    )


def add_member(db: Session, project_id: str, user_id: str, role: Role) -> Membership:
    """Add *user_id* to the project with *role*, or update an existing role."""
    m = get_membership(db, user_id, project_id)
    if m is None:
        m = Membership(user_id=user_id, project_id=project_id, role=role)
        db.add(m)
    else:
        m.role = role
    db.commit()
    return m


def _owner_count(db: Session, project_id: str) -> int:
    return sum(1 for m in list_members(db, project_id) if m.role is Role.owner)


def remove_member(db: Session, project_id: str, user_id: str) -> None:
    """Remove a member. Refuses to remove the last remaining owner."""
    m = get_membership(db, user_id, project_id)
    if m is None:
        return
    if m.role is Role.owner and _owner_count(db, project_id) <= 1:
        raise ValueError("cannot remove the last owner of a project")
    db.delete(m)
    db.commit()


def delete_project(db: Session, project_id: str) -> None:
    project = db.get(Project, project_id)
    if project is None:
        return
    db.delete(project)  # memberships cascade (ORM cascade + FK ON DELETE)
    db.commit()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_tenancy.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Lint/typecheck**

Run: `pixi run lint-backend`
Expected: ruff, mypy, pyright all pass.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/tenancy.py tests/api/test_tenancy.py
git commit -m "feat(api): tenancy service (users, projects, memberships)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Identity seam + `get_current_user`

The pluggable `IdentityProvider`, a trusted-header dev implementation, and the dependency that resolves a request into an auto-provisioned `User`.

**Files:**
- Create: `src/data_rover/api/identity.py`
- Test: `tests/api/test_identity.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_identity.py`:

```python
from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from data_rover.api import db
from data_rover.api.identity import (
    DevHeaderIdentityProvider,
    Identity,
    get_current_user,
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_identity.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.identity`.

- [ ] **Step 3: Implement the seam**

Create `src/data_rover/api/identity.py`:

```python
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
    """Swap the provider (real SSO in prod; reset to default with ``None``)."""
    global _provider
    _provider = provider


def get_current_user(
    request: Request, db: Session = Depends(get_db)
) -> User:
    """Resolve and auto-provision the requesting user.

    Auto-provision on first sight keeps the dev/gateway flow zero-setup; a
    later SSO integration can pre-create users instead without changing this.
    """
    identity = get_identity_provider().identify(request)
    return upsert_user(db, identity.user_id, identity.email)
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_identity.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Lint/typecheck**

Run: `pixi run lint-backend`
Expected: ruff, mypy, pyright all pass.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/identity.py tests/api/test_identity.py
git commit -m "feat(api): IdentityProvider seam + dev header provider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Authorization dependencies (`require_membership` / `require_owner`)

The gate: unknown project → 404, non-member → 403, viewer attempting a write → 403. Built and tested in isolation here (a throwaway app); `deps.get_request_session` is **not** rewired until Task 8, so the suite stays green.

**Files:**
- Create: `src/data_rover/api/authz.py`
- Test: `tests/api/test_authz.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_authz.py`. It mounts the dependencies on a tiny app so the path-param + method behavior is exercised exactly as in production.

```python
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from data_rover.api import db, tenancy
from data_rover.api.authz import require_membership, require_owner
from data_rover.api.db_models import Membership, Role


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()

    @app.get("/projects/{project_id}/read")
    def read(m: Membership = Depends(require_membership)) -> dict[str, str]:
        return {"role": m.role.value}

    @app.post("/projects/{project_id}/write")
    def write(m: Membership = Depends(require_membership)) -> dict[str, str]:
        return {"role": m.role.value}

    @app.post("/projects/{project_id}/model/search")
    def search(m: Membership = Depends(require_membership)) -> dict[str, str]:
        return {"role": m.role.value}

    @app.delete("/projects/{project_id}/owned", status_code=204)
    def owned(m: Membership = Depends(require_owner)) -> None:
        return None

    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _seed(owner="owner", member="viewer", role=Role.viewer):
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.upsert_user(s, owner, "")
        p = tenancy.create_project(s, "P", owner)
        if member:
            tenancy.upsert_user(s, member, "")
            tenancy.add_member(s, p.id, member, role)
        return p.id
    finally:
        gen.close()


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def test_unknown_project_404(client: TestClient) -> None:
    r = client.get("/projects/nope/read", headers=_h("owner"))
    assert r.status_code == 404


def test_non_member_403(client: TestClient) -> None:
    pid = _seed(member=None)
    r = client.get(f"/projects/{pid}/read", headers=_h("stranger"))
    assert r.status_code == 403


def test_member_can_read(client: TestClient) -> None:
    pid = _seed()
    r = client.get(f"/projects/{pid}/read", headers=_h("viewer"))
    assert r.status_code == 200
    assert r.json()["role"] == "viewer"


def test_viewer_cannot_write(client: TestClient) -> None:
    pid = _seed()
    r = client.post(f"/projects/{pid}/write", headers=_h("viewer"))
    assert r.status_code == 403


def test_editor_can_write(client: TestClient) -> None:
    pid = _seed(member="ed", role=Role.editor)
    r = client.post(f"/projects/{pid}/write", headers=_h("ed"))
    assert r.status_code == 200


def test_viewer_can_call_readonly_post(client: TestClient) -> None:
    pid = _seed()
    r = client.post(f"/projects/{pid}/model/search", headers=_h("viewer"))
    assert r.status_code == 200


def test_require_owner_rejects_editor(client: TestClient) -> None:
    pid = _seed(member="ed", role=Role.editor)
    r = client.delete(f"/projects/{pid}/owned", headers=_h("ed"))
    assert r.status_code == 403


def test_require_owner_allows_owner(client: TestClient) -> None:
    pid = _seed()
    r = client.delete(f"/projects/{pid}/owned", headers=_h("owner"))
    assert r.status_code == 204


def test_missing_identity_401(client: TestClient) -> None:
    pid = _seed()
    r = client.get(f"/projects/{pid}/read")
    assert r.status_code == 401
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_authz.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.authz`.

- [ ] **Step 3: Implement `authz.py`**

Create `src/data_rover/api/authz.py`:

```python
"""Authorization: gate project-scoped requests on membership + role.

``require_membership`` resolves the ``project_id`` path param, confirms the
project exists (404) and the current user is a member (403), and rejects writes
by viewers (403). ``require_owner`` further restricts to owners (membership
management). These are wired into every project-scoped route transitively via
``deps.get_request_session`` (Task 8), so route handlers need no changes.

Write detection is by HTTP method, with an allowlist of POST endpoints that are
actually reads (search / batch fetch / validate) so viewers can use them.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from .db_models import Membership, Project, Role, User
from .identity import get_current_user
from .tenancy import get_membership

_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: POST endpoints that only READ the model (no mutation), so a viewer must be
#: allowed to call them. Matched by path suffix against the request URL.
_READ_ONLY_POST_SUFFIXES = (
    "/model/search",
    "/model/elements/batch",
    "/model/validate",
)


def _is_write(request: Request) -> bool:
    if request.method not in _WRITE_METHODS:
        return False
    if request.method == "POST" and request.url.path.endswith(
        _READ_ONLY_POST_SUFFIXES
    ):
        return False
    return True


def require_membership(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Membership:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    membership = get_membership(db, user.id, project_id)
    if membership is None:
        raise HTTPException(status_code=403, detail="not a project member")
    if _is_write(request) and membership.role is Role.viewer:
        raise HTTPException(
            status_code=403, detail="viewer role cannot modify the model"
        )
    return membership


def require_owner(
    membership: Membership = Depends(require_membership),
) -> Membership:
    if membership.role is not Role.owner:
        raise HTTPException(status_code=403, detail="owner role required")
    return membership
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_authz.py -v`
Expected: PASS (9 passed).

- [ ] **Step 5: Lint/typecheck + full suite**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all pass (data routes untouched, still green).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/authz.py tests/api/test_authz.py
git commit -m "feat(api): membership/role authorization dependencies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Projects router (project + membership CRUD)

Adds the `/api/v1/projects...` endpoints and mounts them. `create_app` starts initializing the engine so the new routes work. Data routes are still header/default-session based (untouched) → existing tests stay green.

**Files:**
- Create: `src/data_rover/api/routes/projects.py`
- Modify: `src/data_rover/api/main.py` (init engine + include projects router)
- Test: `tests/api/test_projects_route.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_projects_route.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _h(uid: str, email: str = "") -> dict[str, str]:
    h = {"x-user-id": uid}
    if email:
        h["x-user-email"] = email
    return h


def test_create_project_makes_caller_owner(client: TestClient) -> None:
    r = client.post("/api/v1/projects", json={"name": "P"}, headers=_h("u1"))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "P"
    assert body["role"] == "owner"
    assert body["id"]


def test_list_projects_only_mine(client: TestClient) -> None:
    client.post("/api/v1/projects", json={"name": "A"}, headers=_h("u1"))
    client.post("/api/v1/projects", json={"name": "B"}, headers=_h("u2"))
    r = client.get("/api/v1/projects", headers=_h("u1"))
    assert [p["name"] for p in r.json()] == ["A"]


def test_get_project_requires_membership(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u1")).status_code == 200
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u2")).status_code == 403


def test_add_and_list_members(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    r = client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u2", "email": "u2@x.com", "role": "editor"},
        headers=_h("u1"),
    )
    assert r.status_code == 201, r.text
    members = client.get(
        f"/api/v1/projects/{pid}/members", headers=_h("u1")
    ).json()
    assert {m["user_id"]: m["role"] for m in members} == {
        "u1": "owner",
        "u2": "editor",
    }


def test_only_owner_can_add_members(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u2", "role": "editor"},
        headers=_h("u1"),
    )
    r = client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u3", "role": "viewer"},
        headers=_h("u2"),
    )
    assert r.status_code == 403


def test_remove_member(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u2", "role": "editor"},
        headers=_h("u1"),
    )
    r = client.delete(
        f"/api/v1/projects/{pid}/members/u2", headers=_h("u1")
    )
    assert r.status_code == 204
    members = client.get(
        f"/api/v1/projects/{pid}/members", headers=_h("u1")
    ).json()
    assert [m["user_id"] for m in members] == ["u1"]


def test_delete_project(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    assert client.delete(
        f"/api/v1/projects/{pid}", headers=_h("u1")
    ).status_code == 204
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u1")).status_code == 404
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_projects_route.py -v`
Expected: FAIL — 404s everywhere (`/api/v1/projects` not mounted) / import error.

- [ ] **Step 3: Implement the projects router**

Create `src/data_rover/api/routes/projects.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..authz import require_membership, require_owner
from ..db import get_db
from ..db_models import Membership, Project, Role, User
from ..identity import get_current_user
from ..session import get_registry
from .. import tenancy

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str


class ProjectOut(BaseModel):
    id: str
    name: str
    role: Role


class MemberIn(BaseModel):
    user_id: str
    email: str = ""
    role: Role


class MemberOut(BaseModel):
    user_id: str
    email: str
    role: Role


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    project = tenancy.create_project(db, body.name, user.id)
    return ProjectOut(id=project.id, name=project.name, role=Role.owner)


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectOut]:
    return [
        ProjectOut(id=p.id, name=p.name, role=role)
        for p, role in tenancy.list_projects_for_user(db, user.id)
    ]


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: str,
    membership: Membership = Depends(require_membership),
    db: Session = Depends(get_db),
) -> ProjectOut:
    project = db.get(Project, project_id)
    assert project is not None  # require_membership already proved existence
    return ProjectOut(id=project.id, name=project.name, role=membership.role)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    _owner: Membership = Depends(require_owner),
    db: Session = Depends(get_db),
) -> Response:
    tenancy.delete_project(db, project_id)
    get_registry().evict(project_id)  # drop the in-memory session, if any
    return Response(status_code=204)


@router.get("/projects/{project_id}/members", response_model=list[MemberOut])
def list_members(
    project_id: str,
    _m: Membership = Depends(require_membership),
    db: Session = Depends(get_db),
) -> list[MemberOut]:
    return [
        MemberOut(
            user_id=m.user_id,
            email=(m.user.email if m.user else ""),
            role=m.role,
        )
        for m in tenancy.list_members(db, project_id)
    ]


@router.post(
    "/projects/{project_id}/members", response_model=MemberOut, status_code=201
)
def add_member(
    project_id: str,
    body: MemberIn,
    _owner: Membership = Depends(require_owner),
    db: Session = Depends(get_db),
) -> MemberOut:
    tenancy.upsert_user(db, body.user_id, body.email)
    m = tenancy.add_member(db, project_id, body.user_id, body.role)
    return MemberOut(user_id=m.user_id, email=body.email, role=m.role)


@router.delete(
    "/projects/{project_id}/members/{user_id}", status_code=204
)
def remove_member(
    project_id: str,
    user_id: str,
    _owner: Membership = Depends(require_owner),
    db: Session = Depends(get_db),
) -> Response:
    tenancy.remove_member(db, project_id, user_id)  # raises ValueError -> 422
    return Response(status_code=204)
```

(Note: `tenancy.remove_member` raising `ValueError` for "last owner" is handled by the existing `ValueError → 422` exception handler in `errors.py`.)

- [ ] **Step 4: Wire the engine + projects router in `main.py`**

In `src/data_rover/api/main.py`, change the imports and `create_app`:

Add to the imports:

```python
from .db import init_engine
from .routes import projects
```

Add `projects` to the existing `from .routes import (...)` group as well (or import separately as above — pick one; do not import twice).

In `create_app`, after `settings = get_settings()` and before `app = FastAPI(...)`, add:

```python
    init_engine(settings.database_url)
```

After `app.include_router(health.router)` and before the `prefix = "/api/v1"` data routers, add:

```python
    app.include_router(projects.router, prefix="/api/v1", tags=["projects"])
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_projects_route.py -v`
Expected: PASS (7 passed).

- [ ] **Step 6: Full suite + lint**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all pass. (Existing data tests still use the old `/api/v1/...` paths and the default session — unaffected.)

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/projects.py src/data_rover/api/main.py tests/api/test_projects_route.py
git commit -m "feat(api): projects + membership CRUD router

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Flip data routing to `/projects/{project_id}` + migrate existing tests

The one breaking change, landed atomically: mount the data routers under `/api/v1/projects/{project_id}`, rewire `get_request_session` to resolve the path param **after** membership passes, and migrate every existing API test onto project-scoped, authenticated requests.

**Files:**
- Modify: `src/data_rover/api/deps.py`
- Modify: `src/data_rover/api/main.py`
- Modify: `tests/api/conftest.py` (add seed + auth-client fixtures + `papi` helper)
- Modify: all existing data tests (`test_routes.py`, `test_model_io.py`, `test_ops_route.py`, `test_read_routes.py`, `test_search_routes.py`, `test_view_routes.py`, `test_apply_cr_route.py`, `test_multi_project.py`, `test_session_registry.py`)

- [ ] **Step 1: Rewire `get_request_session` in `deps.py`**

In `src/data_rover/api/deps.py`, replace the `get_request_session` function (and update imports). Change the import line:

```python
from .session import Session, get_registry
```

(remove `DEFAULT_PROJECT_ID` and `get_session` from this import — `get_session` is no longer used by `deps`; keep `Session` re-exported in `__all__`.)

Add an import:

```python
from .authz import require_membership
```

Replace the whole `get_request_session` function body with:

```python
def get_request_session(
    project_id: str,
    _membership: "Membership" = Depends(require_membership),
) -> Session:
    """Resolve the live :class:`Session` for the path's project.

    The ``project_id`` comes from the ``/api/v1/projects/{project_id}`` path
    segment. ``require_membership`` runs first (transitively pulling in identity
    + DB), so by the time we touch the registry the caller is a proven member
    with sufficient role; unknown project → 404, non-member → 403, viewer write
    → 403, all raised before this body runs.
    """
    return get_registry().get(project_id)
```

Add the needed imports for `Depends` and the `Membership` annotation. At the top of `deps.py`:

```python
from fastapi import Depends, HTTPException, Request
```

and under the existing `TYPE_CHECKING` pattern (or directly), import `Membership` for the annotation. Simplest: add a runtime import near the others:

```python
from .db_models import Membership
```

Keep `__all__` as-is (it already exports `get_request_session`). Remove `get_session` from `__all__` only if it was there — it is not (verify; `__all__` lists `get_session`). **Keep `get_session` importable from `.session` for tests**, but `deps` no longer needs to import it. Update the `deps` import of `.session` accordingly (done above).

- [ ] **Step 2: Mount data routers under the project path in `main.py`**

In `src/data_rover/api/main.py`, replace the data-router block. Change:

```python
    prefix = "/api/v1"
    app.include_router(metamodel.router, prefix=prefix, tags=["metamodel"])
    app.include_router(model.router, prefix=prefix, tags=["model"])
    app.include_router(ops.router, prefix=prefix, tags=["ops"])
    app.include_router(read.router, prefix=prefix, tags=["read"])
    app.include_router(change_request.router, prefix=prefix, tags=["change-request"])
    app.include_router(elements.router, prefix=prefix, tags=["elements"])
    app.include_router(relationships.router, prefix=prefix, tags=["relationships"])
    app.include_router(validation.router, prefix=prefix, tags=["validation"])
    app.include_router(view.router, prefix=prefix, tags=["view"])
```

to:

```python
    proj = "/api/v1/projects/{project_id}"
    app.include_router(metamodel.router, prefix=proj, tags=["metamodel"])
    app.include_router(model.router, prefix=proj, tags=["model"])
    app.include_router(ops.router, prefix=proj, tags=["ops"])
    app.include_router(read.router, prefix=proj, tags=["read"])
    app.include_router(change_request.router, prefix=proj, tags=["change-request"])
    app.include_router(elements.router, prefix=proj, tags=["elements"])
    app.include_router(relationships.router, prefix=proj, tags=["relationships"])
    app.include_router(validation.router, prefix=proj, tags=["validation"])
    app.include_router(view.router, prefix=proj, tags=["view"])
```

(The `projects` router stays mounted at `/api/v1` from Task 7 — leave it. Route files are **not** edited; the `{project_id}` path param is injected into `require_membership`/`get_request_session` automatically.)

- [ ] **Step 3: Add seed + auth-client fixtures to the conftest**

In `tests/api/conftest.py`, append below the `_fresh_db` fixture:

```python
import pytest
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db_models import Role
from data_rover.api.main import create_app

#: Identity + project used by the default authenticated test client.
TEST_USER_ID = "test-user"
TEST_PROJECT_ID = "test-project"


@pytest.fixture
def seed_project() -> str:
    """Create the default test user + project (owner) and return project id."""
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.upsert_user(s, TEST_USER_ID, "test@example.com")
        project = tenancy.create_project(s, "Test Project", TEST_USER_ID)
        # pin a stable id so URL helpers are deterministic
        project.id = TEST_PROJECT_ID  # type: ignore[misc]
        s.merge(project)
        # re-point the owner membership to the pinned id
        m = tenancy.get_membership(s, TEST_USER_ID, project.id)
        s.commit()
        assert m is not None
        return TEST_PROJECT_ID
    finally:
        gen.close()
```

The id-pinning above is fragile. Use this simpler, robust version instead — create the project directly with the fixed id:

```python
@pytest.fixture
def seed_project() -> str:
    gen = db.get_db()
    s = next(gen)
    try:
        from data_rover.api.db_models import Membership, Project, User

        s.add(User(id=TEST_USER_ID, email="test@example.com"))
        s.add(Project(id=TEST_PROJECT_ID, name="Test Project"))
        s.add(
            Membership(
                user_id=TEST_USER_ID, project_id=TEST_PROJECT_ID, role=Role.owner
            )
        )
        s.commit()
        return TEST_PROJECT_ID
    finally:
        gen.close()


@pytest.fixture
def client(seed_project: str) -> TestClient:
    """Authenticated TestClient: owner of the seeded test project, default
    identity headers attached to every request."""
    c = TestClient(create_app())
    c.headers.update({"x-user-id": TEST_USER_ID, "x-user-email": "test@example.com"})
    return c


def papi(path: str) -> str:
    """Build a project-scoped API URL for the seeded test project.

    ``papi("/metamodel")`` -> ``/api/v1/projects/test-project/metamodel``.
    """
    return f"/api/v1/projects/{TEST_PROJECT_ID}{path}"
```

(Delete the first, fragile `seed_project` draft — keep only the robust version.)

- [ ] **Step 4: Migrate the existing data tests (mechanical)**

For each data test file, apply this transformation:

1. Delete its local `reset_session()` calls and any local `client`/app fixture that builds a bare `TestClient(create_app())` — use the conftest `client` fixture (request it as a parameter) and `papi`.
2. Rewrite every data URL: `"/api/v1/<rest>"` → `papi("/<rest>")`. Example: `client.get("/api/v1/model/summary")` → `client.get(papi("/model/summary"))`.
3. Import the helper: `from tests.api.conftest import papi` is **not** needed — add `from .conftest import papi` only if your test references it and it is not auto-available. (pytest does not auto-import conftest symbols; add `from .conftest import papi` at the top of each migrated file, or define `papi` usage via a fixture. Use the explicit import.)
4. For endpoints guarded by `require_allowed_origin` (in `test_model_io.py`: `/model/load`, `/model/save`, `/model/upload`, `/model/download`), keep the `Origin`-header assertions; they still apply, now under the project path.

**Worked example — `tests/api/test_read_routes.py` (header excerpt):** a test that was

```python
def test_summary(client):
    ...
    r = client.get("/api/v1/model/summary")
    assert r.status_code == 200
```

becomes

```python
from .conftest import papi

def test_summary(client):
    ...
    r = client.get(papi("/model/summary"))
    assert r.status_code == 200
```

Apply to: `test_routes.py`, `test_model_io.py`, `test_ops_route.py`, `test_read_routes.py`, `test_search_routes.py`, `test_view_routes.py`, `test_apply_cr_route.py`. (`test_apply_cr_schema.py` is schema-only — check whether it makes HTTP calls; if not, leave it. `test_settings.py`, `test_db*.py`, `test_tenancy.py`, `test_identity.py`, `test_authz.py`, `test_projects_route.py` are new and already correct.)

- [ ] **Step 5: Rewrite the registry/multi-project tests for path routing**

`tests/api/test_session_registry.py` — the unit tests for `SessionRegistry`, `get_session`, `get_registry`, `reset_session` are **unchanged** (they don't go through HTTP). **Only** `test_get_request_session_uses_header_project` must change, because `get_request_session` no longer reads a header. Replace that test with a path-param unit test:

```python
def test_get_request_session_resolves_path_project() -> None:
    from data_rover.api.db_models import Membership
    from data_rover.api.deps import get_request_session
    from data_rover.api.session import get_registry, reset_session

    reset_session()
    fake = Membership(user_id="u", project_id="proj-a", role=None)  # role unused
    s = get_request_session("proj-a", fake)
    assert s is get_registry().get("proj-a")
```

(`get_request_session` now takes `project_id` + the resolved membership; calling it directly with a stub membership exercises the registry resolution without the auth chain, which is covered by `test_authz.py`.)

Replace `tests/api/test_multi_project.py` entirely with a path-routed, authenticated version:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db, tenancy
from data_rover.api.db_models import Role
from data_rover.api.main import create_app

SIMPLE_MM = """
elements:
  - name: Block
"""


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _seed(pid: str, uid: str) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        from data_rover.api.db_models import Membership, Project, User

        if s.get(User, uid) is None:
            s.add(User(id=uid, email=""))
        s.add(Project(id=pid, name=pid))
        s.add(Membership(user_id=uid, project_id=pid, role=Role.owner))
        s.commit()
    finally:
        gen.close()


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def test_metamodel_loaded_in_one_project_is_invisible_to_another(
    client: TestClient,
) -> None:
    _seed("alpha", "u1")
    _seed("beta", "u1")

    res = client.post(
        "/api/v1/projects/alpha/metamodel",
        content=SIMPLE_MM,
        headers={"content-type": "application/x-yaml", **_h("u1")},
    )
    assert res.status_code == 200, res.text

    assert (
        client.get("/api/v1/projects/alpha/metamodel", headers=_h("u1")).status_code
        == 200
    )
    assert (
        client.get("/api/v1/projects/beta/metamodel", headers=_h("u1")).status_code
        == 404
    )


def test_non_member_cannot_touch_project(client: TestClient) -> None:
    _seed("alpha", "u1")
    res = client.get("/api/v1/projects/alpha/metamodel", headers=_h("stranger"))
    assert res.status_code == 403


def test_models_in_two_projects_do_not_share_state(client: TestClient) -> None:
    _seed("alpha", "u1")
    _seed("beta", "u1")
    for pid in ("alpha", "beta"):
        assert (
            client.post(
                f"/api/v1/projects/{pid}/metamodel",
                content=SIMPLE_MM,
                headers={"content-type": "application/x-yaml", **_h("u1")},
            ).status_code
            == 200
        )

    res = client.post(
        "/api/v1/projects/alpha/model",
        json={
            "elements": [{"id": "b1", "type_name": "Block", "properties": {}}],
            "relationships": [],
        },
        headers=_h("u1"),
    )
    assert res.status_code == 200, res.text

    a = client.get(
        "/api/v1/projects/alpha/model/summary", headers=_h("u1")
    ).json()
    b = client.get(
        "/api/v1/projects/beta/model/summary", headers=_h("u1")
    ).json()
    assert a["element_count"] == 1
    assert b["element_count"] == 0
```

(Verify the `element_count` field name against `ModelSummary` in `schemas.py`; adjust if it differs — same caveat as the Phase 1 plan.)

- [ ] **Step 6: Run the full API suite**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS. If a data test still hits a bare `/api/v1/<x>` URL it will 404 — fix that occurrence to `papi("/<x>")`.

- [ ] **Step 7: Lint/typecheck**

Run: `pixi run lint-backend`
Expected: ruff, mypy, pyright all pass. (Watch for the `Membership(role=None)` stub in the registry test tripping mypy — if so, construct it with `role=Role.owner` and import `Role`.)

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/deps.py src/data_rover/api/main.py tests/api
git commit -m "feat(api): route projects via /projects/{id} path, gate on membership

BREAKING: data routes move under /api/v1/projects/{project_id}; every request
must carry an identity header and target a project the user is a member of.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Alembic migrations (Postgres schema)

Productionize the schema: Alembic owns the Postgres schema (`create_all` remains SQLite/dev-only). Add a hermetic test that the migration produces the expected tables.

**Files:**
- Create: `alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`, `alembic/versions/0001_initial.py`
- Test: `tests/api/test_alembic.py` (create)

- [ ] **Step 1: Scaffold Alembic config**

Create `alembic.ini` at the repo root:

```ini
[alembic]
script_location = alembic
prepend_sys_path = src
sqlalchemy.url =

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARNING
handlers = console
qualname =

[logger_sqlalchemy]
level = WARNING
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
```

- [ ] **Step 2: Create `alembic/env.py`**

Create `alembic/env.py`:

```python
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from data_rover.api import db_models  # noqa: F401  (registers tables)
from data_rover.api.db import Base
from data_rover.api.settings import get_settings

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# URL comes from settings (env DATA_ROVER_DATABASE_URL) unless set in the ini.
if not config.get_main_option("sqlalchemy.url"):
    config.set_main_option("sqlalchemy.url", get_settings().database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

- [ ] **Step 3: Create `alembic/script.py.mako`**

Create `alembic/script.py.mako`:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision: str = ${repr(up_revision)}
down_revision: str | None = ${repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

- [ ] **Step 4: Write the initial migration**

Create `alembic/versions/0001_initial.py`:

```python
"""initial tenancy schema

Revision ID: 0001
Revises:
Create Date: 2026-06-16
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False, server_default=""),
    )
    op.create_table(
        "projects",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
    )
    op.create_table(
        "memberships",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            sa.String(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "role",
            sa.Enum("owner", "editor", "viewer", name="role"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "user_id", "project_id", name="uq_membership_user_project"
        ),
    )


def downgrade() -> None:
    op.drop_table("memberships")
    op.drop_table("projects")
    op.drop_table("users")
    sa.Enum(name="role").drop(op.get_bind(), checkfirst=True)
```

- [ ] **Step 5: Write the migration test**

Create `tests/api/test_alembic.py`:

```python
from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_migration_creates_all_tables(tmp_path) -> None:
    db_path = tmp_path / "t.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")

    insp = inspect(create_engine(url))
    assert set(insp.get_table_names()) >= {"users", "projects", "memberships"}
```

- [ ] **Step 6: Run the migration test**

Run: `pixi run -e core-dev pytest tests/api/test_alembic.py -v`
Expected: PASS (1 passed). (If `prepend_sys_path`/import fails, confirm `alembic/env.py` can import `data_rover` — the test sets `script_location` to the repo `alembic/` dir and `prepend_sys_path = src` in the ini handles `data_rover` import.)

- [ ] **Step 7: Confirm the migration matches the ORM (parity guard)**

Run: `pixi run -e api alembic -x or just visually diff` — actually run autogenerate against a temp Postgres only if available; otherwise rely on the table-name test above. Skip if no Postgres. (Document: run `pixi run db-revision message="check"` after model changes and ensure it produces an empty diff.)

- [ ] **Step 8: Full suite + lint**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add alembic.ini alembic tests/api/test_alembic.py
git commit -m "feat(api): Alembic migrations for the tenancy schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Dev-seed bootstrap + minimal frontend integration

Keep the existing single-user app + Playwright e2e working under the new routing: a dev-seed that ensures a `default` user+project, and a frontend that targets `/api/v1/projects/default` with dev identity headers.

**Files:**
- Modify: `src/data_rover/api/main.py` (dev-seed on startup)
- Modify: `src/data_rover/api/settings.py` (a default project id/name constant — optional)
- Create: `tests/api/test_dev_seed.py`
- Modify: `frontend/src/lib/api/client.ts`
- Modify: `frontend/src/lib/api/__tests__/*.ts` (base URL constants)
- Modify: Playwright backend bootstrap / config

- [ ] **Step 1: Write the dev-seed test**

Create `tests/api/test_dev_seed.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.main import create_app


@pytest.fixture
def dev_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "true")
    db.drop_all()  # start clean; create_app will create + seed
    return TestClient(create_app())


def test_dev_seed_creates_default_project(dev_client: TestClient) -> None:
    r = dev_client.get(
        "/api/v1/projects/default/metamodel", headers={"x-user-id": "default-user"}
    )
    # 404 = no metamodel loaded yet, but the project EXISTS and the user is a
    # member (else this would be 403/404-project). Membership proven by a 200
    # on the project detail endpoint:
    detail = dev_client.get(
        "/api/v1/projects/default", headers={"x-user-id": "default-user"}
    )
    assert detail.status_code == 200
    assert detail.json()["id"] == "default"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_dev_seed.py -v`
Expected: FAIL — project `default` does not exist (404 on the detail endpoint).

- [ ] **Step 3: Implement the dev-seed**

In `src/data_rover/api/main.py`, add a helper and call it from `create_app` when `settings.dev_seed`:

```python
from .db import create_all, get_db, init_engine
from .db_models import Membership, Project, Role, User

#: Identity + project the dev-seed provisions so the single-user frontend works
#: without a project picker. The frontend sends these as its dev identity.
DEV_USER_ID = "default-user"
DEV_PROJECT_ID = "default"


def _ensure_dev_seed() -> None:
    """Create the schema (SQLite/dev) and a default user+project if missing."""
    create_all()
    gen = get_db()
    db = next(gen)
    try:
        if db.get(Project, DEV_PROJECT_ID) is None:
            if db.get(User, DEV_USER_ID) is None:
                db.add(User(id=DEV_USER_ID, email="dev@example.com"))
            db.add(Project(id=DEV_PROJECT_ID, name="Default Project"))
            db.add(
                Membership(
                    user_id=DEV_USER_ID,
                    project_id=DEV_PROJECT_ID,
                    role=Role.owner,
                )
            )
            db.commit()
    finally:
        gen.close()
```

In `create_app`, after `init_engine(settings.database_url)`:

```python
    if settings.dev_seed:
        _ensure_dev_seed()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_dev_seed.py -v`
Expected: PASS (1 passed). (The autouse conftest sets `DEV_SEED=false` globally; this test re-enables it via monkeypatch.)

- [ ] **Step 5: Point the frontend client at the project path + identity**

In `frontend/src/lib/api/client.ts`, change the base + add identity/project config. Current:

```ts
const DEFAULT_BASE_URL = '/api/v1';
```

Replace the relevant config + base construction with a project-aware base and default dev identity headers. Add to the config type a `projectId?: string` and identity defaults, and build the effective base as `/api/v1/projects/{projectId}`:

```ts
const DEFAULT_PROJECT_ID = 'default';
const DEFAULT_BASE_URL = '/api/v1';
const DEV_IDENTITY = { 'x-user-id': 'default-user', 'x-user-email': 'dev@example.com' };

// effective base for project-scoped calls:
function projectBase(baseUrl: string, projectId: string): string {
	return `${baseUrl.replace(/\/$/, '')}/projects/${projectId}`;
}
```

Wire `projectBase` into `buildUrl`/`apiFetch` so project-scoped requests hit `/api/v1/projects/{projectId}/...`, and merge `DEV_IDENTITY` into request headers. Keep the **non-project** endpoints (`/projects`, `/projects/{id}/members`) reachable via the raw `baseUrl` if/when a picker is added — out of scope here; for now all current calls are project-scoped, so route them through `projectBase`.

(Exact edit depends on `client.ts` internals — read the file first and thread `projectId` (default `DEFAULT_PROJECT_ID`) + `DEV_IDENTITY` through the single `apiFetch` choke point. Per `frontend/README.md`, all API calls funnel through this client.)

- [ ] **Step 6: Update frontend API test base URLs**

In every `frontend/src/lib/api/__tests__/*.ts` and any state test using `const BASE = 'http://api.test/api/v1'`, change to the project-scoped base so MSW handlers match:

```ts
const BASE = 'http://api.test/api/v1/projects/default';
```

(Confirm by reading one handler; the tests assert on the URL the client produces, which now includes `/projects/default`.)

- [ ] **Step 7: Run the frontend unit tests**

Run: `pixi run -e frontend npm test`
Expected: PASS. Fix any remaining hard-coded `/api/v1/...` URLs in handlers/tests to include `/projects/default`.

- [ ] **Step 8: Make Playwright boot the backend with SQLite + dev-seed**

In the Playwright config / webServer command that starts the backend, set the environment so the backend uses a throwaway SQLite db and seeds the default project:

```
DATA_ROVER_DATABASE_URL=sqlite:////tmp/data-rover-e2e.db DATA_ROVER_DEV_SEED=true
```

(Read `frontend/playwright.config.ts` for the existing backend `webServer` entry; add these env vars there. The frontend already sends dev identity headers from Step 5.)

- [ ] **Step 9: Run e2e**

Run: `pixi run -e frontend npm run test:e2e`
Expected: PASS (smoke flows load the default project, autoload still works).

- [ ] **Step 10: Commit**

```bash
git add src/data_rover/api/main.py tests/api/test_dev_seed.py frontend
git commit -m "feat: dev-seed default project + frontend project-path routing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Docs + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md`**

In the "Backend session & the delta protocol" section, update the `session.py` and routing bullets to reflect Phase 2. Replace the Phase-1 `X-Project-Id` description with:

- `session.py` still holds the process-wide `SessionRegistry` (one in-memory `Session` per project id), but the project id now comes from the **`/api/v1/projects/{project_id}` path segment**, resolved by `deps.get_request_session` **after** `authz.require_membership` proves the caller is a member with sufficient role.
- New tenancy layer: `db.py` (SQLAlchemy engine), `db_models.py` (`User`/`Project`/`Membership` + `Role`), `tenancy.py` (service), `identity.py` (`IdentityProvider` seam + dev header provider), `authz.py` (membership/role gating), `routes/projects.py` (project + member CRUD). Postgres in prod (Alembic owns the schema); SQLite in tests; `dev_seed` provisions a `default` project for the single-user frontend.
- Authn: trusted `X-User-Id`/`X-User-Email` headers (dev provider); users auto-provisioned. Authz: viewers are read-only (writes 403; a small allowlist of read-only POSTs — search/batch/validate — stays open to viewers); owners manage membership.
- Add the commands: `pixi run db-upgrade` (Alembic), tests need no DB service (SQLite in-memory via `tests/api/conftest.py`).

Add a Conventions note: new API tests use the `client` fixture + `papi()` helper from `tests/api/conftest.py`; project-scoped requests must carry an identity header.

- [ ] **Step 2: Full backend suite + lint**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all green.

- [ ] **Step 3: Full core suite (no regressions elsewhere)**

Run: `pixi run test-core`
Expected: green.

- [ ] **Step 4: Frontend check + tests + e2e**

Run: `pixi run -e frontend npm run check && pixi run -e frontend npm test && pixi run -e frontend npm run test:e2e`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Phase 2 tenancy/auth + path routing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- `User`/`Project`/`Membership` persisted in Postgres (Alembic-managed); tenancy service + tests green on SQLite.
- Every project-scoped request authenticates via the `IdentityProvider` seam (dev header provider) and authorizes against `Membership`: unknown project → 404, non-member → 403, viewer write → 403.
- Data routes served under `/api/v1/projects/{project_id}/...`; route files unchanged (resolution via `get_request_session` → `require_membership`).
- `projects` router provides project + membership CRUD; only owners manage membership; last-owner removal refused.
- The single-user frontend + Playwright e2e work against the dev-seeded `default` project.
- `pixi run -e core-dev pytest tests/api`, `pixi run lint-backend`, `pixi run test-core`, and the frontend test/check/e2e suites all green.

## Out of scope (later phases — do NOT add here)

- Durable model persistence: commit journal + GCS snapshots, hydrate-on-open, evict-on-idle (Phase 3).
- Check-out/commit + locking, pre-commit validation, commit messages/error counts (Phase 4).
- Realtime WS commit feed / presence / lock badges (Phase 5).
- Metamodel-driven editing UX, sandbox validate + rebind (Phase 6).
- HA / horizontal scale: Redis ownership leases + affinity routing (Phase 7).
- History browser / revert-to-commit / strict-mode (Phase 8).
- Real SSO (OIDC/SAML) provider — the seam exists; the impl is a later swap (spec open question #1).
- Project-picker UI / multi-project frontend UX (the frontend here is minimal-glue only).
- Per-route fine-grained permissions beyond viewer/editor/owner; migration-CLI project importer (Phase 3 with the journal).

---

## Self-review

**Spec coverage (against spec §12 Phase 2 row "Tenancy + auth seam"):**
- "`User`/`Project`/`Membership` in Postgres" → Tasks 3 (models), 4 (service), 9 (migrations). ✓
- "`IdentityProvider` seam (dev/header provider now, company SSO later)" → Task 5 (`identity.py`, `DevHeaderIdentityProvider`, `set_identity_provider` swap seam). ✓
- "authorize per membership" → Task 6 (`require_membership`/`require_owner`), wired in Task 8. ✓
- "routes carry project_id" (Phase 1 deferred path-segment form here) → Task 8 (`/projects/{project_id}`). ✓
- §5 roles owner/editor/viewer mapping to cohorts → `Role` enum + viewer-read-only gate (Task 3/6). ✓
- §6 "`get_session()` → `registry.get(project_id)`; authorized against Membership before the session is touched" → Task 8 ordering (membership dep resolves before the session body). ✓
- §6 eviction seam used on project delete → Task 7 (`get_registry().evict`). ✓

**Deferred-with-rationale:** durable persistence, locking, realtime, metamodel UX, HA, history (later phases — listed). Real SSO impl (seam only). Project-picker UX (minimal frontend glue only). All explicitly out of scope.

**Placeholder scan:** every code step shows complete code; commands have expected output. The one place I flagged judgment ("thread projectId through `client.ts`") is gated on reading the file first because the client internals weren't fully captured — acceptable as it's a frontend integration choke point documented in `frontend/README.md`, not a backend invariant. The fragile first `seed_project` draft in Task 8 Step 3 is explicitly replaced by the robust version (and the instruction says delete the draft). ✓

**Type/name consistency:** `Role`, `User`, `Project`, `Membership`, `Identity`, `IdentityProvider`, `DevHeaderIdentityProvider`, `get_identity_provider`/`set_identity_provider`, `get_current_user`, `require_membership`/`require_owner`, `init_engine`/`get_db`/`create_all`/`drop_all`, `upsert_user`/`create_project`/`get_membership`/`list_projects_for_user`/`list_members`/`add_member`/`remove_member`/`delete_project`, `get_request_session`, `papi`, `DEV_USER_ID`/`DEV_PROJECT_ID`, `TEST_USER_ID`/`TEST_PROJECT_ID` are used identically across tasks. The projects router schema fields (`ProjectOut.role`, `MemberOut.user_id/email/role`) match the route tests. ✓

**Green-at-every-commit:** Tasks 1–7 additive (data routes + `get_request_session` untouched; conftest autouse is inert for legacy tests). Task 8 makes the breaking routing+auth change AND migrates all affected tests in one commit. Tasks 9–11 additive/productionization. ✓
