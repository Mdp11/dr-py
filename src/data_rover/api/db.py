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

from collections.abc import Generator

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
            # one shared connection for the whole process: required so an
            # in-memory db's schema survives across checkouts. Safe only for
            # the sync, single-threaded TestClient — would corrupt under
            # concurrent access (e.g. pytest-xdist / async). Postgres uses the
            # default pool instead (the else branch below).
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
    """Return the process-global engine; raises if ``init_engine`` was not called.

    Callers depend on this accessor rather than importing ``_engine`` directly
    so that test-time engine replacement (``force=True``) is transparent.
    """
    if _engine is None:
        raise RuntimeError("engine not initialised; call init_engine() first")
    return _engine


def create_all() -> None:
    """Create all tenancy tables (SQLite/dev + tests; Postgres uses Alembic)."""
    Base.metadata.create_all(get_engine())


def drop_all() -> None:
    """Drop all tenancy tables. Test teardown + SQLite/dev only.

    Never call this in production: the Postgres schema is owned by Alembic and
    dropping it would destroy all tenancy data.
    """
    Base.metadata.drop_all(get_engine())


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency: yield a DB session, closing it afterwards.

    Annotated ``Generator`` (not ``Iterator``) because tests drive it manually
    via ``next()``/``.close()`` — ``.close()`` lives on ``Generator``.
    """
    if _SessionLocal is None:
        raise RuntimeError("engine not initialised; call init_engine() first")
    session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()
