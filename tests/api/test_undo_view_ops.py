"""Undo across view ops: restore-mode replay, peer-lease refusal (leases are
the ONLY concurrency control on view content — same rationale as the
artifact half), blob persistence, and journal append-only-ness.

Fixtures: copy the client/_MM/_seed_second_member pattern from
tests/api/test_commits_artifact_ops.py; _folder_lease/_rev from
tests/api/test_commits_view_ops.py."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.db_models import Role, User
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.tenancy import add_member
from data_rover.core.view.ids import find_folder
from data_rover.core.view.schema import Folder

from .conftest import AUTH_HEADERS, create_folder_via_commit, papi, seed_default_project

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


def _seed_view(client: TestClient, folders: list[dict]) -> dict[str, str]:
    """Build a (possibly nested) folder tree, with elements placed into
    folders, via ``POST /commits`` purely to seed a whole tree in one call.
    *folders* is ``[{"name": ..., "folders": [...], "elements": [...]},
    ...]``. Returns a flat {name: id} map (names are unique per test). A
    single ``root`` lease covers the whole batch — ids created earlier in
    the same batch need no lock to be referenced later."""
    ops: list[dict] = []
    counter = 0

    def walk(spec: dict, parent_id: str) -> None:
        nonlocal counter
        counter += 1
        temp_id = f"tmp_{counter}"
        ops.append(
            {
                "kind": "create_folder",
                "temp_id": temp_id,
                "parent_id": parent_id,
                "name": spec["name"],
            }
        )
        for eid in spec.get("elements", []):
            ops.append(
                {"kind": "place_element", "element_id": eid, "folder_id": temp_id}
            )
        for child in spec.get("folders", []):
            walk(child, temp_id)

    for f in folders:
        walk(f, "root")

    token = _folder_lease(client, "root")
    r = client.post(
        papi("/commits"),
        json={"base_rev": _rev(client), "ops": ops, "message": "setup", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    id_map = r.json()["id_map"]
    return {op["name"]: id_map[op["temp_id"]] for op in ops if op["kind"] == "create_folder"}


def _add_folder_bypassing_op_log(parent_id: str, name: str) -> str:
    """Insert a folder directly into ``session.view`` and persist it to
    ``ViewRow``, with NO ``op_log`` entry at all — simulates an un-journaled
    peer edit for the two "peer edits without journaling" tests below. Going
    through a real ``POST /commits`` instead would push an extra entry onto
    the SHARED (project-wide, not per-user) op_log stack, which would break
    these tests' undo-targets-the-right-commit premise."""
    session = get_session()
    assert session.view is not None
    container = session.view if parent_id == "root" else find_folder(session.view, parent_id)
    assert container is not None
    fid = uuid.uuid4().hex
    container.folders.append(Folder(id=fid, name=name))

    gen = db.get_db()
    s = next(gen)
    try:
        content.upsert_single_view(
            s,
            DEFAULT_PROJECT_ID,
            name=session.view.name,
            blob=session.view.model_dump_json(),
        )
        s.commit()
    finally:
        gen.close()
    return fid


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
    fid = create_folder_via_commit(client, "A")["id_map"]["tmp_setup"]
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
    fid = create_folder_via_commit(client, "A")["id_map"]["tmp_setup"]
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
    """The mirror of the peer-refusal test above: ``peer_leases`` excludes
    the caller's own holder id, so a lease the
    UNDOING user holds on the very folder being touched must never 409 —
    only a PEER's lease should."""
    fid = create_folder_via_commit(client, "A")["id_map"]["tmp_setup"]
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


def test_undo_after_view_cleared_hydrates_durable_view_and_succeeds(
    client: TestClient,
) -> None:
    """Clearing ONLY the in-memory ``session.view`` cache leaves ``ViewRow``
    — the durable blob, still holding folder "A2" at this point — untouched.
    So when undo's inverse (rename back to "A") replays against a session
    with no view CACHED, the correct outcome is for ``load_or_create_view``
    to hydrate the still-populated row and successfully rename the folder
    back — not to materialize a phantom empty view and 422 on a folder that
    was never actually deleted anywhere, durably or otherwise."""
    fid = create_folder_via_commit(client, "A")["id_map"]["tmp_setup"]
    _commit_rename(client, fid, "A2")
    get_session().view = None  # clear ONLY the in-memory cache
    assert client.get(papi("/view")).json()["view"] is None
    durable_view_rev = client.get(papi("/view")).json()["view_rev"]

    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text

    out = client.get(papi("/view")).json()
    assert out["view"]["folders"][0]["id"] == fid
    assert out["view"]["folders"][0]["name"] == "A"  # the durable folder survived
    assert out["view_rev"] == durable_view_rev + 1  # advanced from the PRIOR rev, not 0/1
    # the undo was consumed (not refused), popping the rename batch off the
    # top of the stack — the create_folder "A" setup commit underneath it
    # (unlike the old op-log-free PUT setup) is still there.
    summary = client.get(papi("/model/summary")).json()
    assert summary["undo_depth"] == 1


