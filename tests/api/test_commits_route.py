"""Tests for POST /commits/preview (Phase 4 mandatory pre-commit validation)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

# Minimal metamodel: one concrete element type.
_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"),
        content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _rev(client: TestClient) -> int:
    """Current model_rev from GET /model/summary."""
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _etype(client: TestClient) -> str:
    """First concrete element type name from the uploaded metamodel."""
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    return next(e["name"] for e in mm["elements"] if not e.get("abstract", False))


def test_preview_clean_create_reports_zero_errors(client: TestClient) -> None:
    r = client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_x",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["conformance_error_count"] == 0
    assert r.json()["structural_blockers"] == []


def test_preview_does_not_mutate_model_rev(client: TestClient) -> None:
    before = _rev(client)
    client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": before,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_x",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
        },
    )
    assert _rev(client) == before  # preview rolled back; rev unchanged


def test_preview_base_rev_mismatch_409(client: TestClient) -> None:
    r = client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={"base_rev": 9999, "ops": []},
    )
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# POST /commits tests (Phase 4 Task 9)
# ---------------------------------------------------------------------------


def _lock(client: TestClient, rid: str, mode: str = "exclusive", intent: str = "edit") -> str:
    """Acquire a lock on *rid* and return the token."""
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": rid, "mode": mode}], "intent": intent},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_commit_requires_held_lock_409(client: TestClient) -> None:
    # create an element to edit (via ops, which is the unlocked legacy path)
    rev = _rev(client)
    cr = client.post(
        papi("/model/ops"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_e",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
        },
    )
    assert cr.status_code == 200, cr.text
    eid = cr.json()["id_map"]["tmp_e"]
    # commit an edit to eid WITHOUT holding its lock -> 409
    r = client.post(
        papi("/commits"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "update_element", "id": eid, "properties_patch": {}}],
            "lock_tokens": [],
            "message": "edit",
        },
    )
    assert r.status_code == 409, r.text


def test_commit_with_lock_succeeds_and_records_message(client: TestClient) -> None:
    rev = _rev(client)
    cr = client.post(
        papi("/model/ops"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_e",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
        },
    )
    assert cr.status_code == 200, cr.text
    eid = cr.json()["id_map"]["tmp_e"]
    token = _lock(client, eid)
    r = client.post(
        papi("/commits"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "update_element", "id": eid, "properties_patch": {}}],
            "lock_tokens": [token],
            "message": "tweak",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["message"] == "tweak"
    assert "commit_id" in body
    # commit must have released the lock
    leases = client.get(papi("/locks"), headers=AUTH_HEADERS).json()["leases"]
    assert leases == []


def test_commit_creates_freefloating_without_lock(client: TestClient) -> None:
    # a free-floating create needs no lock (no existing resource id to lock)
    r = client.post(
        papi("/commits"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_n",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
            "lock_tokens": [],
            "message": "new",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["id_map"]["tmp_n"]


# ---------------------------------------------------------------------------
# Minor #3: commit path must call _maybe_periodic_snapshot
# ---------------------------------------------------------------------------

_MM_SNAP = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client_with_model() -> TestClient:
    """Build a test client with a live in-memory session AND a DB model row via
    the HTTP upload routes, matching the pattern in test_ops_persistence.py."""
    seed_default_project()
    c = TestClient(create_app())
    r = c.post(papi("/metamodel"), content=_MM_SNAP, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    r = c.post(
        papi("/model/upload"),
        content=b'{"elements":[],"relationships":[]}',
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    return c


def _concrete_type_snap(c: TestClient) -> str:
    mm = c.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    for et in mm["elements"]:
        if not et.get("abstract"):
            return et["name"]
    raise AssertionError("no concrete element type found")


def test_commit_writes_periodic_snapshot_when_snapshot_every_1(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With snapshot_every=1 every accepted commit triggers a snapshot — this
    verifies the commit path (POST /commits) calls _maybe_periodic_snapshot,
    mirroring the equivalent behaviour in POST /model/ops."""
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    c = _client_with_model()
    t = _concrete_type_snap(c)
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    r = c.post(
        papi("/commits"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": base,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_snap",
                    "type_name": t,
                    "properties": {},
                }
            ],
            "lock_tokens": [],
            "message": "snapshot test",
        },
    )
    assert r.status_code == 200, r.text
    new_rev = r.json()["model_rev"]
    with db.db_session() as s:
        snap = content.latest_snapshot(s, "default")
        assert snap is not None, "no snapshot row was written by POST /commits"
        assert snap.rev == new_rev


def test_commit_survives_post_commit_snapshot_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import data_rover.api.routes.commits as commits_mod

    def _boom(*a, **k):
        raise RuntimeError("snapshot store down")

    monkeypatch.setattr(commits_mod, "_maybe_periodic_snapshot", _boom)

    before = _rev(client)
    r = client.post(
        papi("/commits"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": before,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_n",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
            "lock_tokens": [],
            "message": "new",
        },
    )
    # the durable commit landed and rev advanced despite the snapshot failure
    assert r.status_code == 200, r.text
    assert r.json()["model_rev"] == before + 1
