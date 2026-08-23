"""Undo of a commit containing artifact ops: the artifact row is restored
(exact id), a compensating forward commit is journaled, both halves unwind
together when the artifact replay fails, and revert refuses ranges containing
artifact ops."""

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


def _summary(c: TestClient) -> dict[str, Any]:
    body: dict[str, Any] = c.get(papi("/model/summary")).json()
    return body


def _commit(c: TestClient, ops: list[dict[str, Any]], tokens: list[str]) -> Any:
    return c.post(
        papi("/commits"),
        json={"base_rev": _rev(c), "ops": ops, "lock_tokens": tokens},
    )


def _commit_create_snippet(c: TestClient, name: str = "s1") -> str:
    r = _commit(
        c,
        [
            {
                "kind": "create_artifact",
                "temp_id": "tmp_a",
                "artifact_kind": "code_snippet",
                "name": name,
                "payload": SNIP,
            }
        ],
        [],
    )
    assert r.status_code == 200, r.text
    aid: str = r.json()["id_map"]["tmp_a"]
    return aid


def _lock(c: TestClient, artifact_id: str, intent: str = "delete") -> str:
    r = c.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": artifact_id, "mode": "exclusive", "type": "artifact"}
            ],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _receive_artifact_event(ws: Any, attempts: int = 5) -> dict[str, Any]:
    """Drain up to *attempts* feed events looking for an artifact one.

    Bounded on purpose: an unbounded `while evt["type"] != "artifact"` loop
    turns a missing event into a hung test run instead of a failure.
    """
    for _ in range(attempts):
        evt: dict[str, Any] = ws.receive_json()
        if evt["type"] == "artifact":
            return evt
    raise AssertionError(f"no artifact event within {attempts} feed events")


def test_undo_artifact_create_deletes_row_and_moves_rev_forward(
    client: TestClient,
) -> None:
    aid = _commit_create_snippet(client)
    rev_after_commit = _rev(client)
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == rev_after_commit + 1  # forward compensating commit
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 404
    # the compensating commit is journaled with the artifact op on both sides
    hist = client.get(papi("/commits")).json()["commits"]
    assert hist[0]["rev"] == rev_after_commit + 1 and hist[0]["op_count"] == 1


def test_undo_walks_back_restoring_the_exact_artifact_id(client: TestClient) -> None:
    """Two undoable batches: undoing the delete must reinstate the artifact
    under its ORIGINAL id (restore mode), and undoing the create after it must
    remove that same row again."""
    aid = _commit_create_snippet(client, "roundtrip")
    tok = _lock(client, aid)
    r = _commit(client, [{"kind": "delete_artifact", "id": aid}], [tok])
    assert r.status_code == 200, r.text
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 404

    assert client.post(papi("/model/undo")).status_code == 200  # recreates, exact id
    got = client.get(papi(f"/artifacts/{aid}"))
    assert got.status_code == 200, got.text
    assert got.json()["name"] == "roundtrip"
    assert got.json()["payload"]["code"] == SNIP["code"]

    assert client.post(papi("/model/undo")).status_code == 200  # undoes the create
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 404


def test_undo_with_a_mixed_batch_undoes_both_halves(client: TestClient) -> None:
    r = _commit(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_e",
                "type_name": "Node",
                "properties": {},
            },
            {
                "kind": "create_artifact",
                "temp_id": "tmp_a",
                "artifact_kind": "code_snippet",
                "name": "mixed",
                "payload": SNIP,
            },
        ],
        [],
    )
    assert r.status_code == 200, r.text
    aid = r.json()["id_map"]["tmp_a"]
    assert _summary(client)["element_count"] == 1
    assert client.post(papi("/model/undo")).status_code == 200
    assert _summary(client)["element_count"] == 0
    assert client.get(papi(f"/artifacts/{aid}")).status_code == 404


def test_failed_artifact_replay_restores_model_and_op_log(client: TestClient) -> None:
    """A peer removed the artifact out from under the undo, so the artifact
    half 422s AFTER the model half already applied: the element must come back
    and the popped batch must be pushed back onto the undo history."""
    r = _commit(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_e",
                "type_name": "Node",
                "properties": {},
            },
            {
                "kind": "create_artifact",
                "temp_id": "tmp_a",
                "artifact_kind": "code_snippet",
                "name": "vanishing",
                "payload": SNIP,
            },
        ],
        [],
    )
    assert r.status_code == 200, r.text
    aid = r.json()["id_map"]["tmp_a"]
    rev_after_commit = _rev(client)
    assert client.delete(papi(f"/artifacts/{aid}")).status_code == 204

    r = client.post(papi("/model/undo"))
    assert r.status_code == 422, r.text
    summary = _summary(client)
    assert summary["element_count"] == 1  # model half rolled back
    assert summary["model_rev"] == rev_after_commit  # rev did not move
    assert summary["undo_depth"] == 1  # batch pushed back onto the op log


def test_undo_of_an_update_restores_prior_name_and_payload(client: TestClient) -> None:
    """update_artifact is the only op shape whose inverse carries FULL prior
    state, so the undo must bring back the pre-commit name AND payload."""
    aid = _commit_create_snippet(client, "before")
    tok = _lock(client, aid, intent="edit")
    r = _commit(
        client,
        [
            {
                "kind": "update_artifact",
                "id": aid,
                "name": "after",
                "payload": {**SNIP, "code": "def value(el):\n    return 2\n"},
            }
        ],
        [tok],
    )
    assert r.status_code == 200, r.text
    got = client.get(papi(f"/artifacts/{aid}")).json()
    assert got["name"] == "after" and got["payload"]["code"].endswith("return 2\n")

    assert client.post(papi("/model/undo")).status_code == 200
    got = client.get(papi(f"/artifacts/{aid}")).json()
    assert got["name"] == "before"
    assert got["payload"]["code"] == SNIP["code"]


def test_undo_broadcasts_artifact_events(client: TestClient) -> None:
    aid = _commit_create_snippet(client, "feed-me")
    with client.websocket_connect(feed_url()) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        assert client.post(papi("/model/undo")).status_code == 200
        evt = _receive_artifact_event(ws)  # skips the own-presence join
    assert evt["action"] == "deleted"
    assert evt["artifact"]["id"] == aid


def test_revert_across_artifact_commit_409(client: TestClient) -> None:
    base = _rev(client)
    _commit_create_snippet(client, "s-revert")
    artifact_rev = _rev(client)
    r = client.post(
        papi("/commits/revert"),
        json={"target_rev": base, "base_rev": artifact_rev},
    )
    assert r.status_code == 409
    assert "artifact" in r.json()["detail"]
    assert r.json()["artifact_commit_rev"] == artifact_rev
    assert _rev(client) == artifact_rev  # nothing moved
