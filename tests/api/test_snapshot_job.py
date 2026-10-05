"""The periodic snapshot runs off the commit's critical section: a daemon
thread streams the rows at the CURRENT rev, skips projects without a model
row, keeps one job per project, and logs-and-drops failures. The conftest pins
DATA_ROVER_SNAPSHOT_SYNC=true so every other test sees the inline write.

Baseline rev: ``_client()`` installs the model at rev 0, so the baseline
snapshot sits at rev 0. Tests below read the baseline dynamically.."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, snapshot_job
from data_rover.api.db_models import Project
from data_rover.api.main import create_app
from data_rover.api.project_state import DEFAULT_PROJECT_ID
from data_rover.api.snapshot_job import SnapshotJob, schedule_periodic_snapshot
from tests.api.conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    commit_ops,
    default_state,
    install,
    papi,
    seed_default_project,
)

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


def _client() -> TestClient:
    """A durable model row, so commits are actually journaled."""
    seed_default_project()
    c = TestClient(create_app())
    install(metamodel=MM, model=EMPTY_MODEL)
    return c


def _concrete_type(c: TestClient) -> str:
    mm = c.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    for et in mm["elements"]:
        if not et.get("abstract"):
            return et["name"]
    raise AssertionError("no concrete element type")


def _create_one(c: TestClient) -> int:
    body = commit_ops(
        c,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_1",
                "type_name": _concrete_type(c),
                "properties": {},
            }
        ],
    )
    rev: int = body["model_rev"]
    return rev


def _latest_snapshot_rev() -> int | None:
    with db.db_session() as s:
        snap = content.latest_snapshot(s, DEFAULT_PROJECT_ID)
        return None if snap is None else snap.rev


def test_route_schedules_the_job_asynchronously(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The route hands off to the thread rather than writing inline: the
    sentinel replaces ``write_snapshot_from_rows`` so the job thread performs no
    database work at all, keeping it from ever overlapping the request's
    own use of the shared in-memory-SQLite connection."""
    c = _client()  # its rev-0 snapshot goes through the job, inline under the pin
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_SYNC", "false")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    calls: list[str] = []

    def _sentinel(project_id: str) -> int:
        calls.append(project_id)
        return 4242

    monkeypatch.setattr(
        "data_rover.api.snapshot_job.write_snapshot_from_rows", _sentinel
    )
    _create_one(c)
    job = snapshot_job.current_job(DEFAULT_PROJECT_ID)
    assert job is not None
    assert job.done.wait(10.0), "snapshot job did not finish"
    assert job.running is False
    assert job.written_rev == 4242
    assert calls == [DEFAULT_PROJECT_ID]


def test_async_job_writes_the_snapshot_row() -> None:
    """No request is in flight here, so the job's ``db_session()`` is the
    only user of the shared in-memory-SQLite connection: this is what
    exercises the genuine daemon thread doing a genuine durable write."""
    _client()
    rev = default_state().model_rev
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, sync=False)
    assert job is not None
    assert job.done.wait(10.0), "snapshot job did not finish"
    assert job.running is False
    assert job.written_rev == rev
    assert _latest_snapshot_rev() == rev


def test_sync_job_writes_inline_under_the_conftest_pin() -> None:
    c = _client()
    baseline = _latest_snapshot_rev()  # the upload's baseline
    rev = _create_one(c)  # default snapshot_every=200: no trigger
    assert _latest_snapshot_rev() == baseline  # unchanged: no trigger fired
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID)  # sync via the pin
    assert job is not None and job.running is False and job.written_rev == rev
    assert _latest_snapshot_rev() == rev


def test_job_writes_the_rev_it_finds() -> None:
    """No rev is plumbed into schedule_periodic_snapshot: it always snapshots
    whatever rev the head is at when it runs. Any rev at or past the
    trigger bounds the replay tail equally."""
    c = _client()
    _create_one(c)
    rev2 = _create_one(c)
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, sync=True)
    assert job is not None and job.written_rev == rev2
    assert _latest_snapshot_rev() == rev2


def test_job_skips_a_project_without_a_model_row() -> None:
    seed_default_project()
    with db.db_session() as s:
        s.add(Project(id="ghost", name="Ghost"))
    job = schedule_periodic_snapshot("ghost", sync=True)
    assert job is not None and job.running is False and job.written_rev is None
    with db.db_session() as s:
        assert content.latest_snapshot(s, "ghost") is None


