"""View ops through the lock-verified commit flow: lease enforcement,
journaling, view_rev lockstep, auto-created views, mixed-batch atomicity
(the view half rolls back when the model half hard-fails), preview dryness,
and the feed scope."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, feed_url, papi, seed_default_project

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str) -> None:
    """Mirrors the helper of the same name in test_commits_artifact_ops.py /
    test_undo_view_ops.py."""
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
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()

#: Node + a containment relationship type, matching the pattern
#: test_incremental_invalidation.py's CONTAINMENT_MM uses to provoke a
#: STRUCTURAL "two containment parents" blocker (dangling endpoints would
#: 422 at the mutation boundary instead, before the view half ever applies).
_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    mappings:
      - source: Node
        target: Node
"""


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
    """Build a (possibly nested) folder tree via ``POST /commits`` — the
    commit-flow replacement for the retired ``PUT /view/snapshot`` one-shot
    setup harness these tests used purely to seed named folders with ids.
    *folders* uses the same nested shape the old PUT body did:
    ``[{"name": ..., "folders": [...]}, ...]``. Returns a flat {name: id} map
    (names are unique per test). A single ``root`` lease covers the whole
    batch — ids created earlier in the same batch need no lock to be
    referenced later in it."""
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
    return {op["name"]: id_map[op["temp_id"]] for op in ops}


def test_commit_requires_folder_lease(client: TestClient) -> None:
    fid = _seed_view(client, [{"name": "A"}])["A"]
    ops = [{"kind": "rename_folder", "id": fid, "name": "A2"}]
    r = client.post(
        papi("/commits"),
        json={"base_rev": _rev(client), "ops": ops, "message": "m", "lock_tokens": []},
    )
    assert r.status_code == 409
    assert r.json()["missing"][0]["resource_id"] == f"folder:{fid}"


