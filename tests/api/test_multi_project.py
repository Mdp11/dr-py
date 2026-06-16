from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User
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
    a = client.get("/api/v1/projects/alpha/model/summary", headers=_h("u1"))
    assert a.status_code == 200
    assert a.json()["element_count"] == 1
    # beta has its own metamodel but no model: alpha's load did NOT leak in, so
    # beta still reports "no model loaded" (404) rather than alpha's element.
    b = client.get("/api/v1/projects/beta/model/summary", headers=_h("u1"))
    assert b.status_code == 404
