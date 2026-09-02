"""View ops through the lock-verified commit flow: lease enforcement,
journaling, per-view ``view_revs`` lockstep, view_id resolution, mixed-batch
atomicity (the view half rolls back when the model half hard-fails), preview
dryness, and the feed scope."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import (
    AUTH_HEADERS,
    container_lock_target,
    create_view,
    feed_url,
    papi,
    seed_default_project,
)

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

#: three Nodes whose two Contains relationships below form a structural
#: "two containment parents" blocker
_TWO_PARENTS_MODEL = {
    "elements": [
        {"id": "p1", "type_name": "Node", "properties": {}},
        {"id": "p2", "type_name": "Node", "properties": {}},
        {"id": "child", "type_name": "Node", "properties": {}},
    ],
    "relationships": [],
}
_TWO_PARENTS_OPS = [
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
_TWO_PARENTS_TARGETS = [
    {"resource_id": "p1", "mode": "exclusive"},
    {"resource_id": "p2", "mode": "exclusive"},
    {"resource_id": "child", "mode": "shared"},
]


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


def _seed_view(
    client: TestClient, folders: list[dict], *, name: str = "Default"
) -> tuple[str, dict[str, str]]:
    """Add a view named *name* and build a (possibly nested) folder tree in
    it via ``POST /commits`` purely to seed named folders with ids. *folders*
    is ``[{"name": ..., "folders": [...]}, ...]``. Returns the view id and a
    flat {name: id} map (names are unique per test). A single lease on the
    view (its root) covers the whole batch — ids created earlier in the same
    batch need no lock to be referenced later in it."""
    vid = create_view(client, name)
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
    return vid, {op["name"]: id_map[op["temp_id"]] for op in ops}


def test_commit_requires_folder_lease(client: TestClient) -> None:
    vid, ids = _seed_view(client, [{"name": "A"}])
    fid = ids["A"]
    ops = [{"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A2"}]
    r = client.post(
        papi("/commits"),
        json={"base_rev": _rev(client), "ops": ops, "message": "m", "lock_tokens": []},
    )
    assert r.status_code == 409
    assert r.json()["missing"][0]["resource_id"] == f"folder:{fid}"


def test_commit_applies_persists_and_journals(client: TestClient) -> None:
    vid, ids = _seed_view(client, [{"name": "A"}])
    fid = ids["A"]
    setup_view_rev = _get_view(client, vid)["view_rev"]
    token = _folder_lease(client, fid)
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A2"},
        {
            "kind": "create_folder",
            "view_id": vid,
            "temp_id": "tmp_c",
            "parent_id": fid,
            "name": "C",
        },
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "view edit", "lock_tokens": [token]},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["model_rev"] == base + 1  # any commit bumps the project rev
    assert out["view_revs"] == {vid: setup_view_rev + 1}  # lockstep with setup
    assert "tmp_c" in out["id_map"]

    # the view head reflects it
    v = _get_view(client, vid)["view"]
    assert v["folders"][0]["name"] == "A2"
    assert v["folders"][0]["folders"][0]["id"] == out["id_map"]["tmp_c"]

    # the journal row spans the family; the diff route can read it later
    r = client.get(papi("/commits"))
    assert r.json()["commits"][0]["op_count"] == 2

    # commit released the lease
    r = client.get(papi("/locks"))
    assert r.json()["leases"] == []


def test_commit_rejects_missing_or_unknown_view_id(client: TestClient) -> None:
    """A view op must name a view that exists: there is no auto-create, and
    the resolution happens before lock verification, so a bad id is a 422
    regardless of what the caller holds."""
    base = _rev(client)
    for view_id in ("", "nope"):
        op = {
            "kind": "create_folder",
            "temp_id": "tmp_c",
            "parent_id": "root",
            "name": "A",
        }
        if view_id:
            op["view_id"] = view_id
        r = client.post(
            papi("/commits"),
            json={"base_rev": base, "ops": [op], "message": "m", "lock_tokens": []},
        )
        assert r.status_code == 422, r.text
        assert "view" in r.json()["detail"]
    assert client.get(papi("/views")).json() == []
    assert _rev(client) == base


def test_commit_two_views_persist_independently(client: TestClient) -> None:
    """One batch may edit several views; each touched view gets its own blob
    write + ``view_rev`` bump, and an untouched view's rev stays put."""
    a = create_view(client, "A")
    b = create_view(client, "B")
    token = _lease(client, [container_lock_target(a, "root"), container_lock_target(b, "root")])
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "create_folder", "view_id": a, "temp_id": "tmp_a", "parent_id": "root", "name": "FA"},
                {"kind": "create_folder", "view_id": b, "temp_id": "tmp_b", "parent_id": "root", "name": "FB"},
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["view_revs"] == {a: 1, b: 1}
    assert [f["name"] for f in _get_view(client, a)["view"]["folders"]] == ["FA"]
    assert [f["name"] for f in _get_view(client, b)["view"]["folders"]] == ["FB"]

    token = _view_lease(client, a)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "create_folder", "view_id": a, "temp_id": "tmp_a2", "parent_id": "root", "name": "FA2"},
            ],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["view_revs"] == {a: 2}
    assert {v["name"]: v["view_rev"] for v in client.get(papi("/views")).json()} == {
        "A": 2,
        "B": 1,
    }