def test_commit_applies_persists_and_journals(client: TestClient) -> None:
    fid = _seed_view(client, [{"name": "A"}])["A"]
    setup_view_rev = client.get(papi("/view")).json()["view_rev"]
    token = _folder_lease(client, fid)
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "id": fid, "name": "A2"},
        {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": fid, "name": "C"},
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "view edit", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["model_rev"] == base + 1  # any commit bumps the project rev
    assert out["view_rev"] == setup_view_rev + 1  # lockstep with the setup commit
    assert "tmp_c" in out["id_map"]

    # the view head reflects it
    r = client.get(papi("/view"))
    v = r.json()["view"]
    assert v["folders"][0]["name"] == "A2"
    assert v["folders"][0]["folders"][0]["id"] == out["id_map"]["tmp_c"]

    # the journal row spans the family; the diff route can read it later
    r = client.get(papi("/commits"))
    assert r.json()["commits"][0]["op_count"] == 2

    # commit released the lease
    r = client.get(papi("/locks"))
    assert r.json()["leases"] == []


def test_commit_view_ops_without_existing_view_autocreates(client: TestClient) -> None:
    base = _rev(client)
    ops = [{"kind": "create_folder", "temp_id": "tmp_c", "parent_id": "root", "name": "A"}]
    # create_folder under root needs the root-membership lease
    token = _folder_lease(client, "root", intent="edit")
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["view_rev"] == 1
    r = client.get(papi("/view"))
    assert r.json()["view"]["folders"][0]["name"] == "A"


def test_commit_after_view_cleared_hydrates_durable_view_not_an_empty_one(
    client: TestClient,
) -> None:
    """Regression for the artefacts-revamp whole-branch-review Fix 1:
    ``session.view is None`` does NOT mean "this project never had a view" —
    clearing ONLY the in-memory cache (the retired ``DELETE /view`` route's
    old behavior, reproduced directly below now that it's gone) leaves
    ``ViewRow`` (12-ish pre-existing folders in the reviewer's repro, two
    here) untouched. Before the fix, ``create_commit`` treated
    ``session.view is None`` as "auto-create an EMPTY view", so the step 'e'
    unconditional overwrite of ``ViewRow`` with that empty-based result
    durably destroyed every pre-existing folder — the journal describing only
    the unrelated ``create_folder`` that actually ran. The fix is to hydrate
    from the still-live row instead."""
    _seed_view(client, [{"name": "A"}, {"name": "B"}])
    prior_view_rev = client.get(papi("/view")).json()["view_rev"]
    get_session().view = None  # clear ONLY the cache, mirroring DELETE /view
    assert client.get(papi("/view")).json()["view"] is None

    base = _rev(client)
    token = _folder_lease(client, "root", intent="edit")
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [
                {
                    "kind": "create_folder",
                    "temp_id": "tmp_c",
                    "parent_id": "root",
                    "name": "C",
                }
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    # view_rev advances from the PRIOR durable value either way (final-review
    # round 2, Finding D: upsert_single_view finds the row by project_id
    # alone and bumps whatever it finds — an empty auto-create would ALSO
    # have reported prior_view_rev + 1 here, just with the wrong CONTENT).
    # The real differentiator is the folder set asserted below.
    assert r.json()["view_rev"] == prior_view_rev + 1

    out = client.get(papi("/view")).json()
    names = {f["name"] for f in out["view"]["folders"]}
    assert names == {"A", "B", "C"}  # A and B DURABLY survived the round trip
    assert out["view_rev"] == prior_view_rev + 1


def test_mixed_batch_atomicity_view_rolls_back_with_model(client: TestClient) -> None:
    """A structural model blocker rolls back the ALREADY-APPLIED view half."""
    fid = _seed_view(client, [{"name": "A"}])["A"]
    view_before = client.get(papi("/view")).json()
    # two containment-parent elements + a child, so the relationship pair
    # below is a STRUCTURAL "two containment parents" blocker (not a mutation-
    # boundary 422), which is what actually exercises the rollback.
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "p1", "type_name": "Node", "properties": {}},
                {"id": "p2", "type_name": "Node", "properties": {}},
                {"id": "child", "type_name": "Node", "properties": {}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": fid, "mode": "exclusive", "type": "folder"},
                {"resource_id": "p1", "mode": "exclusive"},
                {"resource_id": "p2", "mode": "exclusive"},
                {"resource_id": "child", "mode": "shared"},
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "id": fid, "name": "A2"},
        {
            "kind": "create_relationship",
            "temp_id": "tmp_r1",
            "type_name": "Contains",
            "source_id": "p1",
            "target_id": "child",
            "properties": {},
        },
        {
            "kind": "create_relationship",
            "temp_id": "tmp_r2",
            "type_name": "Contains",
            "source_id": "p2",
            "target_id": "child",
            "properties": {},
        },
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 422, r.text
    assert r.json()["structural_blockers"]
    assert client.get(papi("/view")).json() == view_before
    assert _rev(client) == base


def test_failed_commit_with_no_prior_view_leaves_view_null(client: TestClient) -> None:
    """Regression for final-review Finding 2: a batch that auto-creates an
    empty view (project had none) and then hard-fails on its MODEL half must
    not leave that auto-created empty view behind — GET /view still reports
    ``view: null``, exactly as it did before the request, not a materialized
    empty view with no ViewRow / view_rev to back it."""
    assert client.get(papi("/view")).json()["view"] is None
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "p1", "type_name": "Node", "properties": {}},
                {"id": "p2", "type_name": "Node", "properties": {}},
                {"id": "child", "type_name": "Node", "properties": {}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "root", "mode": "exclusive", "type": "folder"},
                {"resource_id": "p1", "mode": "exclusive"},
                {"resource_id": "p2", "mode": "exclusive"},
                {"resource_id": "child", "mode": "shared"},
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    base = _rev(client)
    ops = [
        # this leg auto-creates the view (there is none yet)...
        {"kind": "create_folder", "temp_id": "tmp_c", "parent_id": "root", "name": "A"},
        # ...and this leg is a STRUCTURAL "two containment parents" blocker,
        # which fails the batch AFTER the view half already applied.
        {
            "kind": "create_relationship",
            "temp_id": "tmp_r1",
            "type_name": "Contains",
            "source_id": "p1",
            "target_id": "child",
            "properties": {},
        },
        {
            "kind": "create_relationship",
            "temp_id": "tmp_r2",
            "type_name": "Contains",
            "source_id": "p2",
            "target_id": "child",
            "properties": {},
        },
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 422, r.text
    assert r.json()["structural_blockers"]
    assert client.get(papi("/view")).json()["view"] is None
    assert _rev(client) == base


def test_preview_validates_view_ops_dry(client: TestClient) -> None:
    fid = _seed_view(client, [{"name": "A"}])["A"]
    view_before = client.get(papi("/view")).json()
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": fid, "name": "A2"}],
        },
    )
    assert r.status_code == 200
    assert client.get(papi("/view")).json() == view_before
    # an impossible view op fails preview with 422
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "id": "missing", "name": "x"}],
        },
    )
    assert r.status_code == 422


