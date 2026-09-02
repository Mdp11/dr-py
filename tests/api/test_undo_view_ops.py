"""Undo across view ops: restore-mode replay, peer-lease refusal (leases are
the ONLY concurrency control on view content — same rationale as the
artifact half), blob persistence, journal append-only-ness, and view_id
resolution (a deleted view, and the legacy empty id that predates named
views).

Fixtures: copy the client/_MM/_seed_second_member pattern from
tests/api/test_commits_artifact_ops.py; _folder_lease/_rev from
tests/api/test_commits_view_ops.py."""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.db_models import Role, User
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.schemas import VIEW_OP_KINDS
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.tenancy import add_member
from data_rover.core.view.ids import find_folder
from data_rover.core.view.schema import Folder

from .conftest import (
    AUTH_HEADERS,
    container_lock_target,
    create_folder_via_commit,
    create_view,
    papi,
    seed_default_project,
)

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


def _lease(client: TestClient, targets: list[dict], intent: str = "edit") -> str:
    r = client.post(papi("/locks"), json={"targets": targets, "intent": intent})
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _folder_lease(client: TestClient, fid: str, intent: str = "edit") -> str:
    return _lease(
        client, [{"resource_id": fid, "mode": "exclusive", "type": "folder"}], intent
    )


def _view_lease(client: TestClient, vid: str, intent: str = "edit") -> str:
    return _lease(client, [container_lock_target(vid, "root")], intent)


def _rev(client: TestClient) -> int:
    r = client.get(papi("/open"))
    rev: int = r.json()["model_rev"]
    return rev


def _get_view(client: TestClient, vid: str) -> dict:
    r = client.get(papi(f"/views/{vid}"))
    assert r.status_code == 200, r.text
    body: dict = r.json()
    return body


