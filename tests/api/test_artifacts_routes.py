"""Artifacts CRUD: project-scoped, membership-authorized, optimistic-rev
guarded, payload-validated per kind."""

from __future__ import annotations


import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.tenancy import add_member

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    install,
    EMPTY_MODEL,
)

API = "/api/v1/projects/default"

NAV_PAYLOAD = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [{"kind": "relationship", "relationship_type": "BlockHasPart"}],
}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _create(client: TestClient, name: str = "My nav") -> dict:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": name, "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_create_get_list_roundtrip(client: TestClient) -> None:
    created = _create(client)
    assert created["artifact_rev"] == 1
    assert created["payload"]["kind"] == "path"

    got = client.get(f"{API}/artifacts/{created['id']}").json()
    assert got["name"] == "My nav"

    listed = client.get(f"{API}/artifacts", params={"kind": "navigation"}).json()
    assert [a["id"] for a in listed["items"]] == [created["id"]]
    # headers carry no payload
    assert "payload" not in listed["items"][0]


def test_create_duplicate_name_409(client: TestClient) -> None:
    _create(client)
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "My nav", "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 409


def test_create_invalid_payload_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "bad", "payload": {"kind": "nope"}},
    )
    assert res.status_code == 422


def test_create_unsupported_kind_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts", json={"kind": "table", "name": "t", "payload": {}}
    )
    assert res.status_code == 422


def test_snippet_entry_points_are_server_derived(client: TestClient) -> None:
    body = {
        "kind": "code_snippet",
        "name": "col1",
        "payload": {
            "schema_version": 1, "language": "python",
            "code": "def value(el):\n    return len(el.name)\n",
            "entry_points": ["lies"],  # client lie, must be overwritten
        },
    }
    r = client.post(papi("/artifacts"), json=body)
    assert r.status_code == 201, r.text
    got = r.json()["payload"]["entry_points"]
    assert set(got) == {"script", "value"}


def test_create_code_snippet_invalid_payload_rejected(client: TestClient) -> None:
    # Adapter registered: schema violations (non-python language) still 422.
    r = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "s1", "payload": {"schema_version": 1, "language": "ruby", "code": "x = 1"}},
    )
    assert r.status_code == 422, r.text


def test_snippet_header_carries_entry_points(client: TestClient) -> None:
    code = "def value(el):\n    return el.name\n"
    created = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "snip", "payload": {"code": code}},
    )
    assert created.status_code == 201, created.text
    assert sorted(created.json()["entry_points"]) == ["script", "value"]

    listed = client.get(papi("/artifacts"))
    row = next(a for a in listed.json()["items"] if a["id"] == created.json()["id"])
    assert sorted(row["entry_points"]) == ["script", "value"]


def test_non_snippet_header_entry_points_is_none(client: TestClient) -> None:
    created = _create(client)
    listed = client.get(papi("/artifacts"))
    row = next(a for a in listed.json()["items"] if a["id"] == created["id"])
    assert row["entry_points"] is None


def test_update_rev_conflict_and_success(client: TestClient) -> None:
    created = _create(client)
    stale = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 99, "name": "renamed"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_rev"] == 1

    ok = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "renamed"},
    )
    assert ok.status_code == 200
    assert ok.json()["artifact_rev"] == 2
    assert ok.json()["name"] == "renamed"


def test_delete_then_404(client: TestClient) -> None:
    created = _create(client)
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 204
    assert client.get(f"{API}/artifacts/{created['id']}").status_code == 404
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 404


# ---------------------------------------------------------------------------
# Peer-lease guard on the legacy write routes.
# `art:` leases only mean anything if EVERY writer to the row honours them:
# without this, an editor holding `art:X` mid-edit can have their commit
# silently overwrite (or be overwritten by) a legacy PUT/DELETE.
# ---------------------------------------------------------------------------

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str) -> None:
    """Add *user_id* as an editor of the default project (mirrors the helper of
    the same name in ``test_commits_artifact_ops.py``) so a peer-lease test
    exercises the 409 lock path rather than authz's 403."""
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()


