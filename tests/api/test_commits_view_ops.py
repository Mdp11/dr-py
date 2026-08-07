"""View ops through the lock-verified commit flow: lease enforcement,
journaling, view_rev lockstep, auto-created views, mixed-batch atomicity
(the view half rolls back when the model half hard-fails), preview dryness,
and the feed scope."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, feed_url, papi, seed_default_project

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


def test_commit_requires_folder_lease(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    ops = [{"kind": "rename_folder", "id": fid, "name": "A2"}]
    r = client.post(
        papi("/commits"),
        json={"base_rev": _rev(client), "ops": ops, "message": "m", "lock_tokens": []},
    )
    assert r.status_code == 409
    assert r.json()["missing"][0]["resource_id"] == f"folder:{fid}"


def test_commit_applies_persists_and_journals(client: TestClient) -> None:
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
    put_view_rev = r.json()["view_rev"]
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
    assert out["view_rev"] == put_view_rev + 1  # lockstep with the legacy PUT path
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


def test_mixed_batch_atomicity_view_rolls_back_with_model(client: TestClient) -> None:
    """A structural model blocker rolls back the ALREADY-APPLIED view half."""
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
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
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
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
    r = client.put(papi("/view/snapshot"), json={"name": "v", "folders": [{"name": "A"}]})
    fid = r.json()["view"]["folders"][0]["id"]
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
