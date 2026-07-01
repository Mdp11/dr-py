from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User
from data_rover.api.main import create_app

SIMPLE_MM = "elements:\n  - name: Block\n"


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _seed_project_with_member(pid: str, uid: str) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, uid) is None:
            s.add(User(id=uid, email=""))
        s.add(Project(id=pid, name=pid))
        s.add(Membership(user_id=uid, project_id=pid, role=Role.owner))
        s.commit()
    finally:
        gen.close()


def _seed_admin(uid: str) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id=uid, email="admin@example.com", is_admin=True))
        s.commit()
    finally:
        gen.close()


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def test_admin_non_member_can_read_and_write_any_project(client: TestClient) -> None:
    _seed_project_with_member("alpha", "owner1")
    _seed_admin("boss")
    # admin is NOT a member of alpha
    assert client.get("/api/v1/projects/alpha", headers=_h("boss")).status_code == 200
    # and can WRITE (upload a metamodel) despite not being a member
    res = client.post(
        "/api/v1/projects/alpha/metamodel",
        content=SIMPLE_MM,
        headers={"content-type": "application/x-yaml", **_h("boss")},
    )
    assert res.status_code == 200, res.text


def test_non_admin_non_member_still_forbidden(client: TestClient) -> None:
    _seed_project_with_member("alpha", "owner1")
    assert (
        client.get("/api/v1/projects/alpha", headers=_h("stranger")).status_code == 403
    )
