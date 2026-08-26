"""The periodic snapshot runs off the commit's critical section: a daemon
thread takes write_mutex itself, snapshots the CURRENT rev, skips sessions
the registry no longer holds, and logs-and-drops failures. The conftest pins
DATA_ROVER_SNAPSHOT_SYNC=true so every other test sees the inline write.

Baseline rev: ``_client()``'s two uploads each bump ``session.model_rev``
once (``POST /metamodel`` via ``set_metamodel`` -> ``set_model(None)``, then
``POST /model/upload`` via ``set_model(model)``), landing the baseline
snapshot at rev 2, not 0 — the same reason ``test_ops_persistence.py``'s
analogous test compares against the observed baseline instead of a
hardcoded rev. Tests below read the baseline dynamically for the same
reason."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, snapshot_job
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, Session, get_registry
from data_rover.api.snapshot_job import SnapshotJob, schedule_periodic_snapshot
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client() -> TestClient:
    """Live session + durable model row via the upload routes (the
    test_ops_persistence.py harness), so commits are actually journaled."""
    seed_default_project()
    c = TestClient(create_app())
    r = c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    r = c.post(
        papi("/model/upload"),
        content=b'{"elements":[],"relationships":[]}',
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    return c


def _concrete_type(c: TestClient) -> str:
    mm = c.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    for et in mm["elements"]:
        if not et.get("abstract"):
            return et["name"]
    raise AssertionError("no concrete element type")


def _create_one(c: TestClient) -> int:
    base = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]
    r = c.post(
        papi("/model/ops"),
        json={"base_rev": base, "ops": [
            {"kind": "create_element", "temp_id": "tmp_1",
             "type_name": _concrete_type(c), "properties": {}}]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    return r.json()["model_rev"]


def _live_session() -> Session:
    session = get_registry().peek(DEFAULT_PROJECT_ID)
    assert session is not None
    return session


def _latest_snapshot_rev() -> int | None:
    with db.db_session() as s:
        snap = content.latest_snapshot(s, DEFAULT_PROJECT_ID)
        return None if snap is None else snap.rev


def test_async_job_writes_the_snapshot_row(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_SYNC", "false")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    c = _client()
    rev = _create_one(c)
    job = _live_session().snapshot_job
    assert job is not None
    assert job.done.wait(10.0), "snapshot job did not finish"
    assert job.running is False
    assert job.written_rev == rev
    assert _latest_snapshot_rev() == rev


def test_sync_job_writes_inline_under_the_conftest_pin() -> None:
    c = _client()
    session = _live_session()
    baseline = _latest_snapshot_rev()  # the upload's baseline
    rev = _create_one(c)  # default snapshot_every=200: no trigger
    assert _latest_snapshot_rev() == baseline  # unchanged: no trigger fired
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session)  # sync via the pin
    assert job is not None and job.running is False and job.written_rev == rev
    assert _latest_snapshot_rev() == rev


def test_job_snapshots_the_current_rev_not_the_trigger() -> None:
    """Any rev at or past the trigger bounds the replay tail equally."""
    c = _client()
    session = _live_session()
    _create_one(c)
    rev2 = _create_one(c)
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.written_rev == rev2


def test_job_skips_a_session_the_registry_no_longer_holds() -> None:
    c = _client()
    session = _live_session()
    baseline = _latest_snapshot_rev()
    _create_one(c)
    get_registry().discard(DEFAULT_PROJECT_ID)
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.running is False and job.written_rev is None
    assert _latest_snapshot_rev() == baseline  # nothing past the baseline


def test_second_trigger_while_a_job_runs_is_dropped() -> None:
    _client()
    session = _live_session()
    baseline_rev = session.model_rev  # no _create_one: still at baseline
    session.snapshot_job = SnapshotJob()  # running=True by construction
    assert schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True) is None
    session.snapshot_job.running = False
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.written_rev == baseline_rev


def test_job_failure_is_logged_not_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    """Monkeypatches the module logger directly rather than using caplog:
    ``alembic.command.upgrade`` (exercised by test_alembic.py, which can run
    earlier in the same session) calls ``logging.config.fileConfig``, whose
    default ``disable_existing_loggers`` permanently disables every logger
    not in its own config -- including this module's -- for the rest of the
    process (the same order-dependent hazard test_lock_mirror.py documents
    and sidesteps the same way)."""
    _client()
    session = _live_session()

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("snapshot store down")

    warn_messages: list[str] = []
    monkeypatch.setattr("data_rover.api.snapshot_job.write_snapshot", _boom)
    monkeypatch.setattr(
        snapshot_job.logger,
        "warning",
        lambda msg, *a, **kw: warn_messages.append(str(msg)),
    )
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, session, sync=True)
    assert job is not None and job.running is False and job.written_rev is None
    assert job.done.is_set()
    assert len(warn_messages) == 1
    assert "periodic snapshot failed" in warn_messages[0]


def test_ops_route_survives_a_failing_periodic_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The commit is durable before the snapshot; a store outage must not
    turn a landed batch into a 500."""
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    c = _client()
    baseline = _latest_snapshot_rev()
    assert baseline is not None

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("snapshot store down")

    monkeypatch.setattr("data_rover.api.snapshot_job.write_snapshot", _boom)
    rev = _create_one(c)  # asserts 200 inside
    assert rev == baseline + 1
    assert _latest_snapshot_rev() == baseline