def _seed_empty_model(client: TestClient) -> None:
    """POST /locks goes through ``require_model``, so a lease test needs a
    loaded (if empty) model even though artifacts are not model content."""
    install(metamodel="elements:\n  - name: Node\n", model=EMPTY_MODEL)


def _lock_artifact(client: TestClient, artifact_id: str, **kw: object) -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": artifact_id, "mode": "exclusive", "type": "artifact"}
            ],
            "intent": "edit",
        },
        **kw,  # type: ignore[arg-type]
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def test_put_409s_while_a_peer_holds_the_artifact_lease(client: TestClient) -> None:
    _seed_empty_model(client)
    created = _create(client)
    _seed_second_member(OTHER_HEADERS["x-user-id"], OTHER_HEADERS["x-user-email"])
    _lock_artifact(client, created["id"], headers=OTHER_HEADERS)
    r = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "stomped"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["conflicts"][0]["resource_id"] == f"art:{created['id']}"
    # nothing was written
    assert client.get(f"{API}/artifacts/{created['id']}").json()["name"] == "My nav"


def test_delete_409s_while_a_peer_holds_the_artifact_lease(client: TestClient) -> None:
    _seed_empty_model(client)
    created = _create(client)
    _seed_second_member(OTHER_HEADERS["x-user-id"], OTHER_HEADERS["x-user-email"])
    _lock_artifact(client, created["id"], headers=OTHER_HEADERS)
    r = client.delete(f"{API}/artifacts/{created['id']}")
    assert r.status_code == 409, r.text
    assert client.get(f"{API}/artifacts/{created['id']}").status_code == 200


def test_lease_holder_may_still_use_the_legacy_routes(client: TestClient) -> None:
    """Only a PEER's lease blocks: the holder is the one editing, so their own
    lease must never lock them out of their own write path."""
    _seed_empty_model(client)
    created = _create(client)
    _lock_artifact(client, created["id"])
    r = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "mine"},
    )
    assert r.status_code == 200, r.text
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 204


def test_writes_broadcast_artifact_events(client: TestClient) -> None:
    events: list[dict] = []
    hub = get_session().hub
    original = hub.broadcast
    hub.broadcast = events.append  # type: ignore[method-assign]
    try:
        created = _create(client)
        client.put(
            f"{API}/artifacts/{created['id']}",
            json={"artifact_rev": 1, "name": "n2"},
        )
        client.delete(f"{API}/artifacts/{created['id']}")
    finally:
        hub.broadcast = original  # type: ignore[method-assign]
    kinds = [(e["type"], e["action"]) for e in events]
    assert kinds == [("artifact", "created"), ("artifact", "updated"),
                     ("artifact", "deleted")]
    assert events[0]["artifact"]["name"] == "My nav"


def test_viewer_cannot_create(client: TestClient) -> None:
    from data_rover.api import tenancy
    from data_rover.api.db import db_session
    from data_rover.api.db_models import Role

    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1",
                           role=Role.viewer)
    viewer = TestClient(create_app())
    viewer.headers.update({"x-user-id": "viewer-1", "x-user-email": "v@example.com"})
    denied = viewer.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "x",
              "payload": {"kind": "path",
                          "start": {"kind": "scope"}, "steps": []}},
    )
    assert denied.status_code == 403


def test_create_exporter_artifact(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "exporter",
            "name": "release drop",
            "payload": {"entries": [{"source": {"ref": "tbl-1"}}]},
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "exporter"


def test_exporter_payload_is_validated_on_create(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "exporter",
            "name": "bad",
            "payload": {"entries": [{"format": "csv"}]},  # no source, bad format
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_create_table_with_inline_arity_mismatch_422(client: TestClient) -> None:
    payload = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "property", "name": "name"},
            {
                "kind": "script",
                "snippet": {"definition": {"code": "def value(els): return 1"}},
                "inputs": [{"name": "nm", "ref": {"kind": "column", "index": 0}}],
            },
        ],
    }
    res = client.post(
        f"{API}/artifacts", json={"kind": "table", "name": "t", "payload": payload}
    )
    assert res.status_code == 422
    assert "takes 1 argument" in res.text
