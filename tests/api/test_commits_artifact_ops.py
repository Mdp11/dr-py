"""Artifact ops through the lock-verified commit flow: lease enforcement,
journaling, artifact_rev lockstep with the legacy PUT path, rollback
atomicity, and feed events."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.db_models import Role, User
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, feed_url, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

SNIP: dict[str, Any] = {
    "schema_version": 1,
    "language": "python",
    "code": "def value(el):\n    return 1\n",
}

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str) -> None:
    """Add *user_id* as an editor of the default project (mirrors the helper of
    the same name in ``test_locks_route.py`` / ``test_locking_typed.py``) so a
    peer-conflict test exercises the lock 409 path rather than authz's 403."""
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()  # each TestClient creates its own event loop; clear the cached one
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    rev: int = c.get(papi("/model/summary")).json()["model_rev"]
    return rev


def _elements(c: TestClient) -> int:
    count: int = c.get(papi("/model/summary")).json()["element_count"]
    return count


def _mk_snippet(c: TestClient, name: str = "s1") -> dict[str, Any]:
    r = c.post(
        papi("/artifacts"), json={"kind": "code_snippet", "name": name, "payload": SNIP}
    )
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


def _lock_artifacts(
    c: TestClient, artifact_ids: list[str], intent: str = "edit"
) -> str:
    r = c.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": aid, "mode": "exclusive", "type": "artifact"}
                for aid in artifact_ids
            ],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def test_update_without_lock_409_missing(client: TestClient) -> None:
    art = _mk_snippet(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "update_artifact",
                    "id": art["id"],
                    "payload": {**SNIP, "code": "x = 1"},
                }
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 409
    assert r.json()["missing"][0]["resource_id"] == f"art:{art['id']}"


def test_locked_update_commits_and_bumps_both_revs(client: TestClient) -> None:
    art = _mk_snippet(client)
    tok = _lock_artifacts(client, [art["id"]])
    before_rev = _rev(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": before_rev,
            "ops": [
                {
                    "kind": "update_artifact",
                    "id": art["id"],
                    "payload": {**SNIP, "code": "def step(el):\n    return el\n"},
                }
            ],
            "lock_tokens": [tok],
            "message": "edit snippet",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == before_rev + 1  # project rev moved
    assert body["changed_artifacts"][0]["id"] == art["id"]
    assert body["changed_artifacts"][0]["artifact_rev"] == art["artifact_rev"] + 1
    got = client.get(papi(f"/artifacts/{art['id']}")).json()
    assert "step" in got["payload"]["entry_points"]  # derived metadata ran
    # the lease was auto-released by the commit
    assert client.get(papi("/locks")).json()["leases"] == []
    # journaled: history shows the commit with 1 op
    hist = client.get(papi("/commits")).json()["commits"]
    assert hist[0]["message"] == "edit snippet" and hist[0]["op_count"] == 1
    # ...and the durable row carries the artifact op on BOTH sides. The inverse
    # is what makes the journal a standalone undo/diff source, so it must carry
    # the FULL prior state (name + payload), not a patch.
    gen = db.get_db()
    s = next(gen)
    try:
        row = content.list_commits(s, DEFAULT_PROJECT_ID, before_rev=None, limit=1)[0]
        assert [op["kind"] for op in row.ops] == ["update_artifact"]
        assert [op["kind"] for op in row.inverse_ops] == ["update_artifact"]
        inverse = row.inverse_ops[0]
        assert inverse["id"] == art["id"]
        assert inverse["name"] == art["name"]
        assert inverse["payload"]["code"] == SNIP["code"]  # pre-commit code
    finally:
        gen.close()


def test_create_needs_no_lock_and_maps_temp_id(client: TestClient) -> None:
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_a",
                    "artifact_kind": "code_snippet",
                    "name": "born-in-commit",
                    "payload": SNIP,
                }
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    aid = r.json()["id_map"]["tmp_a"]
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 200


def test_mixed_batch_atomic_rollback_on_artifact_failure(client: TestClient) -> None:
    # model op valid + artifact update valid + artifact op invalid -> the whole
    # batch is rejected: the element is NOT created (in-memory rollback) AND the
    # staged artifact row change is discarded (db.rollback).
    art = _mk_snippet(client, "survivor")
    tok = _lock_artifacts(client, [art["id"], "does-not-exist"], intent="delete")
    before_elements = _elements(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_e",
                    "type_name": "Node",
                    "properties": {},
                },
                {
                    "kind": "update_artifact",
                    "id": art["id"],
                    "payload": {**SNIP, "code": "z = 3"},
                },
                {"kind": "delete_artifact", "id": "does-not-exist"},
            ],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 422
    assert _elements(client) == before_elements
    got = client.get(papi(f"/artifacts/{art['id']}")).json()
    assert got["artifact_rev"] == art["artifact_rev"]
    assert got["payload"]["code"] == SNIP["code"]


def test_delete_artifact_requires_exclusive_lock_and_removes_row(
    client: TestClient,
) -> None:
    art = _mk_snippet(client, "todelete")
    tok = _lock_artifacts(client, [art["id"]], intent="delete")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_artifact", "id": art["id"]}],
            "lock_tokens": [tok],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["deleted_artifact_ids"] == [art["id"]]
    assert client.get(papi(f"/artifacts/{art['id']}")).status_code == 404


