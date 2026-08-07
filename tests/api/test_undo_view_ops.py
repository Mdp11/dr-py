"""Undo across view ops: restore-mode replay, peer-lease refusal (leases are
the ONLY concurrency control on view content — same rationale as the
artifact half), blob persistence, and journal append-only-ness.

Fixtures: copy the client/_MM/_seed_second_member pattern from
tests/api/test_commits_artifact_ops.py; _folder_lease/_rev from
tests/api/test_commits_view_ops.py."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str) -> None:
    """Mirrors the helper of the same name in test_commits_artifact_ops.py."""
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


def _folder_lease(client: TestClient, fid: str, intent: str = "edit") -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": intent,
        },
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _rev(client: TestClient) -> int:
    r = client.get(papi("/open"))
    rev: int = r.json()["model_rev"]
    return rev


def _commit_rename(client: TestClient, fid: str, name: str) -> None:
    token = _folder_lease(client, fid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": fid, "name": name}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def test_undo_restores_view_and_bumps_revs(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    base = _rev(client)
    view_rev = client.get(papi("/view")).json()["view_rev"]

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base + 1  # append-only: rev moves FORWARD

    out = client.get(papi("/view")).json()
    assert out["view"]["folders"][0]["name"] == "A"
    assert out["view_rev"] == view_rev + 1  # the compensating edit bumps it

    # the compensating commit is journaled (newest row carries the inverse op)
    r = client.get(papi("/commits"))
    assert r.json()["commits"][0]["op_count"] == 1


def test_undo_refuses_while_peer_holds_folder_lease(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    _seed_second_member("user-2", "user2@example.com")
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200
    r = client.post(papi("/model/undo"))
    assert r.status_code == 409
    assert f"folder:{fid}" in [c["resource_id"] for c in r.json()["conflicts"]]
    # the refusal did not eat the undo slot: after the peer releases, undo works
    r = client.get(papi("/locks"))
    peer_lease = next(le for le in r.json()["leases"] if le["resource_id"] == f"folder:{fid}")
    assert peer_lease["holder"] == "user-2"


def test_undo_not_blocked_by_callers_own_folder_lease(client: TestClient) -> None:
    """The mirror of the peer-refusal test above (final-review Finding 4):
    ``peer_leases`` excludes the caller's own holder id, so a lease the
    UNDOING user holds on the very folder being touched must never 409 —
    only a PEER's lease should."""
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    # the rename's own lease was released by the commit; re-acquire a fresh
    # one on the same folder, held by the CALLER of the undo below.
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert client.get(papi("/view")).json()["view"]["folders"][0]["name"] == "A"


def test_failed_undo_after_view_cleared_leaves_view_null(client: TestClient) -> None:
    """Regression for final-review Finding 1: the reviewer's exact repro.
    ``DELETE /view`` is the existing unlocked legacy route that sets
    ``session.view = None`` with no persistence and no lease check (a known,
    out-of-scope pre-existing quirk); undo's own defensive "recreate an empty
    View" fallback (for the unrelated evicted+contentless-resurrection case)
    must not leak a materialized empty View into that state when the replay
    then 422s on the folder DELETE /view just erased — GET /view must still
    report ``view: None`` afterwards, byte-identical to before the failed
    undo, not a phantom empty view with no ViewRow/view_rev to back it."""
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    _commit_rename(client, fid, "A2")
    assert client.delete(papi("/view")).status_code == 204
    assert client.get(papi("/view")).json()["view"] is None

    r = client.post(papi("/model/undo"))
    assert r.status_code == 422, r.text

    assert client.get(papi("/view")).json()["view"] is None
    # undo history survives the failure: the batch was pushed back
    summary = client.get(papi("/model/summary")).json()
    assert summary["undo_depth"] == 1


def test_undo_of_delete_folder_and_move_element_is_byte_identical(
    client: TestClient,
) -> None:
    """Regression for final-review Finding 3: the applier's docstring
    promises apply-then-inverse restores a byte-identical blob, but the
    original suite only exercised ``rename_folder`` and only spot-checked one
    field. This drives ``delete_folder`` (recreating a subtree with a nested
    folder + placed element — the multi-op ``inverse_units`` shape) AND
    ``move_element`` (a two-endpoint op) through one commit, then asserts the
    FULL view blob returned by ``GET /view`` after undo deep-equals the one
    captured before the commit ever ran."""
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "eb", "type_name": "Node", "properties": {}},
                {"id": "e2", "type_name": "Node", "properties": {}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    r = client.put(
        papi("/view/snapshot"),
        json={
            "name": "v",
            "folders": [
                {"name": "A", "folders": [{"name": "AB", "elements": ["eb"]}]},
                {"name": "C", "elements": ["e2"]},
                {"name": "D"},
            ],
        },
    )
    assert r.status_code == 200, r.text
    folders = r.json()["view"]["folders"]
    a_id = folders[0]["id"]
    c_id = folders[1]["id"]
    d_id = folders[2]["id"]
    before = client.get(papi("/view")).json()["view"]

    delete_token = _folder_lease(client, a_id, intent="delete")
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": c_id, "mode": "exclusive", "type": "folder"},
                {"resource_id": d_id, "mode": "exclusive", "type": "folder"},
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    move_token = r.json()["token"]
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "delete_folder", "id": a_id},
                {
                    "kind": "move_element",
                    "element_id": "e2",
                    "from_folder_id": c_id,
                    "to_folder_id": d_id,
                    "index": 0,
                },
            ],
            "message": "m",
            "lock_tokens": [delete_token, move_token],
        },
    )
    assert r.status_code == 200, r.text
    mid = client.get(papi("/view")).json()["view"]
    assert [f["name"] for f in mid["folders"]] == ["C", "D"]  # A gone
    assert mid["folders"][1]["elements"] == ["e2"]  # moved into D

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text

    after = client.get(papi("/view")).json()["view"]
    assert after == before  # deep equality: the FULL tree, not a spot field
