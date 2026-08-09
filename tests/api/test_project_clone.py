from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User
from data_rover.api.main import create_app
from data_rover.api.session import get_registry

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


def _create_artifact(
    client: TestClient, pid: str, uid: str, kind: str, name: str, payload: dict
) -> dict:
    res = client.post(
        f"/api/v1/projects/{pid}/artifacts",
        json={"kind": kind, "name": name, "payload": payload},
        headers=_h(uid),
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_clone_carries_artifacts_with_remapped_refs(client: TestClient) -> None:
    _seed("src", "owner1")
    _load_content(client, "src", "owner1")
    snip = _create_artifact(
        client,
        "src",
        "owner1",
        "code_snippet",
        "s",
        {
            "schema_version": 1,
            "language": "python",
            "code": "def value(el):\n    return el.name\n",
        },
    )
    # a cross-kind ref (SnippetSource.ref) so the clone has something whose
    # remap can only be right if it points at the CLONE's snippet id
    nav = _create_artifact(
        client,
        "src",
        "owner1",
        "navigation",
        "n",
        {
            "kind": "path",
            "start": {"kind": "scope", "types": ["Block"]},
            "steps": [{"kind": "script", "snippet": {"ref": snip["id"]}}],
        },
    )

    res = client.post(
        "/api/v1/projects/src/clone", json={"name": "Klone"}, headers=_h("owner1")
    )
    assert res.status_code == 201, res.text
    new_id = res.json()["id"]

    arts = client.get(
        f"/api/v1/projects/{new_id}/artifacts", headers=_h("owner1")
    ).json()["items"]
    by_name = {a["name"]: a for a in arts}
    assert set(by_name) == {"s", "n"}
    # fresh ids: a clone owns its artifacts, it does not alias the source's
    assert by_name["s"]["id"] != snip["id"]
    assert by_name["n"]["id"] != nav["id"]
    # the list route omits payloads, so fetch the clone's navigation in full
    full_nav = client.get(
        f"/api/v1/projects/{new_id}/artifacts/{by_name['n']['id']}",
        headers=_h("owner1"),
    ).json()
    assert full_nav["payload"]["steps"][0]["snippet"]["ref"] == by_name["s"]["id"]


def test_cloned_artifacts_survive_eviction(client: TestClient) -> None:
    """Artifacts are DB rows, independent of the in-memory Session: evicting
    the clone's session must not lose them."""
    _seed("src", "owner1")
    _load_content(client, "src", "owner1")
    _create_artifact(
        client,
        "src",
        "owner1",
        "navigation",
        "n",
        {"kind": "path", "start": {"kind": "scope", "types": ["Block"]}, "steps": []},
    )
    new_id = client.post(
        "/api/v1/projects/src/clone", json={}, headers=_h("owner1")
    ).json()["id"]
    before = client.get(
        f"/api/v1/projects/{new_id}/artifacts", headers=_h("owner1")
    ).json()["items"]
    assert [a["name"] for a in before] == ["n"]

    # the GET above went through get_request_session, so the clone is warm —
    # without this the eviction below could pass vacuously
    assert new_id in get_registry().project_ids()
    get_registry().evict(new_id)
    assert new_id not in get_registry().project_ids()

    after = client.get(
        f"/api/v1/projects/{new_id}/artifacts", headers=_h("owner1")
    ).json()["items"]
    assert [a["id"] for a in after] == [a["id"] for a in before]


def test_viewer_can_clone(client: TestClient) -> None:
    _seed("src", "owner1")
    _load_content(client, "src", "owner1")
    _seed("src", "viewer1", role=Role.viewer)

    res = client.post("/api/v1/projects/src/clone", json={"name": "Fork"}, headers=_h("viewer1"))
    assert res.status_code == 201, res.text
    assert res.json()["name"] == "Fork"
    assert res.json()["role"] == "owner"