def test_commit_event_scope_includes_view(client: TestClient) -> None:
    """View-only batch -> scope == ["view"]; a mixed model+view batch ->
    scope == ["model", "view"]. Mirrors test_commits_artifact_ops.py's
    test_commit_feed_reports_artifact_scope harness."""
    fid = _seed_view(client, [{"name": "A"}])["A"]
    token = _folder_lease(client, fid)
    with client.websocket_connect(feed_url()) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        r = client.post(
            papi("/commits"),
            json={
                "base_rev": _rev(client),
                "ops": [{"kind": "rename_folder", "id": fid, "name": "A2"}],
                "lock_tokens": [token],
            },
        )
        assert r.status_code == 200, r.text
        commit = ws.receive_json()
        while commit["type"] != "commit":  # skip the own-presence join
            commit = ws.receive_json()
        assert commit["scope"] == ["view"]
        assert commit["changed_elements"] == []

        # mixed batch: a model create alongside a view rename
        token2 = _folder_lease(client, fid)
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
                    {"kind": "rename_folder", "id": fid, "name": "A3"},
                ],
                "lock_tokens": [token2],
            },
        )
        assert r.status_code == 200, r.text
        commit2 = ws.receive_json()
        while commit2["type"] != "commit":
            commit2 = ws.receive_json()
        assert commit2["scope"] == ["model", "view"]


def test_delete_folder_commit_requires_lease_on_subtree_child_after_view_cleared(
    client: TestClient,
) -> None:
    """Regression for final-review round 2, Finding A (the create_commit
    half of the ordering hole Fix 1 reopened). create_commit's own
    pre-mutex staleness/conflict derivations, and its lock-verification
    step, used to run BEFORE session.view was resolved — so a
    delete_folder op's lock requirement (required_locks -> folder_subtree)
    degraded to the named folder alone whenever session.view started COLD,
    e.g. right after clearing only the in-memory cache (the retired
    ``DELETE /view`` route's old behavior — reproduced directly below now
    that it's gone) while leaving the durable ViewRow (and D's real child C)
    fully intact.

    The reviewer's verified repro: P leases folder:C (child of D); the
    caller's view cache is cleared; the caller's own POST /locks request for
    a DELETE lease on folder:D ALSO degrades — a separate, out-of-scope blind
    spot in routes/locks.py's expand_targets, which sees the same None view
    at that point — and is granted covering ONLY D, never C. Before this fix,
    create_commit's OWN required_locks call also ran against that same None
    view and agreed there was nothing more to check, so the commit
    succeeded and the real (b3-hydrated) applier cascaded the delete
    through C anyway — silently destroying a folder a peer had checked out.
    After the fix, create_commit resolves the SAME hydrated view before its
    lock derivation runs, independently re-derives the FULL {D, C}
    requirement, finds C's lease missing from what the caller holds, and
    409s instead — leaving D and C durably untouched."""
    ids = _seed_view(client, [{"name": "D", "folders": [{"name": "C"}]}])
    d_id = ids["D"]
    c_id = ids["C"]

    # P checks out C for editing.
    _seed_second_member("user-2", "user2@example.com")
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": c_id, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 200, r.text

    # The caller's cache goes cold; the durable row (D -> C) is untouched.
    # Setting session.view directly mirrors exactly what the retired
    # ``DELETE /view`` route used to do (clear ONLY the in-memory cache)
    # without going through full-session eviction, which P's live lease on
    # C would refuse (evict-with-live-locks guard).
    get_session().view = None
    assert client.get(papi("/view")).json()["view"] is None

    # The caller's own lock request degrades too (session.view is None at
    # this point in routes/locks.py as well — a separate, out-of-scope blind
    # spot) and is granted covering ONLY D, not C. This call succeeding is
    # part of the repro setup, not the thing under test.
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": d_id, "mode": "exclusive", "type": "folder"}],
            "intent": "delete",
        },
    )
    assert r.status_code == 200, r.text
    d_token = r.json()["token"]

    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_folder", "id": d_id}],
            "message": "m",
            "lock_tokens": [d_token],
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "required lock not held"
    assert f"folder:{c_id}" in [m["resource_id"] for m in r.json()["missing"]]

    # nothing was applied: the lock check is the FIRST thing inside the
    # mutex, so nothing ever got a chance to mutate OR persist before it
    # failed. Read the durable row directly (not via evict-then-refetch:
    # both peers still hold live leases at this point, and eviction is a
    # no-op while any lease is live — see SessionRegistry.evict) to prove
    # the ViewRow itself still shows D -> C.
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