def test_mixed_batch_atomicity_view_rolls_back_with_model(client: TestClient) -> None:
    """A structural model blocker rolls back the ALREADY-APPLIED view half."""
    vid, ids = _seed_view(client, [{"name": "A"}])
    fid = ids["A"]
    view_before = _get_view(client, vid)
    # two containment-parent elements + a child, so the relationship pair
    # below is a STRUCTURAL "two containment parents" blocker (not a mutation-
    # boundary 422), which is what actually exercises the rollback.
    r = client.post(papi("/model"), json=_TWO_PARENTS_MODEL)
    assert r.status_code == 200, r.text
    token = _lease(
        client,
        [{"resource_id": fid, "mode": "exclusive", "type": "folder"}, *_TWO_PARENTS_TARGETS],
    )
    base = _rev(client)
    ops = [
        {"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A2"},
        *_TWO_PARENTS_OPS,
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 422, r.text
    assert r.json()["structural_blockers"]
    assert _get_view(client, vid) == view_before
    assert _rev(client) == base


def test_failed_commit_leaves_every_view_untouched(client: TestClient) -> None:
    """A batch editing TWO views that then hard-fails on its model half
    rolls both view groups back — the unwind ledger holds one entry per
    applied group, newest first."""
    a = create_view(client, "A")
    b = create_view(client, "B")
    r = client.post(papi("/model"), json=_TWO_PARENTS_MODEL)
    assert r.status_code == 200, r.text
    token = _lease(
        client,
        [
            container_lock_target(a, "root"),
            container_lock_target(b, "root"),
            *_TWO_PARENTS_TARGETS,
        ],
    )
    base = _rev(client)
    ops = [
        {"kind": "create_folder", "view_id": a, "temp_id": "tmp_a", "parent_id": "root", "name": "FA"},
        {"kind": "create_folder", "view_id": b, "temp_id": "tmp_b", "parent_id": "root", "name": "FB"},
        *_TWO_PARENTS_OPS,
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 422, r.text
    assert r.json()["structural_blockers"]
    for vid in (a, b):
        out = _get_view(client, vid)
        assert out["view"]["folders"] == [] and out["view_rev"] == 0
    assert _rev(client) == base


def test_preview_validates_view_ops_dry(client: TestClient) -> None:
    vid, ids = _seed_view(client, [{"name": "A"}])
    fid = ids["A"]
    view_before = _get_view(client, vid)
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A2"}],
        },
    )
    assert r.status_code == 200
    assert _get_view(client, vid) == view_before
    # an impossible view op fails preview with 422 — so does an unknown view
    for op in (
        {"kind": "rename_folder", "view_id": vid, "id": "missing", "name": "x"},
        {"kind": "rename_folder", "view_id": "nope", "id": fid, "name": "x"},
    ):
        r = client.post(
            papi("/commits/preview"), json={"base_rev": _rev(client), "ops": [op]}
        )
        assert r.status_code == 422, r.text


