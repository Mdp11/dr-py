from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User
from data_rover.api.main import create_app
from data_rover.api.project_state import get_registry
from .conftest import (
    install,
    head,
)

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
    install(
        "alpha",
        metamodel=SIMPLE_MM,
        model=json.dumps(
            {
                "elements": [{"id": "b1", "type_name": "Block", "properties": {}}],
                "relationships": [],
            }
        ),
    )
    assert (
        client.post(
            "/api/v1/projects/beta/metamodel",
            content=SIMPLE_MM,
            headers={"content-type": "application/x-yaml", **_h("u1")},
        ).status_code
        == 200
    )
    assert len(head("alpha").elements) == 1
    # beta has its own metamodel but no entities: alpha's load did NOT leak in
    assert head("beta").elements == {} and head("beta").relationships == {}
    assert get_registry().get("beta").metamodel is not None
