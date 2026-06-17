from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _h(uid: str, email: str = "") -> dict[str, str]:
    h = {"x-user-id": uid}
    if email:
        h["x-user-email"] = email
    return h


def test_create_project_makes_caller_owner(client: TestClient) -> None:
    r = client.post("/api/v1/projects", json={"name": "P"}, headers=_h("u1"))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "P"
    assert body["role"] == "owner"
    assert body["id"]


def test_list_projects_only_mine(client: TestClient) -> None:
    client.post("/api/v1/projects", json={"name": "A"}, headers=_h("u1"))
    client.post("/api/v1/projects", json={"name": "B"}, headers=_h("u2"))
    r = client.get("/api/v1/projects", headers=_h("u1"))
    assert [p["name"] for p in r.json()] == ["A"]


def test_get_project_requires_membership(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u1")).status_code == 200
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u2")).status_code == 403


def test_add_and_list_members(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    r = client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u2", "email": "u2@x.com", "role": "editor"},
        headers=_h("u1"),
    )
    assert r.status_code == 201, r.text
    # the add response echoes the stored email, consistent with list_members
    assert r.json() == {"user_id": "u2", "email": "u2@x.com", "role": "editor"}
    members = client.get(
        f"/api/v1/projects/{pid}/members", headers=_h("u1")
    ).json()
    assert {m["user_id"]: m["role"] for m in members} == {
        "u1": "owner",
        "u2": "editor",
    }


def test_only_owner_can_add_members(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u2", "role": "editor"},
        headers=_h("u1"),
    )
    r = client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u3", "role": "viewer"},
        headers=_h("u2"),
    )
    assert r.status_code == 403


def test_remove_member(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{pid}/members",
        json={"user_id": "u2", "role": "editor"},
        headers=_h("u1"),
    )
    r = client.delete(
        f"/api/v1/projects/{pid}/members/u2", headers=_h("u1")
    )
    assert r.status_code == 204
    members = client.get(
        f"/api/v1/projects/{pid}/members", headers=_h("u1")
    ).json()
    assert [m["user_id"] for m in members] == ["u1"]


def test_delete_project(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    assert client.delete(
        f"/api/v1/projects/{pid}", headers=_h("u1")
    ).status_code == 204
    assert client.get(f"/api/v1/projects/{pid}", headers=_h("u1")).status_code == 404


def test_remove_last_owner_is_422(client: TestClient) -> None:
    pid = client.post(
        "/api/v1/projects", json={"name": "P"}, headers=_h("u1")
    ).json()["id"]
    # u1 is the only owner — removing them is refused (ValueError -> 422)
    r = client.delete(f"/api/v1/projects/{pid}/members/u1", headers=_h("u1"))
    assert r.status_code == 422, r.text