def test_shared_lease_is_not_enough_to_delete_an_artifact(client: TestClient) -> None:
    """The negative of the test above. ``verify_held`` gates on MODE, not
    intent (an edit-intent EXCLUSIVE lease satisfies a delete op — see
    ``test_delete_intent_acquire_conflicts_with_a_peer_pin`` for where the
    intent actually bites), so the enforceable requirement at commit time is
    "exclusive": a shared pin is refused."""
    art = _mk_snippet(client, "pinned")
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": art["id"], "mode": "shared", "type": "artifact"}
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_artifact", "id": art["id"]}],
            "lock_tokens": [r.json()["token"]],
        },
    )
    assert r.status_code == 409
    missing = r.json()["missing"][0]
    assert missing["resource_id"] == f"art:{art['id']}"
    assert missing["mode"] == "exclusive"
    assert client.get(papi(f"/artifacts/{art['id']}")).status_code == 200


def test_delete_intent_acquire_conflicts_with_a_peer_pin(client: TestClient) -> None:
    """Where DELETE intent earns its keep on an ``art:`` resource: acquiring a
    delete-intent lease requires the artifact to be clear of EVERY other
    holder, shared pins included, while an edit-intent exclusive would happily
    coexist with that pin."""
    art = _mk_snippet(client, "peer-pinned")
    _seed_second_member(OTHER_HEADERS["x-user-id"], OTHER_HEADERS["x-user-email"])
    r = client.post(
        papi("/locks"),
        headers=OTHER_HEADERS,
        json={
            "targets": [
                {"resource_id": art["id"], "mode": "shared", "type": "artifact"}
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    target = {"resource_id": art["id"], "mode": "exclusive", "type": "artifact"}
    r = client.post(papi("/locks"), json={"targets": [target], "intent": "delete"})
    assert r.status_code == 409
    assert r.json()["conflicts"][0]["resource_id"] == f"art:{art['id']}"
    # the same target under EDIT intent is granted despite the peer's pin
    r = client.post(papi("/locks"), json={"targets": [target], "intent": "edit"})
    assert r.status_code == 200, r.text


def test_delete_feed_event_matches_the_legacy_delete_route(client: TestClient) -> None:
    """Both write paths must put the SAME header shape on the wire — a client
    reading e.g. ``updated_by`` off a delete event cannot work through
    ``DELETE /artifacts/{id}`` and break through ``POST /commits``."""
    via_commit = _mk_snippet(client, "via-commit")
    via_route = _mk_snippet(client, "via-route")
    tok = _lock_artifacts(client, [via_commit["id"]], intent="delete")
    with client.websocket_connect(feed_url()) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        r = client.post(
            papi("/commits"),
            json={
                "base_rev": _rev(client),
                "ops": [{"kind": "delete_artifact", "id": via_commit["id"]}],
                "lock_tokens": [tok],
            },
        )
        assert r.status_code == 200, r.text
        commit_evt = ws.receive_json()
        while commit_evt["type"] != "artifact":
            commit_evt = ws.receive_json()
        assert client.delete(papi(f"/artifacts/{via_route['id']}")).status_code == 204
        route_evt = ws.receive_json()
        while route_evt["type"] != "artifact":
            route_evt = ws.receive_json()
    assert commit_evt["action"] == route_evt["action"] == "deleted"
    assert commit_evt["artifact"].keys() == route_evt["artifact"].keys()
    assert commit_evt["artifact"]["updated_by"] == route_evt["artifact"]["updated_by"]
    # payload-derived field: present on a DELETE event only because the header
    # was projected from the row BEFORE it was removed
    assert commit_evt["artifact"]["entry_points"] == ["script", "value"]


def test_preview_validates_artifact_ops_without_writes(client: TestClient) -> None:
    art = _mk_snippet(client, "pv")
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "update_artifact",
                    "id": art["id"],
                    "payload": {"schema_version": 1, "language": "ruby", "code": "x"},
                }
            ],
        },
    )
    assert r.status_code == 422  # invalid payload caught
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "update_artifact",
                    "id": art["id"],
                    "payload": {**SNIP, "code": "y = 2"},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text  # valid -> normal preview
    assert (
        client.get(papi(f"/artifacts/{art['id']}")).json()["payload"]["code"]
        == SNIP["code"]
    )


def test_commit_feed_reports_artifact_scope(client: TestClient) -> None:
    """A pure-artifact commit is announced with scope=["artifact"] plus an
    artifact event, so a peer refreshes its library without refetching model
    content it knows did not move."""
    with client.websocket_connect(feed_url()) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        r = client.post(
            papi("/commits"),
            json={
                "base_rev": _rev(client),
                "ops": [
                    {
                        "kind": "create_artifact",
                        "temp_id": "tmp_a",
                        "artifact_kind": "code_snippet",
                        "name": "feed-me",
                        "payload": SNIP,
                    }
                ],
                "lock_tokens": [],
            },
        )
        assert r.status_code == 200, r.text
        commit = ws.receive_json()
        while commit["type"] != "commit":  # skip the own-presence join
            commit = ws.receive_json()
        assert commit["scope"] == ["artifact"]
        assert commit["changed_elements"] == []
        art = ws.receive_json()
        assert art["type"] == "artifact" and art["action"] == "created"
        assert art["artifact"]["name"] == "feed-me"
