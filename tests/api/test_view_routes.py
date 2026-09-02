from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import (
    AUTH_HEADERS,
    create_folder_via_commit,
    create_view,
    feed_url,
    papi,
    seed_default_project,
)

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"
API = "/api/v1/projects/default"
VIEWER = {"x-user-id": "viewer-1", "x-user-email": "viewer@example.com"}
PEER = {"x-user-id": "peer-1", "x-user-email": "peer@example.com"}


def _seed_member(user_id: str, email: str, role: str) -> None:
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role(role))
    finally:
        gen.close()


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _bootstrap(client: TestClient) -> tuple[str, str]:
    """Upload metamodel + a tiny model with two Blocks; return their ids."""
    client.post(
        f"{API}/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post(f"{API}/model", json={"elements": [], "relationships": []})
    a = client.post(
        f"{API}/model/elements",
        json={"type": "Block", "properties": {"name": "A", "mass": 1.0}},
    ).json()
    b = client.post(
        f"{API}/model/elements",
        json={"type": "Block", "properties": {"name": "B", "mass": 2.0}},
    ).json()
    return a["id"], b["id"]


def test_list_empty_and_unknown_404(client: TestClient) -> None:
    _bootstrap(client)
    assert client.get(papi("/views")).json() == []
    assert client.get(papi("/views/nope")).status_code == 404
    assert client.delete(papi("/views/nope")).status_code == 404


def test_create_list_get_delete(client: TestClient) -> None:
    a_id, _ = _bootstrap(client)
    r = client.post(
        papi("/views"),
        json={
            "name": "  Ops ",
            "view": {"name": "ignored", "folders": [{"name": "F", "elements": [a_id]}]},
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "Ops" and body["view_rev"] == 0
    vid = body["id"]
    create_view(client, "Arch")

    listed = client.get(papi("/views")).json()
    assert [v["name"] for v in listed] == ["Arch", "Ops"]

    got = client.get(papi(f"/views/{vid}")).json()
    assert got["id"] == vid and got["view_rev"] == 0
    # the row's name wins over the document's, and folder ids are healed
    assert got["view"]["name"] == "Ops"
    assert got["view"]["folders"][0]["id"]
    assert got["view"]["folders"][0]["elements"] == [a_id]
    assert got["warnings"] == []
    assert get_session().views[vid].name == "Ops"

    assert client.delete(papi(f"/views/{vid}")).status_code == 204
    assert [v["name"] for v in client.get(papi("/views")).json()] == ["Arch"]
    assert client.get(papi(f"/views/{vid}")).status_code == 404
    assert vid not in get_session().views


def test_get_surfaces_validate_view_warnings(client: TestClient) -> None:
    _bootstrap(client)
    vid = create_view(client, "V", {"folders": [{"name": "F", "elements": ["ghost"]}]})
    got = client.get(papi(f"/views/{vid}")).json()
    assert got["warnings"] and got["warnings"][0]["check"] == "view"


def test_duplicate_name_409_and_bad_input_422(client: TestClient) -> None:
    _bootstrap(client)
    create_view(client, "Ops")
    r = client.post(papi("/views"), json={"name": "Ops", "view": {}})
    assert r.status_code == 409
    assert "Ops" in r.json()["detail"]
    assert client.post(papi("/views"), json={"name": "  ", "view": {}}).status_code == 422
    r = client.post(papi("/views"), json={"name": "X", "view": {"folders": "nope"}})
    assert r.status_code == 422
    assert "invalid view document" in r.json()["detail"]


def test_viewer_cannot_add_or_delete(client: TestClient) -> None:
    _bootstrap(client)
    _seed_member("viewer-1", "viewer@example.com", "viewer")
    vid = create_view(client, "Ops")
    assert client.get(papi("/views"), headers=VIEWER).status_code == 200
    r = client.post(papi("/views"), json={"name": "X", "view": {}}, headers=VIEWER)
    assert r.status_code == 403
    assert client.delete(papi(f"/views/{vid}"), headers=VIEWER).status_code == 403


def test_delete_blocked_by_peer_lease_not_own(client: TestClient) -> None:
    _bootstrap(client)
    _seed_member("peer-1", "peer@example.com", "editor")
    vid = create_view(client, "Ops")
    fid = create_folder_via_commit(client, "F", view_id=vid)["id_map"]["tmp_setup"]

    # a peer editing INSIDE the view (a folder lease) blocks the delete
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=PEER,
    )
    assert r.status_code == 200, r.text
    peer_token = r.json()["token"]
    assert client.delete(papi(f"/views/{vid}")).status_code == 409
    client.post(papi("/locks/release"), json={"token": peer_token}, headers=PEER)

    # a peer holding the view's ROOT lease blocks it too
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": vid, "mode": "exclusive", "type": "view"}],
            "intent": "edit",
        },
        headers=PEER,
    )
    assert r.status_code == 200, r.text
    peer_token = r.json()["token"]
    assert client.delete(papi(f"/views/{vid}")).status_code == 409
    client.post(papi("/locks/release"), json={"token": peer_token}, headers=PEER)

    # the caller's OWN lease never blocks
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": vid, "mode": "exclusive", "type": "view"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    assert client.delete(papi(f"/views/{vid}")).status_code == 204


def test_add_and_delete_broadcast_view_events(client: TestClient) -> None:
    _bootstrap(client)
    with client.websocket_connect(feed_url()) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        vid = create_view(client, "Ops")
        ev = ws.receive_json()
        while ev["type"] != "view":
            ev = ws.receive_json()
        assert ev == {"type": "view", "action": "created", "view": {"id": vid, "name": "Ops"}}
        assert client.delete(papi(f"/views/{vid}")).status_code == 204
        ev = ws.receive_json()
        while ev["type"] != "view":
            ev = ws.receive_json()
        assert ev == {"type": "view", "action": "deleted", "view": {"id": vid, "name": "Ops"}}


def test_excluded_roots_take_a_view_id(client: TestClient) -> None:
    a_id, b_id = _bootstrap(client)
    vid = create_view(client, "V", {"folders": [{"name": "F", "elements": [a_id]}]})
    all_roots = client.get(papi("/model/containment/roots/excluded")).json()
    assert {i["id"] for i in all_roots["items"]} == {a_id, b_id}
    scoped = client.get(papi(f"/model/containment/roots/excluded?view_id={vid}")).json()
    assert {i["id"] for i in scoped["items"]} == {b_id}