def test_second_trigger_while_a_job_runs_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _client()
    baseline_rev = default_state().model_rev  # no _create_one: still at baseline
    running = SnapshotJob()  # running=True by construction
    monkeypatch.setitem(snapshot_job._jobs, DEFAULT_PROJECT_ID, running)
    assert schedule_periodic_snapshot(DEFAULT_PROJECT_ID, sync=True) is None
    running.running = False
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, sync=True)
    assert job is not None and job.written_rev == baseline_rev


def test_slots_are_per_project(monkeypatch: pytest.MonkeyPatch) -> None:
    _client()
    monkeypatch.setitem(snapshot_job._jobs, "other", SnapshotJob())
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, sync=True)
    assert job is not None and job.written_rev is not None


def test_job_failure_is_logged_not_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    """Monkeypatches the module logger directly rather than using caplog:
    ``alembic.command.upgrade`` (exercised by test_alembic.py, which can run
    earlier in the same session) calls ``logging.config.fileConfig``, whose
    default ``disable_existing_loggers`` permanently disables every logger
    not in its own config -- including this module's -- for the rest of the
    process (the same order-dependent hazard test_lock_mirror.py documents
    and sidesteps the same way)."""
    _client()

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("snapshot store down")

    warn_messages: list[str] = []
    monkeypatch.setattr("data_rover.api.snapshot_job.write_snapshot_from_rows", _boom)
    monkeypatch.setattr(
        snapshot_job.logger,
        "warning",
        lambda msg, *a, **kw: warn_messages.append(str(msg)),
    )
    job = schedule_periodic_snapshot(DEFAULT_PROJECT_ID, sync=True)
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

    monkeypatch.setattr("data_rover.api.snapshot_job.write_snapshot_from_rows", _boom)
    rev = _create_one(c)  # asserts 200 inside
    assert rev == baseline + 1
    assert _latest_snapshot_rev() == baseline


# --- the rev-0 snapshot goes through the job -------------------------------------


def _rev0_snapshot_exists(project_id: str) -> bool:
    with db.db_session() as s:
        return content.get_snapshot(s, project_id, 0) is not None


def _wait_for_job(project_id: str) -> SnapshotJob:
    job = snapshot_job.current_job(project_id)
    assert job is not None, "no job was scheduled"
    assert job.done.wait(10.0), "snapshot job did not finish"
    return job


def test_import_schedules_its_rev0_snapshot_on_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from data_rover.api import importer

    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_SYNC", "false")
    importer.import_project(
        project_id="imp",
        name="Imp",
        owner_id="u1",
        metamodel_yaml=MM,
        model_json=EMPTY_MODEL,
    )
    job = _wait_for_job("imp")
    assert job.written_rev == 0
    assert _rev0_snapshot_exists("imp")


def test_clone_schedules_its_rev0_snapshot_on_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from data_rover.api import importer

    _client()  # the source, installed under the inline pin
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_SYNC", "false")
    importer.clone_project(
        source_id=DEFAULT_PROJECT_ID, project_id="copy", name="Copy", owner_id="u1"
    )
    job = _wait_for_job("copy")
    assert job.written_rev == 0
    assert _rev0_snapshot_exists("copy")


def test_install_schedules_its_rev0_snapshot_on_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _client()
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_SYNC", "false")
    with db.db_session() as s:
        from data_rover.api import importer

        importer.install_model(
            s, DEFAULT_PROJECT_ID, metamodel_yaml=MM, model_json=EMPTY_MODEL
        )
    job = _wait_for_job(DEFAULT_PROJECT_ID)
    assert job.written_rev == 0
    assert _rev0_snapshot_exists(DEFAULT_PROJECT_ID)


def test_an_open_after_an_import_whose_job_has_not_written_gets_a_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The descriptor writes a missing rev-0 snapshot itself, so a replica that
    opens before the job has written does not wait for it."""
    c = _client()
    with db.db_session() as s:
        from sqlalchemy import delete

        from data_rover.api.db_models import Snapshot

        s.execute(delete(Snapshot))
    r = c.get(papi("/replica/snapshot"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    assert r.json()["rev"] == 0
    assert _rev0_snapshot_exists(DEFAULT_PROJECT_ID)
