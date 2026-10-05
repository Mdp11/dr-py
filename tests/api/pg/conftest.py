"""The opt-in Postgres lane: the API suite's seams, on a real Postgres.

``DATA_ROVER_TEST_DATABASE_URL`` names a database that the lane owns: it is
created when missing, its schema is rebuilt by ``alembic upgrade head`` once per
session, and every table is truncated between tests. Without the URL, or when the
server is unreachable, every test in this directory skips.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import SQLAlchemyError

from data_rover.api import db
from data_rover.api.identity import set_identity_provider
from data_rover.api.lock_mirror import MemoryLeaseMirror, set_lease_mirror
from data_rover.api.project_state import get_registry
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store

URL_ENV = "DATA_ROVER_TEST_DATABASE_URL"
REPO_ROOT = Path(__file__).resolve().parents[3]


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    here = Path(__file__).parent
    for item in items:
        if here in Path(str(item.fspath)).parents:
            item.add_marker(pytest.mark.pg)


def _ensure_database(url: URL) -> None:
    """Create the named database when the server lacks it."""
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"),
                {"n": url.database},
            ).scalar()
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{url.database}"'))
    finally:
        admin.dispose()


@pytest.fixture(scope="session")
def pg_url() -> Iterator[str]:
    raw = os.environ.get(URL_ENV)
    if not raw:
        pytest.skip(f"{URL_ENV} is not set")
    url = make_url(raw)
    try:
        _ensure_database(url)
        engine = create_engine(url)
        with engine.begin() as conn:
            conn.execute(text("DROP SCHEMA public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
        engine.dispose()
    except SQLAlchemyError as exc:
        pytest.skip(f"Postgres at {url.render_as_string(hide_password=True)}: {exc}")
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", raw.replace("%", "%%"))
    command.upgrade(cfg, "head")
    yield raw


@pytest.fixture(autouse=True)
def _fresh_db(pg_url: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Replaces the suite's SQLite fixture of the same name: the engine is the
    Postgres one and the tables are truncated, not dropped."""
    # a lock wait that would never end fails the test instead of hanging it;
    # create_app reads the same URL, so it keeps this engine
    guarded = (
        make_url(pg_url)
        .update_query_dict({"options": "-c lock_timeout=20000"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", guarded)
    engine = db.init_engine(guarded, force=True)
    with engine.begin() as conn:
        tables = conn.execute(
            text(
                "SELECT quote_ident(tablename) FROM pg_tables "
                "WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
            )
        ).scalars()
        conn.execute(text(f"TRUNCATE {', '.join(tables)} CASCADE"))
    get_registry().reset()
    set_snapshot_store(MemorySnapshotStore())
    set_lease_mirror(MemoryLeaseMirror())
    set_identity_provider(None)
    try:
        yield
    finally:
        get_registry().reset()
        set_snapshot_store(None)
        set_lease_mirror(None)
        set_identity_provider(None)
        engine.dispose()
