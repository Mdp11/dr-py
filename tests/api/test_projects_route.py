"""Project listing + single-project read + delete gating.

Project *creation* (admin-only multipart wizard) is covered in
test_projects_wizard.py; *membership* management (now under /admin) is covered
in test_admin.py. This module covers what remains in routes/projects.py:
- GET /projects/{id} requires membership (member 200, non-member 403)
- GET /projects is admin-sees-all, otherwise own-projects-only
- DELETE /projects/{id} is admin-only

Projects are seeded directly via tenancy (the wizard is exercised elsewhere).
Non-admin callers use header auth (the conftest default provider); admin callers
seed an admin User row and authenticate with that id (header upsert preserves
is_admin on an already-seeded user).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db, tenancy
from data_rover.api.db_models import User
from data_rover.api.main import create_app
from .conftest import (
    install,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def _seed_user(uid: str, *, is_admin: bool = False) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, uid) is None:
            s.add(User(id=uid, email="", is_admin=is_admin))
            s.commit()
    finally:
        gen.close()


def _seed_project(name: str, owner_id: str) -> str:
    """Create a project owned by *owner_id* (seeding the owner if needed)."""
    _seed_user(owner_id)
    gen = db.get_db()
    s = next(gen)
    try:
        return tenancy.create_project(s, name, owner_id).id
    finally:
        gen.close()


def test_get_project_requires_membership(client: TestClient) -> None:
    pid = _seed_project("P", "u1")
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u1")).status_code == 200
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u2")).status_code == 403


def test_non_admin_lists_only_own_projects(client: TestClient) -> None:
    _seed_project("A", "u1")
    _seed_project("B", "u2")
    r = client.get("/api/v1/projects", headers=_h("u1"))
    assert r.status_code == 200
    assert [p["name"] for p in r.json()] == ["A"]


def test_admin_lists_all_projects(client: TestClient) -> None:
    _seed_project("A", "u1")
    _seed_project("B", "u2")
    _seed_user("boss", is_admin=True)
    r = client.get("/api/v1/projects", headers=_h("boss"))
    assert r.status_code == 200
    # admin sees every project even those it isn't a member of; role synthesized
    assert {p["name"] for p in r.json()} == {"A", "B"}
    assert all(p["role"] == "owner" for p in r.json())


def test_delete_project_is_admin_only(client: TestClient) -> None:
    pid = _seed_project("P", "u1")
    # the project owner is NOT a global admin -> forbidden
    assert client.delete(f"/api/v1/projects/{pid}", headers=_h("u1")).status_code == 403
    _seed_user("boss", is_admin=True)
    assert (
        client.delete(f"/api/v1/projects/{pid}", headers=_h("boss")).status_code == 204
    )
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u1")).status_code == 404


def test_delete_loaded_project_discards_its_state(
    client: TestClient,
) -> None:
    """U-7: deleting a project whose project state is loaded, with a lease held
    and a feed client connected, must 204 and drop the state: the evict guard
    would otherwise keep a dead project's state registered forever."""
    import asyncio
    import time
    from pathlib import Path

    from data_rover.api.feed import ClientConn
    from data_rover.api.locking import LockIntent, LockMode, RequiredLock
    from data_rover.api.project_state import get_registry

    pid = _seed_project("P", "u1")
    mm = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
    model = Path("examples/smart-city.model.json").read_text(encoding="utf-8")
    base = f"/api/v1/projects/{pid}"
    install(pid, metamodel=mm, model=model)
    state = get_registry().get(pid)  # loads the project state
    assert state.metamodel is not None and pid in get_registry().project_ids()
    # arm both conditions the evict guard refuses on
    state.lock_table.acquire(
        "u1",
        [RequiredLock("e1", LockMode.EXCLUSIVE, LockIntent.EDIT)],
        now=time.monotonic(),
        ttl=300.0,
    )
    state.hub.register(ClientConn(user_id="u1", queue=asyncio.Queue()))

    _seed_user("boss", is_admin=True)
    assert client.delete(base, headers=_h("boss")).status_code == 204
    assert pid not in get_registry().project_ids()
    assert client.get(base, headers=_h("u1")).status_code == 404
