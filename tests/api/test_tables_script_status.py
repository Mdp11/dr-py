"""Evaluate-route Phase B behaviour (spec 2026-07-20 §4.1-4.2).

The whole-table passes (`build_rows_ex` + `order_rows`) run CACHE-ONLY: the
guest is never driven O(rows) times inside a request. A miss records a pending
cell, which makes the route degrade to BUILD order (a sort over half-pending
values would visibly reshuffle on every poll), kick/join the background sweep,
and report a `script_status` block the client polls on. Only the visible window
is still evaluated live.

Fixtures mirror `test_script_cell_cache_api.py` (separate `app`/`client` so the
runner can be swapped through `dependency_overrides`); the runner fakes come
from `_script_fakes.py`. Sync sweep mode is pinned exactly the way
`test_script_sweep.py` pins it — the `DATA_ROVER_SNIPPET_SWEEP_SYNC` env var
plus a fresh `get_settings()` and an assertion that the flag took — so the
"after the sweep" cases observe a finished job with no sleeping. The one async
case parks the sweep thread on an Event instead.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes.tables import _status_from_job
from data_rover.api.script_runner import get_runner
from data_rover.api.script_sweep import SweepJob
from data_rover.api.session import get_session
from data_rover.api.settings import Settings, get_settings
from data_rover.api.table_cache import table_fingerprint
from data_rover.core.script.runner import CallResult
from data_rover.core.table.schema import TABLE_ADAPTER

from ._script_fakes import CountingRunner, ScriptedRunner, ok, timeout
from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""

VALUE_CODE = "def value(els): return 1"

#: Five elements: enough that the sweep's consecutive-timeout abort threshold
#: (3) and a two-row window produce distinguishable guest-call counts.
THING_IDS = ["t1", "t2", "t3", "t4", "t5"]


@pytest.fixture
def app() -> Iterator[FastAPI]:
    seed_default_project()
    application = create_app()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def seed_thing_model(client: TestClient) -> None:
    """`Thing` metamodel + five `Thing` elements, loaded through the HTTP
    routes so the table below has real rows in a deterministic build order
    (`t1`..`t5`, the scope's insertion order)."""
    r = client.post(
        papi("/metamodel"),
        content=THING_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": tid, "type_name": "Thing", "properties": {"name": f"N{i}"}}
                for i, tid in enumerate(THING_IDS)
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text


@pytest.fixture
def settings_sync_sweep(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Pin `snippet_sweep_sync=True` (env var + fresh `get_settings()`), so
    `kick_or_join_sweep` runs the whole sweep inline inside the request that
    kicks it. `get_settings` is an uncached `Settings()` factory, so the route's
    own `Depends(get_settings)` picks the env var up too."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    settings = get_settings()
    assert settings.snippet_sweep_sync is True
    return settings


def _script_table() -> dict:
    """Element column + a COLLAPSE script column. `keep_empty` defaults True, so
    an UNSORTED evaluation never calls the snippet during the whole-table
    passes — only a sort on column 1 does."""
    return {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [
            {"kind": "element"},
            {
                "kind": "script",
                "snippet": {"definition": {"code": VALUE_CODE}},
            },
        ],
    }


def _plain_table() -> dict:
    """No script column anywhere: `script_ctx is None`, so the route must be
    completely untouched by Phase B (`script_status is None`)."""
    return {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [{"kind": "element"}],
    }


def _fingerprint() -> str:
    """The sweep's job key for `_script_table()`: the resolved definition dumped
    with a None sort (the job key excludes the sort on purpose)."""
    defn = TABLE_ADAPTER.validate_python(_script_table())
    return table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), None)


def _descending_value(_i: int, ids: list[str]) -> CallResult:
    """`t1`->5 … `t5`->1, so an ASCENDING sort on the script column yields the
    exact REVERSE of the build order — build order and sorted order can never
    be confused for one another."""
    return ok(10 - int(ids[0][1:]))


def _evaluate(
    client: TestClient, table: dict, *, sort: bool = True, limit: int = 50
) -> dict:
    body: dict = {"definition": table, "limit": limit}
    if sort:
        body["sort"] = {"column": 1, "direction": "asc"}
    r = client.post(papi("/tables/evaluate"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


def _keys(page: dict) -> list[object]:
    return [row["key"][0] for row in page["rows"]]


# --------------------------------------------------------------------------
# _status_from_job: the job-state -> wire-state mapping
# --------------------------------------------------------------------------


def test_status_from_job_never_reports_ready() -> None:
    """D1: `_status_from_job` is only reached when the cache-only pass saw
    pending, so its rows predate the sweep — even a job that FINISHED during
    this very request (sync mode) must report `computing` so the client polls
    once more and gets the clean sorted page."""
    running = _status_from_job(SweepJob(fingerprint="f", rev=0, done=1, total=4))
    assert running.state == "computing"
    assert (running.done, running.total) == (1, 4)

    finished = SweepJob(fingerprint="f", rev=0, state="done", done=4, total=4)
    assert _status_from_job(finished).state == "computing"


def test_status_from_job_maps_failed_and_cancelled_to_terminal_states() -> None:
    """`failed` and `cancelled` are both DEAD jobs — no thread is behind either
    — so both map to the terminal wire state `failed`. Reporting `computing`
    for a cancelled job would strand the poller until the next commit."""
    failed = SweepJob(
        fingerprint="f", rev=0, state="failed", message="boom", done=2, total=9
    )
    out = _status_from_job(failed)
    assert out.state == "failed"
    assert out.message == "boom"
    assert (out.done, out.total) == (2, 9)

    cancelled = SweepJob(
        fingerprint="f", rev=0, state="cancelled", message="sweep cancelled"
    )
    out = _status_from_job(cancelled)
    assert out.state == "failed"
    assert out.message == "sweep cancelled"


# --------------------------------------------------------------------------
# Route behaviour
# --------------------------------------------------------------------------


def test_plain_table_has_no_script_status(
    client: TestClient, app: FastAPI, seed_thing_model: None
) -> None:
    """Regression net: a table without script columns is untouched."""
    page = _evaluate(client, _plain_table(), sort=False)
    assert page["script_status"] is None
    assert _keys(page) == THING_IDS


def test_unsorted_default_table_stays_inline(
    client: TestClient, app: FastAPI, seed_thing_model: None
) -> None:
    """collapse + keep_empty + no sort: the whole-table passes never touch the
    snippet, so nothing is pending, no sweep is registered, and the window's
    cells carry real values on the FIRST response."""
    counting = CountingRunner()
    app.dependency_overrides[get_runner] = lambda: counting

    page = _evaluate(client, _script_table(), sort=False)
    assert page["script_status"] == {
        "state": "ready",
        "done": 0,
        "total": None,
        "message": None,
    }
    assert _keys(page) == THING_IDS
    assert [row["cells"][1]["kind"] for row in page["rows"]] == ["value"] * 5
    assert counting.calls == 5  # the visible window really was computed live
    session = get_session()
    assert session.script_sweeps.get(_fingerprint(), session.model_rev) is None


def test_sorted_script_table_while_computing(
    client: TestClient, app: FastAPI, seed_thing_model: None
) -> None:
    """ASYNC sweep parked on an Event: the request must still answer promptly
    with `computing` + BUILD-order rows, while the window itself renders live
    values.

    The fake blocks calls made from the sweep's own daemon thread (named
    `script-sweep`) and answers every other call immediately — that is the
    deterministic sync point, no sleeping and no self-deadlock when the route
    evaluates the visible window with the very same runner object.
    """
    entered = threading.Event()
    proceed = threading.Event()

    def _outcome(i: int, ids: list[str]) -> CallResult:
        if threading.current_thread().name == "script-sweep":
            entered.set()
            proceed.wait(timeout=10.0)
        return _descending_value(i, ids)

    runner = ScriptedRunner(_outcome)
    app.dependency_overrides[get_runner] = lambda: runner

    try:
        page = _evaluate(client, _script_table())
        assert page["script_status"]["state"] == "computing"
        # Degraded: build order, NOT the requested descending-value sort.
        assert _keys(page) == THING_IDS
        # The visible window is still evaluated live, so its cells are real.
        assert [row["cells"][1]["kind"] for row in page["rows"]] == ["value"] * 5
        # The sweep thread really is running behind that `computing`.
        assert entered.wait(timeout=5.0)
    finally:
        proceed.set()  # release the parked call so the daemon thread exits


def test_sorted_script_table_after_sweep(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    settings_sync_sweep: Settings,
) -> None:
    """SYNC sweep: the first response is deliberately asymmetric.

    `kick_or_join_sweep` runs the entire sweep inside the first request, so the
    job is already `done` when the route samples it — but that request's rows
    were built by the cache-only pass BEFORE those values existed, so it reports
    `computing` (never `ready`) and the client polls once more. The SECOND
    request finds every value cached, sorts cleanly, reports `ready`, and
    populates the order cache.
    """
    runner = ScriptedRunner(_descending_value)
    app.dependency_overrides[get_runner] = lambda: runner

    first = _evaluate(client, _script_table())
    status = first["script_status"]
    assert status["state"] == "computing"
    assert status["done"] == status["total"] == 5  # the sync sweep finished
    assert _keys(first) == THING_IDS  # ...but these rows are still build order

    second = _evaluate(client, _script_table())
    assert second["script_status"]["state"] == "ready"
    assert _keys(second) == list(reversed(THING_IDS))  # sorted by script value
    assert [row["cells"][1]["value"] for row in second["rows"]] == [5, 6, 7, 8, 9]

    # Third call with a pristine runner: the order cache serves the sort and the
    # cell cache serves the cells, so the guest is not touched at all.
    fresh = CountingRunner()
    app.dependency_overrides[get_runner] = lambda: fresh
    third = _evaluate(client, _script_table())
    assert third["script_status"]["state"] == "ready"
    assert _keys(third) == list(reversed(THING_IDS))
    assert fresh.calls == 0


def test_failed_sweep_reported_not_rekicked(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    settings_sync_sweep: Settings,
) -> None:
    """A sweep aborted by the consecutive-timeout guard surfaces as
    `state="failed"` with the job's message, and failed-job memory keeps the
    next poll from restarting the grind."""
    runner = ScriptedRunner(lambda i, ids: timeout())
    app.dependency_overrides[get_runner] = lambda: runner
    abort_at = settings_sync_sweep.snippet_sweep_timeout_abort

    first = _evaluate(client, _script_table(), limit=2)
    assert first["script_status"]["state"] == "failed"
    assert "consecutive" in first["script_status"]["message"]
    assert _keys(first) == THING_IDS[:2]
    # sweep aborted at the threshold + the two live window cells
    assert runner.calls[0] == abort_at + 2
    after_first = runner.calls[0]

    second = _evaluate(client, _script_table(), limit=2)
    assert second["script_status"]["state"] == "failed"
    # Only the two live window cells ran again: no second sweep (which would
    # have added another `abort_at` calls).
    assert runner.calls[0] == after_first + 2


def test_runner_unavailable_reports_failed_without_a_sweep(
    client: TestClient, app: FastAPI, seed_thing_model: None
) -> None:
    """No runner at all: there is nothing to sweep with, so the route reports
    `failed` immediately instead of kicking a job that could only fail."""
    app.dependency_overrides[get_runner] = lambda: None

    page = _evaluate(client, _script_table())
    assert page["script_status"] == {
        "state": "failed",
        "done": 0,
        "total": None,
        "message": "script runner unavailable",
    }
    assert _keys(page) == THING_IDS
    session = get_session()
    assert session.script_sweeps.get(_fingerprint(), session.model_rev) is None
