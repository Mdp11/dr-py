"""Tests for durable commit persistence in POST /commits and POST /commits/revert.

Verifies that accepted op batches are recorded as Commit rows and that
models.model_rev stays in lockstep with the in-memory ProjectState.model_rev.

Setup installs the metamodel and model, which persists the DB model row, so
the commit path's ``get_model_row is None`` early-return does not fire and
commits are actually written."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app
from tests.api.conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    commit_ops,
    head,
    install,
    papi,
    post_commit,
    seed_default_project,
)

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client() -> TestClient:
    """Build a test client with a live in-memory session AND a DB model row."""
    seed_default_project()
    c = TestClient(create_app())
    install(metamodel=MM, model=EMPTY_MODEL)
    return c


def _concrete_type(c: TestClient) -> str:
    mm = c.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    for et in mm["elements"]:  # Metamodel serializes its types under "elements"
        if not et.get("abstract"):
            return et["name"]
    raise AssertionError


def _create(t: str) -> list[dict]:
    return [
        {"kind": "create_element", "temp_id": "tmp_1", "type_name": t, "properties": {}}
    ]


def test_ops_batch_persists_a_commit_and_bumps_db_rev() -> None:
    c = _client()
    t = _concrete_type(c)
    base = head().rev
    new_rev = commit_ops(c, _create(t))["model_rev"]
    with db.db_session() as s:
        model_row = content.get_model_row(s, "default")
        assert model_row is not None and model_row.model_rev == new_rev
        tail = content.commits_after(s, "default", base)
        assert len(tail) == 1 and tail[0].ops[0]["kind"] == "create_element"


def test_revert_appends_compensating_commit_and_advances_rev() -> None:
    c = _client()
    t = _concrete_type(c)
    base = head().rev
    commit_ops(c, _create(t))
    u = c.post(
        papi("/commits/revert"),
        json={"target_rev": base, "base_rev": base + 1},
        headers=AUTH_HEADERS,
    )
    assert u.status_code == 200
    assert u.json()["model_rev"] == base + 2  # forward, not back
    with db.db_session() as s:
        revs = [cmt.rev for cmt in content.commits_after(s, "default", base)]
        assert revs == [base + 1, base + 2]  # apply + compensating revert


# ---------------------------------------------------------------------------
# periodic snapshot
# ---------------------------------------------------------------------------

def test_periodic_snapshot_written_when_snapshot_every_1(monkeypatch: pytest.MonkeyPatch) -> None:
    """With snapshot_every=1, every accepted commit triggers a snapshot."""
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    c = _client()
    t = _concrete_type(c)
    new_rev = commit_ops(c, _create(t))["model_rev"]
    with db.db_session() as s:
        snap = content.latest_snapshot(s, "default")
        assert snap is not None, "no snapshot row was written"
        assert snap.rev == new_rev


def test_periodic_snapshot_not_written_for_default_snapshot_every() -> None:
    """With the default snapshot_every (200), a single ops batch must NOT
    write a snapshot row (rev 1 mod 200 != 0)."""
    c = _client()
    t = _concrete_type(c)
    new_rev = commit_ops(c, _create(t))["model_rev"]
    # The baseline snapshot sits below new_rev; only a snapshot at new_rev is wrong.
    with db.db_session() as s:
        snap = content.latest_snapshot(s, "default")
        assert snap is None or snap.rev != new_rev


# ---------------------------------------------------------------------------
# in-memory rollback on DB commit failure
# ---------------------------------------------------------------------------

def test_apply_ops_rolls_back_in_memory_on_persist_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If append_commit raises, the in-memory state rev must be
    rolled back to the pre-request state and no journal row must appear."""
    from data_rover.api import content as _content
    from data_rover.api.project_state import get_registry

    c = _client()
    t = _concrete_type(c)
    base = head().rev
    elem_count_before = len(head().elements)

    def _boom(*_a: object, **_kw: object) -> None:
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(_content, "append_commit", _boom)

    r = post_commit(c, _create(t))
    assert r.status_code == 500

    # in-memory state rev must be back to base
    state = get_registry().get("default")
    assert state.model_rev == base, (
        f"model_rev was not rolled back: expected {base}, got {state.model_rev}"
    )

    # the element must NOT have been created (model has original count)
    monkeypatch.undo()  # restore append_commit so next request works
    after_total = len(head().elements)
    assert after_total == elem_count_before, "element was not rolled back"

    # no journal row must have landed
    with db.db_session() as s:
        rows = content.commits_after(s, "default", base)
        assert rows == [], f"unexpected commit rows: {rows}"
