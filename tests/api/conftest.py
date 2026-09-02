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
# The chunked background validation sweep runs inline so the existing
# suite's "validation seeded after load" assumption keeps holding.
os.environ.setdefault("DATA_ROVER_VALIDATION_SWEEP_SYNC", "true")
os.environ.setdefault("DATA_ROVER_SEARCH_INDEX_SYNC", "true")
os.environ.setdefault("DATA_ROVER_SNAPSHOT_SYNC", "true")
# Pin all existing data tests to the header provider so they keep working after
# the default flips to "cookie" in settings.py.
os.environ.setdefault("DATA_ROVER_IDENTITY_PROVIDER", "header")
# Neutralize any local .env bootstrap admin so the import-time create_app()
# does not query the (not-yet-created) users table. An empty env value
# overrides the .env file for pydantic-settings.
os.environ.setdefault("DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL", "")
os.environ.setdefault("DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD", "")

from data_rover.api import db  # noqa: E402
from data_rover.api import db_models  # noqa: E402,F401  (registers ORM tables)
from data_rover.api.db_models import Membership, Project, Role, User  # noqa: E402
from data_rover.api.identity import set_identity_provider  # noqa: E402
from data_rover.api.lock_mirror import MemoryLeaseMirror, set_lease_mirror  # noqa: E402
from data_rover.api.script_sweep import reset_global_slots  # noqa: E402
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
    # a test pinning different sweep settings gets a freshly sized process-wide
    # sweep semaphore instead of one another test lazily sized
    reset_global_slots()
    set_snapshot_store(MemorySnapshotStore())
    set_lease_mirror(MemoryLeaseMirror())
    install_persistent_registry()  # get() now hydrates from the (empty) DB
    set_identity_provider(None)  # forget any provider a test swapped in
    try:
        yield
    finally:
        db.drop_all()
        reset_session()
        reset_global_slots()
        set_snapshot_store(None)
        set_lease_mirror(None)
        set_identity_provider(None)


@pytest.fixture
def cookie_provider(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Opt-in: switch the app to cookie identity for a test module.
    Modules opt in with `pytestmark = pytest.mark.usefixtures("cookie_provider")`."""
    monkeypatch.setenv("DATA_ROVER_IDENTITY_PROVIDER", "cookie")
    monkeypatch.setenv("DATA_ROVER_JWT_SECRET", "test-secret-not-the-default")
    monkeypatch.setenv("DATA_ROVER_AUTH_COOKIE_SECURE", "false")
    set_identity_provider(None)  # rebuild provider from patched settings
    yield
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


def login(c: TestClient, email: str, password: str) -> None:
    """Log a TestClient in via cookie auth; the cookie persists on the client."""
    r = c.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text


#: CSRF header the SPA (and cookie-authed tests) send on unsafe requests.
CSRF_HEADERS = {"x-requested-with": "data-rover"}


# --- shared data-route test helpers ---------------------------------------
# HTTP-based helpers shared by the commit-history / revert suites, which
# assume a default project seeded with a metamodel that defines a ``Node``
# element type.


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


def create_view(
    c: TestClient,
    name: str = "Default",
    doc: dict | None = None,
    *,
    headers: dict | None = None,
) -> str:
    """Add a named view via ``POST /views``; returns its id."""
    hdrs = headers if headers is not None else AUTH_HEADERS
    r = c.post(
        papi("/views"),
        json={"name": name, "view": doc if doc is not None else {"name": name}},
        headers=hdrs,
    )
    assert r.status_code == 201, r.text
    view_id: str = r.json()["id"]
    return view_id


def default_view_id(c: TestClient, *, headers: dict | None = None) -> str:
    """The project's first view by name, created as ``"Default"`` when the
    project has none — the one-view setup most view tests want."""
    hdrs = headers if headers is not None else AUTH_HEADERS
    views = c.get(papi("/views"), headers=hdrs).json()
    if views:
        first: str = views[0]["id"]
        return first
    return create_view(c, headers=hdrs)


def container_lock_target(view_id: str, folder_id: str) -> dict:
    """The lock target for editing inside *folder_id* of *view_id*: the
    folder's own `folder:` lease, or the VIEW's lease for the root."""
    if folder_id == "root":
        return {"resource_id": view_id, "mode": "exclusive", "type": "view"}
    return {"resource_id": folder_id, "mode": "exclusive", "type": "folder"}


def create_folder_via_commit(
    c: TestClient,
    name: str,
    *,
    view_id: str | None = None,
    parent_id: str = "root",
    headers: dict | None = None,
) -> dict:
    """Create one folder via ``POST /commits`` and return the full commit
    response body (``id_map``, ``view_revs``, etc).

    Used by view-op tests purely to seed an initial named folder with an id.
    ``view_id`` defaults to :func:`default_view_id`. Acquires (and lets the
    commit release) its own lease on *parent_id* — the view itself for
    ``"root"`` (the default).
    """
    hdrs = headers if headers is not None else AUTH_HEADERS
    vid = view_id if view_id is not None else default_view_id(c, headers=hdrs)
    lease = c.post(
        papi("/locks"),
        json={"targets": [container_lock_target(vid, parent_id)], "intent": "edit"},
        headers=hdrs,
    )
    assert lease.status_code == 200, lease.text
    token = lease.json()["token"]
    base = c.get(papi("/open"), headers=hdrs).json()["model_rev"]
    r = c.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {
                    "kind": "create_folder",
                    "view_id": vid,
                    "temp_id": "tmp_setup",
                    "parent_id": parent_id,
                    "name": name,
                }
            ],
            "message": "setup",
            "lock_tokens": [token],
        },
        headers=hdrs,
    )
    assert r.status_code == 200, r.text
    body: dict = r.json()
    body["view_id"] = vid
    return body


def feed_url(user: str = TEST_USER_ID) -> str:
    """WebSocket feed URL with dev-identity query params for ``user``."""
    return papi(f"/feed?x-user-id={user}&x-user-email={user}@example.com")
