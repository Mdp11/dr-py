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


def _seed(pid: str, uid: str, role: Role = Role.owner) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, uid) is None:
            s.add(User(id=uid, email=""))
        if s.get(Project, pid) is None:
            s.add(Project(id=pid, name=pid))
        s.add(Membership(user_id=uid, project_id=pid, role=role))
        s.commit()
    finally:
        gen.close()


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def _load_content(client: TestClient, pid: str, uid: str) -> None:
    assert client.post(
        f"/api/v1/projects/{pid}/metamodel",
        content=SIMPLE_MM,
        headers={"content-type": "application/x-yaml", **_h(uid)},
    ).status_code == 200
    assert client.post(
        f"/api/v1/projects/{pid}/model",
        json={
            "elements": [{"id": "b1", "type_name": "Block", "properties": {}}],
            "relationships": [],
        },
        headers=_h(uid),
    ).status_code == 200


def test_member_can_clone_and_becomes_owner(client: TestClient) -> None:
    _seed("src", "owner1")
    _load_content(client, "src", "owner1")

    res = client.post("/api/v1/projects/src/clone", json={}, headers=_h("owner1"))
    assert res.status_code == 201, res.text
    body = res.json()
    new_id = body["id"]
    assert new_id != "src"
    assert body["role"] == "owner"
    assert body["name"] == "src (copy)"

    # clone carries the source's current model state...
    summ = client.get(
        f"/api/v1/projects/{new_id}/model/summary", headers=_h("owner1")
    )
    assert summ.status_code == 200
    assert summ.json()["element_count"] == 1
    # ...and starts at a fresh rev-0 (no history copied)
    assert summ.json()["model_rev"] == 0


def test_viewer_can_clone(client: TestClient) -> None:
    _seed("src", "owner1")
    _load_content(client, "src", "owner1")
    _seed("src", "viewer1", role=Role.viewer)

    res = client.post("/api/v1/projects/src/clone", json={"name": "Fork"}, headers=_h("viewer1"))
    assert res.status_code == 201, res.text
    assert res.json()["name"] == "Fork"
    assert res.json()["role"] == "owner"
