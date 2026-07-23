"""POST /tables/script-errors — the per-table script-error recap
(2026-07-23 spec §4). Cache-only like export: 202 + Retry-After while the
sweep computes; 200 with the collected ErrorCells once settled; pending
cells after a terminal sweep count as errors ("not computed").

Fixtures mirror `test_tables_script_status.py` (separate `app`/`client` so the
runner can be swapped through `dependency_overrides`, the `_script_fakes.py`
runner doubles, and the `DATA_ROVER_SNIPPET_SWEEP_SYNC` pinning idiom), with
one deliberate difference: the seeded elements carry `name == id`, so
`display_name` — and therefore an error item's `row_label` — reads `t2`
rather than an opaque `N1`.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from data_rover.api.settings import Settings, get_settings
from data_rover.core.script.runner import CallResult, ScriptError

from ._script_fakes import BlockingRunner, ScriptedRunner, ok, timeout
from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""

VALUE_CODE = "def value(els): return 1"

#: Five elements, `t1`..`t5` in scope (build) order.
THING_IDS = ["t1", "t2", "t3", "t4", "t5"]

#: Position of the script column in `TABLE_DEFN["columns"]` — the value an
#: error item's `column_index` must carry.
SCRIPT_COL_INDEX = 1

#: Element column + a COLLAPSE script column. `keep_empty` defaults True, so an
#: UNSORTED evaluation never calls the snippet during the whole-table passes —
#: only cell rendering (or a sort on column 1) does.
TABLE_DEFN: dict = {
    "row_source": {"kind": "scope", "types": ["Thing"]},
    "columns": [
        {"kind": "element"},
        {"kind": "script", "snippet": {"definition": {"code": VALUE_CODE}}},
    ],
}


def err(message: str = "boom") -> CallResult:
    """A DETERMINISTIC (`runtime`) call failure — the only error family
    `ScriptCellCache.put` stores, which is what makes it visible to the
    recap's cache-only pass on a later request."""
    return CallResult(
        value=None, error=ScriptError(kind="runtime", message=message), duration_ms=0
    )


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
def viewer_headers(client: TestClient) -> dict[str, str]:
    """A membership with role=viewer on the default project (mirrors
    test_tables_routes.py::test_viewer_can_evaluate_not_create)."""
    from data_rover.api import tenancy
    from data_rover.api.db import db_session
    from data_rover.api.db_models import Role

    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(
            s, project_id="default", user_id="viewer-1", role=Role.viewer
        )
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


@pytest.fixture
def seed_thing_model(client: TestClient) -> None:
    """`Thing` metamodel + five `Thing` elements whose `name` IS their id, so
    `display_name` (and therefore `row_label`) reads `t1`..`t5`."""
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
                {"id": tid, "type_name": "Thing", "properties": {"name": tid}}
                for tid in THING_IDS
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text


@pytest.fixture
def settings_sync_sweep(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Pin `snippet_sweep_sync=True` + `snippet_sweep_workers=1` (env var and a
    fresh `get_settings()`, asserting the flags took) exactly the way
    `test_tables_script_status.py` does, so the sweep runs inline on the
    request thread and the tests below observe a settled job with no sleeping
    and no scheduling-dependent call indices."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_WORKERS", "1")
    settings = get_settings()
    assert settings.snippet_sweep_sync is True
    assert settings.snippet_sweep_workers == 1
    return settings


