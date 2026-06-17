"""Tests for durable commit persistence in POST /model/ops and POST /model/undo.

Verifies that accepted op batches are recorded as Commit rows and that
models.model_rev stays in lockstep with the in-memory session.model_rev.

Setup uses the HTTP metamodel + upload routes, which now persist the DB model
row themselves (Task 9), so _persist_commit's early-return guard fires
correctly without manual DB seeding."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client() -> TestClient:
    """Build a test client with a live in-memory session AND a DB model row.

    Both are populated by the HTTP routes (POST /metamodel, POST /model/upload),
    which now persist the DB model row themselves (Task 9), so
    _persist_commit's ``get_model_row is None`` early-return does NOT fire
    and commits are actually written."""
    seed_default_project()
    c = TestClient(create_app())
    r = c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    r = c.post(papi("/model/upload"),
               content=b'{"elements":[],"relationships":[]}',
               headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
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
        model_row = content.get_model_row(s, "default")
        assert model_row is not None and model_row.model_rev == new_rev
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


# ---------------------------------------------------------------------------
# FIX I-1: periodic snapshot
# ---------------------------------------------------------------------------

def test_periodic_snapshot_written_when_snapshot_every_1(monkeypatch: pytest.MonkeyPatch) -> None:
    """With snapshot_every=1, every accepted commit triggers a snapshot."""
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
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
        snap = content.latest_snapshot(s, "default")
        assert snap is not None, "no snapshot row was written"
        assert snap.rev == new_rev


def test_periodic_snapshot_not_written_for_default_snapshot_every() -> None:
    """With the default snapshot_every (200), a single ops batch must NOT
    write a snapshot row (rev 1 mod 200 != 0)."""
    # snapshot_every defaults to 200, so after one batch (rev 1) no snapshot
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
    # The model upload itself may have written a snapshot at base; we only care
    # that no new snapshot exists at new_rev.
    with db.db_session() as s:
        snap = content.latest_snapshot(s, "default")
        assert snap is None or snap.rev != new_rev


# ---------------------------------------------------------------------------
# FIX I-2: in-memory rollback on DB commit failure
# ---------------------------------------------------------------------------

def test_apply_ops_rolls_back_in_memory_on_persist_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If append_commit raises, the in-memory model and session rev must be
    rolled back to the pre-request state and no journal row must appear."""
    from data_rover.api import content as _content
    from data_rover.api.session import get_registry

    c = _client()
    t = _concrete_type(c)
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    elem_count_before = c.get(papi("/model/elements"), headers=AUTH_HEADERS).json()["total"]

    def _boom(*_a: object, **_kw: object) -> None:
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(_content, "append_commit", _boom)

    r = c.post(
        papi("/model/ops"),
        json={"base_rev": base, "ops": [
            {"kind": "create_element", "temp_id": "tmp_1", "type_name": t,
             "properties": {}}]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 500

    # in-memory session rev must be back to base
    session = get_registry().get("default")
    assert session.model_rev == base, (
        f"model_rev was not rolled back: expected {base}, got {session.model_rev}"
    )

    # the element must NOT have been created (model has original count)
    monkeypatch.undo()  # restore append_commit so next request works
    after_total = c.get(papi("/model/elements"), headers=AUTH_HEADERS).json()["total"]
    assert after_total == elem_count_before, "element was not rolled back"

    # no journal row must have landed
    with db.db_session() as s:
        rows = content.commits_after(s, "default", base)
        assert rows == [], f"unexpected commit rows: {rows}"