def test_commit_event_scope_includes_view(client: TestClient) -> None:
    """View-only batch -> scope == ["view"]; a mixed model+view batch ->
    scope == ["model", "view"]. Mirrors test_commits_artifact_ops.py's
    test_commit_feed_reports_artifact_scope harness."""
    vid, ids = _seed_view(client, [{"name": "A"}])
    fid = ids["A"]
    token = _folder_lease(client, fid)
    with client.websocket_connect(feed_url()) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        r = client.post(
            papi("/commits"),
            json={
                "base_rev": _rev(client),
                "ops": [{"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A2"}],
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
                    {"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A3"},
                ],
                "lock_tokens": [token2],
            },
        )
        assert r.status_code == 200, r.text
        commit2 = ws.receive_json()
        while commit2["type"] != "commit":
            commit2 = ws.receive_json()
        assert commit2["scope"] == ["model", "view"]


def test_delete_folder_commit_requires_lease_on_subtree_child(
    client: TestClient,
) -> None:
    """A ``delete_folder``'s lock requirement expands over the whole subtree
    (required_locks -> folder_subtree against the view the op names): a
    caller holding only the parent is refused with the child listed as
    missing, and nothing is applied or persisted."""
    vid, ids = _seed_view(client, [{"name": "D", "folders": [{"name": "C"}]}])
    d_id, c_id = ids["D"], ids["C"]

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

    # A DELETE-intent lock request on D expands to C at /locks too and is
    # refused outright by P's lease.
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": d_id, "mode": "exclusive", "type": "folder"}],
            "intent": "delete",
        },
    )
    assert r.status_code == 409, r.text

    # An EDIT lease on D alone is granted (no expansion) — and is not enough
    # for the commit, whose own derivation expands to {D, C}.
    d_token = _folder_lease(client, d_id)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "delete_folder", "view_id": vid, "id": d_id}],
            "message": "m",
            "lock_tokens": [d_token],
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "required lock not held"
    assert f"folder:{c_id}" in [m["resource_id"] for m in r.json()["missing"]]

    # nothing was applied: the lock check is the FIRST thing inside the
    # mutex. Read the durable row directly (eviction is a no-op while any
    # lease is live — see SessionRegistry.evict) to prove it still shows
    # D -> C.
    from data_rover.api import content, db
    from data_rover.api.session import DEFAULT_PROJECT_ID

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


def test_persist_failure_rolls_back_all_halves_and_keeps_leases(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Characterization pin for create_commit's persist-failure (500) unwind —
    the richest failure block: model rollback, rev decrement, view rollback,
    op_log pop, db rollback — and the caller's leases must NOT be released
    (release is step g, strictly after a durable commit). Mirrors
    test_apply_ops_rolls_back_in_memory_on_persist_failure
    (tests/api/test_ops_persistence.py), which pins the same seam for
    /model/ops."""
    from data_rover.api import content as _content

    vid = create_view(client, "V")
    token = _view_lease(client, vid)
    base = _rev(client)
    session = get_session()
    op_log_before = len(session.op_log)
    elems_before = client.get(papi("/model/elements")).json()["total"]

    def _boom(*_a: object, **_kw: object) -> None:
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(_content, "append_commit", _boom)
    ops = [
        # model half (a create needs no lock) + view half, so BOTH in-place
        # halves are live when the persist step blows up.
        {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node",
         "properties": {}},
        {"kind": "create_folder", "view_id": vid, "temp_id": "tmp_c",
         "parent_id": "root", "name": "A"},
    ]
    r = client.post(
        papi("/commits"),
        json={"base_rev": base, "ops": ops, "message": "m", "lock_tokens": [token]},
    )
    assert r.status_code == 500

    # rev + undo history rolled back in-memory; the view group unwound
    assert session.model_rev == base
    assert len(session.op_log) == op_log_before
    assert session.views[vid].folders == []

    monkeypatch.undo()  # restore append_commit so the probe requests work
    out = _get_view(client, vid)
    assert out["view"]["folders"] == [] and out["view_rev"] == 0
    assert client.get(papi("/model/elements")).json()["total"] == elems_before
    assert _rev(client) == base
    # leases survive a failed commit — release only follows a durable commit
    held = {le["resource_id"] for le in client.get(papi("/locks")).json()["leases"]}
    assert f"view:{vid}" in held