def _evaluate(client: TestClient, *, sort: bool = False, limit: int = 100) -> dict:
    body: dict = {"definition": TABLE_DEFN, "limit": limit}
    if sort:
        body["sort"] = {"column": SCRIPT_COL_INDEX, "direction": "asc"}
    r = client.post(papi("/tables/evaluate"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


def _evaluate_until_ready(client: TestClient, *, sort: bool = False) -> dict:
    """Poll `/tables/evaluate` the way the grid does until the script status
    settles (`ready`/`failed`, or `None` for a script-free table). Returns the
    last page, so a test can compare its row order against the recap's
    `row_index`."""
    page = _evaluate(client, sort=sort)
    for _ in range(10):
        status = page["script_status"]
        if status is None or status["state"] != "computing":
            return page
        page = _evaluate(client, sort=sort)
    raise AssertionError("script status never settled")


def _recap(
    client: TestClient, *, sort: bool = False, headers: dict[str, str] | None = None
) -> httpx.Response:
    body: dict = {"definition": TABLE_DEFN}
    if sort:
        body["sort"] = {"column": SCRIPT_COL_INDEX, "direction": "asc"}
    return client.post(
        papi("/tables/script-errors"), json=body, headers=headers or AUTH_HEADERS
    )


def _descending_value(_i: int, ids: list[str]) -> CallResult:
    """`t1`->9 … `t5`->5, so an ASCENDING sort on the script column is the
    exact REVERSE of the build order — the two can never be confused."""
    return ok(10 - int(ids[0][1:]))


def test_script_errors_empty_when_all_ok(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    settings_sync_sweep: Settings,
) -> None:
    """Every cell computes: the recap is empty, and it says so in the exact
    wire shape Task 6 consumes."""
    app.dependency_overrides[get_runner] = lambda: ScriptedRunner(lambda i, ids: ok(1))

    page = _evaluate_until_ready(client)
    # Self-standing guard: an EMPTY recap is byte-identical to the body the
    # `script_ctx is None` early return emits, so on its own the assertion
    # below would also pass if the whole-table pass never ran. Pin that this
    # definition really does carry script work -- `table_has_script(defn)` is
    # what gates that early return, and a rendered script cell proves it True.
    assert page["script_status"] is not None
    assert page["rows"][0]["cells"][SCRIPT_COL_INDEX]["kind"] == "value"

    r = _recap(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "state": "ready",
        "errors": [],
        "total_errors": 0,
        "truncated": False,
    }


def test_script_errors_lists_failed_cells(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    settings_sync_sweep: Settings,
) -> None:
    """One failing cell out of five, addressable by grid position."""
    runner = ScriptedRunner(lambda i, ids: err("boom") if ids[0] == "t2" else ok(1))
    app.dependency_overrides[get_runner] = lambda: runner

    _evaluate_until_ready(client)
    r = _recap(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_errors"] == 1 and not body["truncated"]
    (item,) = body["errors"]
    assert item["row_label"] == "t2"
    assert item["row_element_id"] == "t2"
    assert item["row_index"] == THING_IDS.index("t2")
    assert item["column_index"] == SCRIPT_COL_INDEX
    assert item["message"] == "boom"


def test_script_errors_row_index_addresses_the_same_row_the_grid_shows(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    settings_sync_sweep: Settings,
) -> None:
    """THE jump-to-cell contract: `row_index` is an index into the order the
    GRID renders, not into build order.

    Sorted ascending on the script column, `t1`->9 … `t5`->5 gives
    `[t5, t4, t3, t1]` with the errored `t2` last (an errored `_sort_value` is
    "empty", and empties always sort last). Build order `[t1..t5]` and sorted
    order disagree about `t2`'s position (1 vs 4), so indexing the settled
    page by the recap's `row_index` can only land on `t2` if the recap
    forwarded the same sort the grid did.
    """
    runner = ScriptedRunner(
        lambda i, ids: err("boom") if ids[0] == "t2" else _descending_value(i, ids)
    )
    app.dependency_overrides[get_runner] = lambda: runner

    page = _evaluate_until_ready(client, sort=True)
    assert page["script_status"]["state"] == "ready"
    grid_order = [row["key"][0] for row in page["rows"]]
    assert grid_order == ["t5", "t4", "t3", "t1", "t2"]  # NOT build order

    r = _recap(client, sort=True)
    assert r.status_code == 200, r.text
    (item,) = r.json()["errors"]
    assert item["row_index"] == 4
    assert page["rows"][item["row_index"]]["key"][0] == "t2"


def test_script_errors_202_while_computing(
    client: TestClient, app: FastAPI, seed_thing_model: None
) -> None:
    """An ASYNC sweep parked on an Event: the recap must not block and must not
    guess — 202 + `Retry-After: 1` + a `computing` body, exactly like export.
    The status CODE is the retry signal."""
    runner = BlockingRunner()
    app.dependency_overrides[get_runner] = lambda: runner

    try:
        r = _recap(client)
        assert r.status_code == 202, r.text
        assert r.headers["retry-after"] == "1"
        assert r.json()["state"] == "computing"
        assert runner.entered.wait(timeout=5.0)  # a sweep really is behind it
    finally:
        runner.proceed.set()
        for t in threading.enumerate():
            if t.name.startswith("script-sweep"):
                t.join(timeout=10.0)
                assert not t.is_alive()


def test_script_errors_pending_after_terminal_sweep_counts_as_error(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    settings_sync_sweep: Settings,
) -> None:
    """A cell the sweep can never cache is an error item ("not computed"), not
    another 202: failed-job memory hands the same dead job back at this rev
    forever, so retrying would loop the client for the life of the rev.

    Driving the sweep to its terminal state is the setup
    `test_tables_script_status.py::test_failed_sweep_reported_not_rekicked`
    uses: SORT on the script column (an unsorted `keep_empty` collapse column
    is invisible to the whole-table passes, so nothing would go pending and no
    sweep would be kicked at all) plus `limit=2`, so the two visible rows are
    evaluated LIVE — their timeouts are never cached — and the sweep behind
    them trips the consecutive-timeout abort guard.
    """
    app.dependency_overrides[get_runner] = lambda: ScriptedRunner(
        lambda i, ids: timeout()
    )

    page = _evaluate(client, sort=True, limit=2)
    assert page["script_status"]["state"] == "failed"  # terminal sweep

    r = _recap(client)
    assert r.status_code == 200, r.text  # NOT 202: retry would never help
    body = r.json()
    assert body["total_errors"] > 0
    assert any("not computed" in e["message"] for e in body["errors"])


def test_script_errors_cap_truncates(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    settings_sync_sweep: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The list is capped; `total_errors` still reports the full count."""
    monkeypatch.setattr("data_rover.api.routes.tables.SCRIPT_ERRORS_CAP", 2)
    app.dependency_overrides[get_runner] = lambda: ScriptedRunner(
        lambda i, ids: err("boom")
    )

    _evaluate_until_ready(client)
    r = _recap(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_errors"] == len(THING_IDS)
    assert len(body["errors"]) == 2 and body["truncated"] is True


def test_script_errors_is_viewer_callable(
    client: TestClient,
    app: FastAPI,
    seed_thing_model: None,
    viewer_headers: dict[str, str],
) -> None:
    """role=viewer must not 403: the suffix is in `authz._READ_ONLY_POST_SUFFIXES`
    alongside `/tables/evaluate` and `/tables/export`."""
    app.dependency_overrides[get_runner] = lambda: None

    r = _recap(client, headers=viewer_headers)
    assert r.status_code in (200, 202), r.text
