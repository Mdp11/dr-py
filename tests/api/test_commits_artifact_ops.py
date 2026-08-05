"""Artifact ops through the lock-verified commit flow: lease enforcement,
journaling, artifact_rev lockstep with the legacy PUT path, rollback
atomicity, and feed events."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app

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


def test_delete_artifact_requires_delete_lock_and_removes_row(
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
