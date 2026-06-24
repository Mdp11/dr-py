from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

# Force every API test onto an in-memory SQLite db and disable the dev seed
# BEFORE any app/settings import reads the environment.
os.environ.setdefault("DATA_ROVER_DATABASE_URL", "sqlite://")
os.environ.setdefault("DATA_ROVER_DEV_SEED", "false")
os.environ.setdefault("DATA_ROVER_SNAPSHOT_STORE", "memory")
os.environ.setdefault("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
os.environ.setdefault("DATA_ROVER_LOCK_SWEEP_SECONDS", "0")

from data_rover.api import db  # noqa: E402
from data_rover.api import db_models  # noqa: E402,F401  (registers ORM tables)
from data_rover.api.db_models import Membership, Project, Role, User  # noqa: E402
from data_rover.api.identity import set_identity_provider  # noqa: E402
from data_rover.api.session import (  # noqa: E402
    DEFAULT_PROJECT_ID,
    install_persistent_registry,
    reset_session,
)
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db() -> Iterator[None]:
    """Per-test clean schema + clean in-memory session registry + identity seam."""
    db.init_engine("sqlite://")
    db.create_all()
    reset_session()
    set_snapshot_store(MemorySnapshotStore())
    install_persistent_registry()  # get() now hydrates from the (empty) DB
    set_identity_provider(None)  # forget any provider a test swapped in
    try:
        yield
    finally:
        db.drop_all()
        reset_session()
        set_snapshot_store(None)
        set_identity_provider(None)


#: identity header the data-test client authenticates as
TEST_USER_ID = "test-user"
#: data tests target the DEFAULT project so HTTP requests resolve the SAME
#: in-memory Session that ``get_session()`` returns.
AUTH_HEADERS = {"x-user-id": TEST_USER_ID, "x-user-email": "test@example.com"}


def seed_default_project() -> None:
    """Create the 'default' project owned by TEST_USER_ID (idempotent).

    Data-test client fixtures call this so the authenticated test user is an
    owner of the project their requests target.
    """
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(Project, DEFAULT_PROJECT_ID) is None:
            s.add(User(id=TEST_USER_ID, email="test@example.com"))
            s.add(Project(id=DEFAULT_PROJECT_ID, name="Default Project"))
            s.add(
                Membership(
                    user_id=TEST_USER_ID,
                    project_id=DEFAULT_PROJECT_ID,
                    role=Role.owner,
                )
            )
            s.commit()
    finally:
        gen.close()


def papi(path: str) -> str:
    """Build a default-project-scoped data URL. papi('/metamodel') ->
    '/api/v1/projects/default/metamodel'."""
    return f"/api/v1/projects/{DEFAULT_PROJECT_ID}{path}"


# --- shared data-route test helpers ---------------------------------------
# These mirror the HTTP-based helpers the Phase-8 commit tests grew locally.
# They assume a default project seeded with a metamodel that defines a ``Node``
# element type (the commit-history / revert suites both use such a metamodel).


def model_rev(c: TestClient) -> int:
    """Current ``model_rev`` from GET /model/summary."""
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def element_count(c: TestClient) -> int:
    """Current ``element_count`` from GET /model/summary."""
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["element_count"]


def commit_create(c: TestClient, label: str | None = None) -> str:
    """Create a ``Node`` via the legacy ops path; return its canonical id.

    ``label`` is injected as a ``label`` property only when supplied — the
    history suite's ``Node`` defines no properties, so its callers pass none.
    """
    props = {} if label is None else {"label": label}
    r = c.post(
        papi("/model/ops"),
        json={
            "base_rev": model_rev(c),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_n",
                 "type_name": "Node", "properties": props}
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_n"]


def feed_url(user: str = TEST_USER_ID) -> str:
    """WebSocket feed URL with dev-identity query params for ``user``."""
    return papi(f"/feed?x-user-id={user}&x-user-email={user}@example.com")
