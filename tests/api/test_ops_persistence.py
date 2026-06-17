"""Tests for durable commit persistence in POST /model/ops and POST /model/undo.

Verifies that accepted op batches are recorded as Commit rows and that
models.model_rev stays in lockstep with the in-memory session.model_rev.

Setup uses the HTTP metamodel + upload routes for the in-memory session and
seeds the DB model row directly (replicating what the Task-9 persisted upload
path will do) so _persist_commit's early-return guard fires correctly."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client() -> TestClient:
    """Build a test client with a live in-memory session AND a DB model row.

    The in-memory session is populated via the normal HTTP routes
    (POST /metamodel, POST /model/upload). The DB model row is seeded
    directly — mirroring what the Task-9 persisted upload path will do —
    so _persist_commit's ``get_model_row is None`` early-return does NOT
    fire and commits are actually written."""
    seed_default_project()
    c = TestClient(create_app())
    # Load metamodel + model into the in-memory session.
    r = c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    r = c.post(papi("/model/upload"),
               content=b'{"elements":[],"relationships":[]}',
               headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    model_rev = r.json()["model_rev"]

    # Seed the DB model row (Task 9 will do this inside the upload route).
    with db.db_session() as s:
        mm_row = content.create_metamodel(
            s, name="smart-city", version=1, blob=MM
        )
        row = content.upsert_model_row(
            s, DEFAULT_PROJECT_ID, metamodel_id=mm_row.id
        )
        row.model_rev = model_rev

    return c


def _concrete_type(c: TestClient) -> str:
    mm = c.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    for et in mm["elements"]:  # Metamodel serializes its types under "elements"
        if not et.get("abstract"):
            return et["name"]
    raise AssertionError


def test_ops_batch_persists_a_commit_and_bumps_db_rev() -> None:
    c = _client()
    t = _concrete_type(c)
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    r = c.post(
        papi("/model/ops"),
        json={"base_rev": base, "ops": [
            {"kind": "create_element", "temp_id": "tmp_1", "type_name": t,
             "properties": {}}]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    new_rev = r.json()["model_rev"]
    with db.db_session() as s:
        assert content.get_model_row(s, "default").model_rev == new_rev
        tail = content.commits_after(s, "default", base)
        assert len(tail) == 1 and tail[0].ops[0]["kind"] == "create_element"


def test_undo_appends_compensating_commit_and_advances_rev() -> None:
    c = _client()
    t = _concrete_type(c)
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    c.post(papi("/model/ops"),
           json={"base_rev": base, "ops": [
               {"kind": "create_element", "temp_id": "tmp_1", "type_name": t,
                "properties": {}}]},
           headers=AUTH_HEADERS)
    u = c.post(papi("/model/undo"), headers=AUTH_HEADERS)
    assert u.status_code == 200
    assert u.json()["model_rev"] == base + 2  # forward, not back
    with db.db_session() as s:
        revs = [cmt.rev for cmt in content.commits_after(s, "default", base)]
        assert revs == [base + 1, base + 2]  # apply + compensating undo
