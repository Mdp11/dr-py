from __future__ import annotations

import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx import Response

# Force every API test onto an in-memory SQLite db and disable the dev seed
# BEFORE any app/settings import reads the environment.
os.environ.setdefault("DATA_ROVER_DATABASE_URL", "sqlite://")
os.environ.setdefault("DATA_ROVER_DEV_SEED", "false")
os.environ.setdefault("DATA_ROVER_SNAPSHOT_STORE", "memory")
os.environ.setdefault("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
os.environ.setdefault("DATA_ROVER_LOCK_SWEEP_SECONDS", "0")
os.environ.setdefault("DATA_ROVER_SNAPSHOT_SYNC", "true")
# Pin all existing data tests to the header provider so they keep working after
# the default flips to "cookie" in settings.py.
os.environ.setdefault("DATA_ROVER_IDENTITY_PROVIDER", "header")
# Neutralize any local .env bootstrap admin so the import-time create_app()
# does not query the (not-yet-created) users table. An empty env value
# overrides the .env file for pydantic-settings.
os.environ.setdefault("DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL", "")
os.environ.setdefault("DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD", "")

from data_rover.api import content, db  # noqa: E402
from data_rover.api.head import read_head, write_baseline  # noqa: E402
from data_rover.api.snapshot_rows import write_snapshot_from_rows  # noqa: E402
from data_rover.api import db_models  # noqa: E402,F401  (registers ORM tables)
from data_rover.api.db_models import Membership, Project, Role, User  # noqa: E402
from data_rover.api.identity import set_identity_provider  # noqa: E402
from data_rover.api.importer import install_model  # noqa: E402
from data_rover.api.lock_mirror import MemoryLeaseMirror, set_lease_mirror  # noqa: E402
from data_rover.api.project_state import ProjectState  # noqa: E402
from data_rover.core.model.model import Model  # noqa: E402
from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_str  # noqa: E402
from data_rover.api.project_state import DEFAULT_PROJECT_ID, get_registry  # noqa: E402
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db() -> Iterator[None]:
    """Per-test clean schema + clean in-memory project-state registry + identity seam."""
    db.init_engine("sqlite://")
    db.create_all()
    get_registry().reset()
    set_snapshot_store(MemorySnapshotStore())
    set_lease_mirror(MemoryLeaseMirror())
    set_identity_provider(None)  # forget any provider a test swapped in
    try:
        yield
    finally:
        db.drop_all()
        get_registry().reset()
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
#: data tests target the DEFAULT project, whose in-memory state is
#: ``default_state()``.
AUTH_HEADERS = {"x-user-id": TEST_USER_ID, "x-user-email": "test@example.com"}


def default_state() -> ProjectState:
    """The default project's live state."""
    return get_registry().get(DEFAULT_PROJECT_ID)


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


EXAMPLES = Path(__file__).resolve().parents[2] / "examples"
SMART_CITY_MM = (EXAMPLES / "smart-city.metamodel.yaml").read_text(encoding="utf-8")
SMART_CITY_MODEL = (EXAMPLES / "smart-city.model.json").read_text(encoding="utf-8")

#: a model document with no entities
EMPTY_MODEL = '{"elements": [], "relationships": []}'


def install(
    project_id: str = "default",
    *,
    metamodel: str = SMART_CITY_MM,
    model: str | bytes = SMART_CITY_MODEL,
) -> None:
    """Replace the project's metamodel and model at a fresh rev-0 baseline.

    Creates the default project (owned by the test user) when it is missing. A
    project state that is already warm takes the new metamodel and rev; a cold
    one loads them when first asked."""
    if project_id == DEFAULT_PROJECT_ID:
        seed_default_project()
    gen = db.get_db()
    s = next(gen)
    try:
        install_model(s, project_id, metamodel_yaml=metamodel, model_json=model)
    finally:
        gen.close()


def install_unchecked(
    project_id: str = "default",
    *,
    metamodel: str,
    model: str | bytes,
) -> None:
    """``install`` for a model the import refuses, which a head can still come
    to hold: a reference to no element, a property its type does not declare. The
    rows are written from the model the way a baseline writes them."""
    install(project_id, metamodel=metamodel, model=EMPTY_MODEL)
    mm = load_metamodel_str(metamodel)
    built = build_model_from_dicts(mm, parse_model_json(model))
    with db.db_session() as s:
        write_baseline(s, project_id, mm, built)
    write_snapshot_from_rows(project_id)


@dataclass(frozen=True)
class Head:
    """The project's current state: ``rev`` plus entity dicts by id."""

    rev: int
    elements: dict[str, dict]
    relationships: dict[str, dict]


def head(project_id: str = "default") -> Head:
    """The project's current state as the server holds it: the head rows and the
    revision on the model row (the project state's, for a project without one)."""
    with db.db_session() as s:
        row = content.get_model_row(s, project_id)
        elements, relationships = read_head(s, project_id)
        rev = row.model_rev if row is not None else None
    if rev is None:
        rev = get_registry().get(project_id).model_rev
    return Head(
        rev=rev,
        elements={e["id"]: e for e in elements},
        relationships={r["id"]: r for r in relationships},
    )


def rows_model(project_id: str = "default") -> Model:
    """A full model of the project's head rows, in row order: the model the rows
    say the project holds, for checks that need the core model's own readers."""
    with db.db_session() as s:
        row = content.get_model_row(s, project_id)
        assert row is not None
        mm_row = content.get_metamodel_row(s, row.metamodel_id)
        assert mm_row is not None
        elements, relationships = read_head(s, project_id)
    return build_model_from_dicts(
        load_metamodel_str(mm_row.blob),
        {"elements": elements, "relationships": relationships},
        strict=False,
    )


def post_commit(
    client: TestClient,
    ops: list[dict],
    *,
    project_id: str = "default",
    base_rev: int | None = None,
) -> Response:
    """Post *ops* to ``/commits`` at *base_rev* (default: the current head) and
    return the response.

    An edit that needs locks gets them: the server names the missing leases,
    the helper takes them for the test user, commits and releases them."""
    base = f"/api/v1/projects/{project_id}"
    rev = head(project_id).rev if base_rev is None else base_rev
    payload: dict = {"base_rev": rev, "ops": ops}
    r = client.post(f"{base}/commits", json=payload, headers=AUTH_HEADERS)
    if r.status_code == 409 and r.json().get("detail") == "required lock not held":
        lock = client.post(
            f"{base}/locks",
            json={"targets": r.json()["missing"], "intent": "edit"},
            headers=AUTH_HEADERS,
        )
        assert lock.status_code == 200, lock.text
        token = lock.json()["token"]
        payload["lock_tokens"] = [token]
        r = client.post(f"{base}/commits", json=payload, headers=AUTH_HEADERS)
        client.post(
            f"{base}/locks/release", json={"token": token}, headers=AUTH_HEADERS
        )
    return r


def commit_ops(
    client: TestClient,
    ops: list[dict],
    *,
    project_id: str = "default",
    base_rev: int | None = None,
) -> dict:
    """Commit *ops* through ``post_commit``, expect 200 and return the response
    JSON."""
    r = post_commit(client, ops, project_id=project_id, base_rev=base_rev)
    assert r.status_code == 200, r.text
    body: dict = r.json()
    return body


def append_baseline_row(project_id: str = "default") -> int:
    """Write a mid-history opaque baseline: the whole model replaced, history
    cleared, one empty-ops commit row at the next rev. Returns that rev."""
    state = get_registry().get(project_id)
    state.model_rev += 1
    rev = state.model_rev
    with db.db_session() as s:
        content.clear_history(s, project_id)
        content.append_commit(
            s,
            project_id,
            rev=rev,
            commit_id="baseline",
            author_id=None,
            ops=[],
            inverse_ops=[],
            id_map={},
        )
        content.set_model_rev(s, project_id, rev)
    write_snapshot_from_rows(project_id)
    return rev


def unjournaled_bump(project_id: str = "default") -> None:
    """The revision moves with no journal row: on the model row and in the
    project state."""
    state = get_registry().get(project_id)
    state.model_rev += 1
    with db.db_session() as s:
        content.set_model_rev(s, project_id, state.model_rev)


def forget_entity_states(rev: int, project_id: str = "default") -> None:
    """The commit at ``rev`` stores no entity states, as a row written before the
    column existed."""
    with db.db_session() as s:
        row = content.get_commit(s, project_id, rev)
        assert row is not None and row.entity_states is not None
        row.entity_states = None


def no_model_built(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every way of building a whole model fail, so a request that still
    answers has read rows alone."""
    from data_rover.api import snapshot_codec
    from data_rover.api.routes import _snapshot

    def refuse(*_a: object, **_k: object) -> None:
        raise AssertionError("a model was built")

    monkeypatch.setattr(_snapshot, "build_model_from_dicts", refuse)
    monkeypatch.setattr(snapshot_codec, "decode_snapshot", refuse)


def model_rev(c: TestClient) -> int:
    """Current head rev."""
    return head().rev


def element_count(c: TestClient) -> int:
    """Current element count."""
    return len(head().elements)


def commit_create(c: TestClient, label: str | None = None) -> str:
    """Create a ``Node`` through ``/commits``; return its canonical id.

    ``label`` is injected as a ``label`` property only when supplied — the
    history suite's ``Node`` defines no properties, so its callers pass none.
    """
    props = {} if label is None else {"label": label}
    body = commit_ops(
        c,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_n",
                "type_name": "Node",
                "properties": props,
            }
        ],
    )
    nid: str = body["id_map"]["tmp_n"]
    return nid


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