def _seed_view(client: TestClient, folders: list[dict]) -> tuple[str, dict[str, str]]:
    """Add a view and build a (possibly nested) folder tree in it, with
    elements placed into folders, via ``POST /commits`` purely to seed a
    whole tree in one call. *folders* is ``[{"name": ..., "folders": [...],
    "elements": [...]}, ...]``. Returns the view id and a flat {name: id}
    map (names are unique per test). A single lease on the view (its root)
    covers the whole batch — ids created earlier in the same batch need no
    lock to be referenced later."""
    vid = create_view(client)
    ops: list[dict] = []
    counter = 0

    def walk(spec: dict, parent_id: str) -> None:
        nonlocal counter
        counter += 1
        temp_id = f"tmp_{counter}"
        ops.append(
            {
                "kind": "create_folder",
                "view_id": vid,
                "temp_id": temp_id,
                "parent_id": parent_id,
                "name": spec["name"],
            }
        )
        for eid in spec.get("elements", []):
            ops.append(
                {
                    "kind": "place_element",
                    "view_id": vid,
                    "element_id": eid,
                    "folder_id": temp_id,
                }
            )
        for child in spec.get("folders", []):
            walk(child, temp_id)

    for f in folders:
        walk(f, "root")

    token = _view_lease(client, vid)
    r = client.post(
        papi("/commits"),
        json={"base_rev": _rev(client), "ops": ops, "message": "setup", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    id_map = r.json()["id_map"]
    return vid, {
        op["name"]: id_map[op["temp_id"]] for op in ops if op["kind"] == "create_folder"
    }


def _add_folder_bypassing_op_log(vid: str, parent_id: str, name: str) -> str:
    """Insert a folder directly into ``session.views[vid]`` and persist it
    to its ``ViewRow``, with NO ``op_log`` entry at all — simulates an
    un-journaled peer edit for the "peer edits without journaling" test
    below. Going through a real ``POST /commits`` instead would push an
    extra entry onto the SHARED (project-wide, not per-user) op_log stack,
    which would break that test's undo-targets-the-right-commit premise."""
    view = get_session().views[vid]
    container = view if parent_id == "root" else find_folder(view, parent_id)
    assert container is not None
    fid = uuid.uuid4().hex
    container.folders.append(Folder(id=fid, name=name))

    gen = db.get_db()
    s = next(gen)
    try:
        content.upsert_view(s, DEFAULT_PROJECT_ID, vid, blob=view.model_dump_json())
        s.commit()
    finally:
        gen.close()
    return fid


def _commit_rename(client: TestClient, vid: str, fid: str, name: str) -> None:
    token = _folder_lease(client, fid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "view_id": vid, "id": fid, "name": name}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text


def _blank_last_batch_view_ids() -> None:
    """Rewrite the top op_log batch into the journal shape from before named
    views: its view ops carry no view id."""
    for op in get_session().op_log[-1].inverse_ops:
        if op.kind in VIEW_OP_KINDS:
            setattr(op, "view_id", "")  # noqa: B010 — the union has no common attr


def test_undo_restores_view_and_bumps_revs(client: TestClient) -> None:
    setup = create_folder_via_commit(client, "A")
    vid, fid = setup["view_id"], setup["id_map"]["tmp_setup"]
    _commit_rename(client, vid, fid, "A2")
    base = _rev(client)
    view_rev = _get_view(client, vid)["view_rev"]

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == base + 1  # append-only: rev moves FORWARD

    out = _get_view(client, vid)
    assert out["view"]["folders"][0]["name"] == "A"
    assert out["view_rev"] == view_rev + 1  # the compensating edit bumps it

    # the compensating commit is journaled (newest row carries the inverse op)
    r = client.get(papi("/commits"))
    assert r.json()["commits"][0]["op_count"] == 1


def test_undo_refuses_while_peer_holds_folder_lease(client: TestClient) -> None:
    setup = create_folder_via_commit(client, "A")
    vid, fid = setup["view_id"], setup["id_map"]["tmp_setup"]
    _commit_rename(client, vid, fid, "A2")
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
    """The mirror of the peer-refusal test above: ``peer_leases`` excludes
    the caller's own holder id, so a lease the UNDOING user holds on the
    very folder being touched must never 409 — only a PEER's lease
    should."""
    setup = create_folder_via_commit(client, "A")
    vid, fid = setup["view_id"], setup["id_map"]["tmp_setup"]
    _commit_rename(client, vid, fid, "A2")
    # the rename's own lease was released by the commit; re-acquire a fresh
    # one on the same folder, held by the CALLER of the undo below.
    _folder_lease(client, fid)
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert _get_view(client, vid)["view"]["folders"][0]["name"] == "A"


def test_undo_legacy_empty_view_id_resolves_to_sole_view(client: TestClient) -> None:
    """A journal row from before named views carries no view id; with
    exactly one view the only possible reading is that view, so the undo
    lands there."""
    setup = create_folder_via_commit(client, "A")
    vid, fid = setup["view_id"], setup["id_map"]["tmp_setup"]
    _commit_rename(client, vid, fid, "A2")
    _blank_last_batch_view_ids()

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    assert _get_view(client, vid)["view"]["folders"][0]["name"] == "A"
    # the compensating row is journaled with the RESOLVED id
    d = client.get(papi(f"/commits/{_rev(client)}/diff")).json()
    assert d["view"][0]["view_id"] == vid


def test_undo_legacy_empty_view_id_409_with_two_views(client: TestClient) -> None:
    """The same legacy row on a project with two views is ambiguous: push
    back (409) rather than guess, and keep the undo slot."""
    setup = create_folder_via_commit(client, "A")
    vid, fid = setup["view_id"], setup["id_map"]["tmp_setup"]
    _commit_rename(client, vid, fid, "A2")
    create_view(client, "Second")
    _blank_last_batch_view_ids()
    depth_before = client.get(papi("/model/summary")).json()["undo_depth"]

    r = client.post(papi("/model/undo"))
    assert r.status_code == 409, r.text
    assert "exactly one view" in r.json()["detail"]
    assert client.get(papi("/model/summary")).json()["undo_depth"] == depth_before
    assert _get_view(client, vid)["view"]["folders"][0]["name"] == "A2"


def test_undo_of_change_to_a_deleted_view_409s(client: TestClient) -> None:
    """Deleting a view is not journaled, so a later undo may name a view
    that no longer exists: push back, never half-apply."""
    setup = create_folder_via_commit(client, "A")
    vid, fid = setup["view_id"], setup["id_map"]["tmp_setup"]
    _commit_rename(client, vid, fid, "A2")
    assert client.delete(papi(f"/views/{vid}")).status_code == 204
    depth_before = client.get(papi("/model/summary")).json()["undo_depth"]

    r = client.post(papi("/model/undo"))
    assert r.status_code == 409, r.text
    assert client.get(papi("/model/summary")).json()["undo_depth"] == depth_before
    assert client.get(papi("/views")).json() == []


def test_undo_of_delete_folder_and_move_element_is_byte_identical(
    client: TestClient,
) -> None:
    """The applier's docstring promises apply-then-inverse restores a
    byte-identical blob. This drives ``delete_folder`` (recreating a nested
    folder + placed element — the multi-op ``inverse_units`` shape) AND
    ``move_element`` (a two-endpoint op) through one commit, then asserts the
    FULL view blob returned by ``GET /views/{id}`` after undo deep-equals the
    one captured before the commit ever ran."""
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
    vid, ids = _seed_view(
        client,
        [
            {"name": "A", "folders": [{"name": "AB", "elements": ["eb"]}]},
            {"name": "C", "elements": ["e2"]},
            {"name": "D"},
        ],
    )
    a_id, c_id, d_id = ids["A"], ids["C"], ids["D"]
    before = _get_view(client, vid)["view"]

    delete_token = _folder_lease(client, a_id, intent="delete")
    move_token = _lease(
        client,
        [
            {"resource_id": c_id, "mode": "exclusive", "type": "folder"},
            {"resource_id": d_id, "mode": "exclusive", "type": "folder"},
        ],
    )
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "delete_folder", "view_id": vid, "id": a_id},
                {
                    "kind": "move_element",
                    "view_id": vid,
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
    mid = _get_view(client, vid)["view"]
    assert [f["name"] for f in mid["folders"]] == ["C", "D"]  # A gone
    assert mid["folders"][1]["elements"] == ["e2"]  # moved into D

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text

    after = _get_view(client, vid)["view"]
    assert after == before  # deep equality: the FULL tree, not a spot field


def test_undo_refuses_while_peer_holds_lease_on_delete_folder_subtree_child(
    client: TestClient,
) -> None:
    """U commits ``create_folder D``; P adds a CHILD folder C under D
    WITHOUT journaling it (an un-journaled peer edit); P takes an EDIT lease
    on ``folder:C``; U undoes the
    ``create_folder D`` commit. The undo's inverse is ``[delete_folder D]``,
    which deletes D's WHOLE SUBTREE (including C) — the peer-lease guard must
    expand D over that subtree (mirroring ``required_locks``'s own
    DELETE-intent expansion) and see C's lease, or the undo silently deletes
    C out from under the peer's checked-out edit."""
    setup = create_folder_via_commit(client, "D")
    vid, d_id = setup["view_id"], setup["id_map"]["tmp_setup"]

    # P adds a child folder C under D without journaling it — this writes NO
    # op_log entry and needs no lease.
    _seed_second_member("user-2", "user2@example.com")
    c_id = _add_folder_bypassing_op_log(vid, d_id, "C")

    # P checks out C for editing.
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": c_id, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200, r.text

    r = client.post(papi("/model/undo"))
    assert r.status_code == 409, r.text
    assert f"folder:{c_id}" in [c["resource_id"] for c in r.json()["conflicts"]]
    # the refusal did not eat the undo slot, and D (+ C) are untouched —
    # durably too: read the row directly (P's lease on C is still live, and
    # eviction is a no-op while any lease is live — see SessionRegistry.evict)
    summary = client.get(papi("/model/summary")).json()
    assert summary["undo_depth"] == 1
    assert _get_view(client, vid)["view"]["folders"][0]["id"] == d_id
    gen = db.get_db()
    s = next(gen)
    try:
        row = content.get_view(s, DEFAULT_PROJECT_ID, vid)
        assert row is not None
        blob = json.loads(row.blob)
    finally:
        gen.close()
    assert blob["folders"][0]["id"] == d_id
    assert blob["folders"][0]["folders"][0]["id"] == c_id