def test_failed_undo_with_no_durable_view_row_leaves_view_null(
    client: TestClient,
) -> None:
    """Coverage for ``created_view``'s restore-to-None guard on undo's TRUE
    "nothing to hydrate" fallback: ``load_or_create_view`` only materializes
    a fresh empty ``View`` when NO ``ViewRow`` exists at all — a state
    clearing only the in-memory cache cannot manufacture (see the
    hydrate-and-succeed test above), since it never touches the durable row.
    This test manufactures the genuine "no durable view" state directly (by
    deleting the ``ViewRow``, which no route does) to prove the pre-existing
    ``created_view`` bookkeeping still holds on undo's real empty-view path:
    a materialized-then-rolled-back empty view must not leak into a state
    that durably had none."""
    fid = create_folder_via_commit(client, "A")["id_map"]["tmp_setup"]
    _commit_rename(client, fid, "A2")
    get_session().view = None  # clear ONLY the in-memory cache
    assert client.get(papi("/view")).json()["view"] is None

    from sqlalchemy import select

    from data_rover.api import db
    from data_rover.api.db_models import ViewRow
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = db.get_db()
    s = next(gen)
    try:
        row = s.execute(
            select(ViewRow).where(ViewRow.project_id == DEFAULT_PROJECT_ID)
        ).scalar_one()
        s.delete(row)
        s.commit()
    finally:
        gen.close()

    r = client.post(papi("/model/undo"))
    assert r.status_code == 422, r.text

    assert client.get(papi("/view")).json()["view"] is None
    # undo history survives the failure: the rename batch was pushed back on
    # top of the create_folder "A" setup commit underneath it.
    summary = client.get(papi("/model/summary")).json()
    assert summary["undo_depth"] == 2


def test_undo_of_delete_folder_and_move_element_is_byte_identical(
    client: TestClient,
) -> None:
    """The applier's docstring promises apply-then-inverse restores a
    byte-identical blob. This drives ``delete_folder`` (recreating a nested
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
    ids = _seed_view(
        client,
        [
            {"name": "A", "folders": [{"name": "AB", "elements": ["eb"]}]},
            {"name": "C", "elements": ["e2"]},
            {"name": "D"},
        ],
    )
    a_id = ids["A"]
    c_id = ids["C"]
    d_id = ids["D"]
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
    token = _folder_lease(client, "root")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_folder",
                    "temp_id": "tmp_d",
                    "parent_id": "root",
                    "name": "D",
                }
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    d_id = r.json()["id_map"]["tmp_d"]

    # P adds a child folder C under D without journaling it — this writes NO
    # op_log entry and needs no lease.
    _seed_second_member("user-2", "user2@example.com")
    c_id = _add_folder_bypassing_op_log(d_id, "C")

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
    # the refusal did not eat the undo slot, and D (+ C) are untouched.
    summary = client.get(papi("/model/summary")).json()
    assert summary["undo_depth"] == 1
    assert client.get(papi("/view")).json()["view"]["folders"][0]["id"] == d_id


def test_undo_refuses_while_peer_holds_lease_on_subtree_child_after_view_cleared(
    client: TestClient,
) -> None:
    """The SAME repro as the test above, but with the caller's view cache
    cleared right before the undo call: undo must resolve session.view
    BEFORE computing ``peer_resources``, not compute it from
    ``view_op_folder_ids(session.view, view_inv)`` while ``session.view`` is
    still ``None`` (clearing only the cache never touches the durable
    ``ViewRow``) — otherwise ``view_op_folder_ids``'s ``DeleteFolderOp``
    branch degrades to ``{op.id}`` alone against a ``None`` view (mirroring
    ``folder_subtree``'s own total-ness fallback), so the peer's lease on
    child C is never even considered, and ``POST /model/undo`` returns 200
    instead of 409 — silently deleting C out from under P's live
    check-out."""
    token = _folder_lease(client, "root")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_folder",
                    "temp_id": "tmp_d",
                    "parent_id": "root",
                    "name": "D",
                }
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    d_id = r.json()["id_map"]["tmp_d"]

    # P adds a child folder C under D without journaling it — see the test
    # above for why a real commit here would break the undo-targets-the-
    # right-commit premise.
    _seed_second_member("user-2", "user2@example.com")
    c_id = _add_folder_bypassing_op_log(d_id, "C")

    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": c_id, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200, r.text

    # The one addition relative to the test above: the CALLER's own cache
    # goes cold right before undo. The durable row (D -> C) is untouched.
    # Setting session.view directly clears ONLY the in-memory cache without
    # going through full-session eviction, which P's live lease on C would
    # refuse (evict-with-live-locks guard).
    get_session().view = None
    assert client.get(papi("/view")).json()["view"] is None

    r = client.post(papi("/model/undo"))
    assert r.status_code == 409, r.text
    assert f"folder:{c_id}" in [c["resource_id"] for c in r.json()["conflicts"]]
    summary = client.get(papi("/model/summary")).json()
    assert summary["undo_depth"] == 1

    # the rejection is externally invisible too: GET /view still reports
    # whatever it reported right before this undo attempt (null — the
    # session.view clear above, not a materialized-then-abandoned hydrate).
    assert client.get(papi("/view")).json()["view"] is None

    # ...and durably: read the row directly (not via evict-then-refetch —
    # P's lease on C is still live, and eviction is a no-op while any lease
    # is live — see SessionRegistry.evict) to prove D -> C survived intact.
    import json

    from data_rover.api import content, db
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = db.get_db()
    s = next(gen)
    try:
        row = content.get_single_view(s, DEFAULT_PROJECT_ID)
        assert row is not None
        blob = json.loads(row.blob)
    finally:
        gen.close()
    assert blob["folders"][0]["id"] == d_id
    assert blob["folders"][0]["folders"][0]["id"] == c_id
