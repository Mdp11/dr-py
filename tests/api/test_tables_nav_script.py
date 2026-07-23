"""End-to-end: a navigation with a `ScriptStep` used as a table's ROW SOURCE,
over HTTP (`POST /tables/evaluate`).

This is the exact scenario the 2026-07-23 spec's bug report covered. The table
evaluator used to call `evaluate()` on the row source's navigation WITHOUT the
request's `ScriptEvalContext`, so `_hop_script` took its `script is None`
branch and pruned every chain SILENTLY: zero rows, no warning, and
`script_status: ready` on every poll — indistinguishable from "this navigation
genuinely reaches nothing". Both tests below fail (0 rows / no warning) if that
threading is removed again.

WHY EACH TEST POLLS TWICE — the Phase B (spec 2026-07-20 §4.1-4.3) contract,
which a nav script step rides exactly like a script column:

  poll 1  The route's whole-table `build_rows_ex` pass runs CACHE-ONLY, so the
          step's `call(code, "step", [id])` misses the session cell cache and
          synthesizes a `pending` result. `_hop_script` treats every error kind
          alike and prunes with a warning — here the synthetic
          "script step failed: not computed yet". Rows are empty,
          `pending_misses > 0`, and the route kicks a background `SweepJob`.

  the fill  `script_sweep._run_inner`'s SERIAL PREFIX — `build_rows_ex(...,
          script=ctx)` with a context that is NOT cache-only — is what fills
          the step cells. It is a full live row build, so it necessarily drives
          every `step()` call the row source needs, and `ScriptEvalContext.call`
          writes each `(sha256(code), "step", (element_id,))` result into the
          session's `ScriptCellCache`. (The sweep's own script-COLUMN
          enumeration that follows is irrelevant here — this table has no
          script column at all.) `test_..._row_source_over_http` asserts that
          cache entry directly, so the mechanism is pinned, not just its
          outcome.

  poll 2  The cache-only build now HITS for every step call: real rows,
          `script_status: ready`, no warnings.

`settings_sync_sweep` pins `DATA_ROVER_SNIPPET_SWEEP_SYNC` the way
`test_tables_script_status.py` does, so the sweep runs inline inside poll 1 and
poll 2 is deterministic — with the default threaded sweep the same sequence
works, but only by racing a daemon thread.

Fixture idiom follows `test_script_embedding_routes.py` / `test_tables_script_
status.py`: a separate `app`/`client` pair so `get_runner` stays swappable
through `dependency_overrides`.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from data_rover.api.session import get_session
from data_rover.api.settings import Settings, get_settings
from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""

#: Seeded with explicit ids so a snippet can name one of them literally.
THING_IDS = ["t1", "t2", "t3"]

#: `step()` that hops every Thing except `t1` ONTO `t1`; `t1` itself ends its
#: chain. The row source projects the terminal step, so the reachable row set is
#: exactly `{t1}` — one row, and a row that is NOT simply "the start scope",
#: which a silently-pruned navigation could never be confused with.
STEP_CODE = "def step(el):\n    return [] if el.id == 't1' else ['t1']\n"

#: `step()` that raises per element: every chain prunes, and the failure must
#: reach the page's `warnings` rather than vanishing.
BOOM_CODE = "def step(el):\n    return 1 / 0\n"


@pytest.fixture
def app() -> Iterator[FastAPI]:
    seed_default_project()
    application = create_app()
    application.dependency_overrides[get_runner] = lambda: TrustedRunner()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def seed_things(client: TestClient) -> list[str]:
    """`Thing` metamodel + three `Thing` elements with pinned ids, loaded
    through the HTTP routes so the session the requests hit is the seeded one."""
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
                {"id": tid, "type_name": "Thing", "properties": {"name": tid.upper()}}
                for tid in THING_IDS
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    return list(THING_IDS)


@pytest.fixture
def settings_sync_sweep(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Pin `snippet_sweep_sync=True` (env var + fresh `get_settings()`, exactly
    as `test_tables_script_status.py` does) so `kick_or_join_sweep` runs the
    whole sweep inline inside the request that kicks it — the second poll below
    is then deterministic instead of racing a daemon thread."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    settings = get_settings()
    assert settings.snippet_sweep_sync is True
    return settings


def _nav_table(code: str) -> dict:
    """A table whose ROW SOURCE is a one-script-step navigation over every
    `Thing`. No script COLUMN anywhere: the only snippet work this definition
    can produce comes from the navigation's `ScriptStep`, so an empty page can
    only mean the step never ran."""
    return {
        "row_source": {
            "kind": "navigation",
            "navigation": {
                "definition": {
                    "kind": "path",
                    "start": {"kind": "scope", "types": ["Thing"]},
                    "steps": [
                        {"kind": "script", "snippet": {"definition": {"code": code}}}
                    ],
                }
            },
        },
        "columns": [{"kind": "element"}],
    }


def _evaluate(client: TestClient, code: str) -> dict:
    r = client.post(papi("/tables/evaluate"), json={"definition": _nav_table(code)})
    assert r.status_code == 200, r.text
    return r.json()


def _step_cell_key(code: str, element_id: str) -> tuple[str, str, tuple[str, ...]]:
    """The `ScriptCellCache` key a `step()` call on one element writes under —
    `ScriptEvalContext._cell_key`'s shape, with the "step" entry point."""
    return (hashlib.sha256(code.encode()).hexdigest(), "step", (element_id,))


def test_nav_script_step_row_source_over_http(
    client: TestClient, seed_things: list[str], settings_sync_sweep: Settings
) -> None:
    """THE happy path: a navigation script step really does produce table rows
    over HTTP — on the second poll, per the Phase B contract in the module
    docstring.

    Reverting the row-source threading (`_navigation_row_keys` calling
    `evaluate()` without `script=`) makes BOTH polls return 0 rows with no
    warning and `ready` forever — the original bug — so every assertion here is
    discriminating."""
    session = get_session()
    rev = session.model_rev

    # Poll 1: the cache-only whole-table build cannot run the step yet.
    first = _evaluate(client, STEP_CODE)
    assert first["rows"] == []
    assert first["total"] == 0
    assert first["script_status"]["state"] == "computing"
    assert first["warnings"] == ["script step failed: not computed yet"]

    # THE MECHANISM: the sweep's serial row build ran the step LIVE and wrote
    # its result into the session cell cache under the "step" entry point.
    # `t2` is a real hop (`t1` ends its own chain), so its entry can only exist
    # because a navigation step call was computed and cached.
    cached = session.script_cell_cache.get(_step_cell_key(STEP_CODE, "t2"), rev)
    assert cached is not None and cached.error is None

    # Poll 2: every step call hits that cache, so the row set is the real one.
    second = _evaluate(client, STEP_CODE)
    assert second["script_status"]["state"] == "ready"
    assert second["warnings"] == []
    assert second["total"] == 1
    # `t1` is what every other Thing hops onto — NOT the start scope, so this
    # cannot be satisfied by a navigation that pruned back to its own roots.
    assert [row["key"][0] for row in second["rows"]] == ["t1"]
    assert second["rows"][0]["cells"][0]["item"]["id"] == "t1"


def test_nav_script_step_error_surfaces_in_page_warnings(
    client: TestClient, seed_things: list[str], settings_sync_sweep: Settings
) -> None:
    """A step that raises prunes its chains (degraded, never a 5xx) and the
    REAL failure reaches `warnings`.

    The assertion deliberately matches the snippet's own exception rather than
    the bare "script step failed" prefix: poll 1 carries the synthetic
    "script step failed: not computed yet" too, so a prefix-only check would
    pass on the cache-only placeholder and prove nothing about the snippet ever
    having run. With the threading reverted `warnings` is empty on every poll.
    """
    first = _evaluate(client, BOOM_CODE)
    assert first["rows"] == []
    # Poll 1 sees the cache-only placeholder AND — via the route's terminal-job
    # re-probe, which re-reads the now sweep-filled cache — the real error.
    assert "script step failed: not computed yet" in first["warnings"]

    second = _evaluate(client, BOOM_CODE)
    assert second["total"] == 0
    assert second["rows"] == []
    # The error is deterministic, so the sweep cached it: settled state is the
    # real message alone, and the page stops asking the client to poll.
    assert second["script_status"]["state"] == "ready"
    assert second["warnings"] == [
        "script step failed: ZeroDivisionError: division by zero"
    ]


# ---------------------------------------------------------------------------
# SORTING by a navigation column that carries a script step.
#
# The row-source case above settles because the SWEEP's serial row build fills
# the step cells. A SORT has no such backstop: `script_sweep._run_inner` never
# calls `order_rows`, and its fan-out only computes ScriptColumn `value()`
# calls, so a `step()` cell that only the sort needs is never filled by
# anything. Forwarding the script context into the cache-only sort therefore
# produced a page that was permanently `failed` — degraded to build order, with
# the client polling once a second for the life of the rev and the sort never
# applying anyway. The evaluator now falls back (empty reached set, every row
# ties) and warns instead.
# ---------------------------------------------------------------------------

#: `step()` that hops each Thing onto the next one, so row t1 reaches t2, t2
#: reaches t3, t3 reaches t1. With names T1/T2/T3 the reached-label sort is
#: t3 ("T1"), t1 ("T2"), t2 ("T3") — a real reordering, so a degraded sort is
#: visibly distinguishable from a working one.
ROTATE_CODE = (
    "def step(el):\n"
    "    order = ['t1', 't2', 't3']\n"
    "    i = order.index(el.id)\n"
    "    return [order[(i + 1) % len(order)]]\n"
)


def _nav_column_table(code: str) -> dict:
    """Scope row source + a COLLAPSE navigation column whose one step is a
    script step. Nothing else in the definition can produce snippet work."""
    return {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [
            {"kind": "element"},
            {
                "kind": "navigation",
                "navigation": {
                    "definition": {
                        "kind": "path",
                        "start": {"kind": "row"},
                        "steps": [
                            {
                                "kind": "script",
                                "snippet": {"definition": {"code": code}},
                            }
                        ],
                    }
                },
            },
        ],
    }


def test_sort_by_nav_script_step_column_settles_instead_of_failing(
    client: TestClient, seed_things: list[str], settings_sync_sweep: Settings
) -> None:
    """Sorting by a script-step navigation column must SETTLE, not stick at
    `failed`.

    Against the pre-fix code this test fails on the very first assertion: the
    cache-only `order_rows` pass drove `step()` for every row, every call missed
    the cell cache, the route degraded + kicked a sweep that cannot fill a
    sort-driven step cell, the re-probe missed again, and the page reported
    `script_status: failed` — on this poll and on every later one.

    `limit: 2` is load-bearing. The visible window IS evaluated live, so a table
    small enough to fit entirely on one page used to have its off-window
    problem masked: poll 1's window pass cached every step cell and poll 2's
    sort found them all. With one row left off the window that row's step cell
    is never computed by anything — the permanently-`failed` shape a real
    (50 000-row) table always had."""
    payload = {
        "definition": _nav_column_table(ROTATE_CODE),
        "sort": {"column": 1, "direction": "asc"},
        "limit": 2,
    }
    r = client.post(papi("/tables/evaluate"), json=payload)
    assert r.status_code == 200, r.text
    first = r.json()

    # SETTLED on the first poll: nothing pending, so nothing to poll for.
    assert first["script_status"]["state"] == "ready"
    assert first["total"] == 3
    # Degraded to BUILD order (the scope's own id order), and the user is told.
    assert [row["key"][0] for row in first["rows"]] == ["t1", "t2"]
    assert any("build order" in w for w in first["warnings"])

    # The page still WORKS: the visible window is evaluated live, so the
    # navigation column's cells hold the real script-step results.
    nav_cells = [row["cells"][1] for row in first["rows"]]
    assert [[i["id"] for i in c["items"]] for c in nav_cells] == [["t2"], ["t3"]]

    # No poll storm: a second identical request is `ready` too (this one is
    # served from the row-order cache, which is why it carries no warning —
    # the degraded order is deterministic at this rev, so caching it is sound).
    r = client.post(papi("/tables/evaluate"), json=payload)
    assert r.status_code == 200, r.text
    second = r.json()
    assert second["script_status"]["state"] == "ready"
    assert [row["key"][0] for row in second["rows"]] == ["t1", "t2"]


#: `value()` for the script column below: the name of whatever the navigation
#: column reached for this row. Sorting on it is a REAL reordering (t1 -> "T2",
#: t2 -> "T3", t3 -> "T1", so ascending is t3, t1, t2), so a degraded sort is
#: immediately distinguishable from a working one.
REACHED_NAME_CODE = "def value(els): return els[0].name if els else None\n"


def _nav_then_script_column_table(step_code: str, value_code: str) -> dict:
    """`[element, collapse navigation with a script step, script column sourced
    from that navigation column]` — the shape the SWEEP covers end to end."""
    table = _nav_column_table(step_code)
    table["columns"].append(
        {
            "kind": "script",
            "source": {"kind": "column", "index": 1},
            "snippet": {"definition": {"code": value_code}},
        }
    )
    return table


def test_sort_by_script_column_over_nav_script_step_converges(
    client: TestClient, seed_things: list[str], settings_sync_sweep: Settings
) -> None:
    """Sorting by a script COLUMN whose source is a script-step navigation
    column must PEND and then CONVERGE — it must not be degraded away.

    This is the shape `script_sweep._run_inner` covers end to end: it resolves
    every collapse script column's `source` LIVE, once per built row, to
    enumerate its `value()` work — and that resolution drives (and caches) the
    navigation's `step()` calls on the way. So one sweep round fills BOTH the
    step cells and the value cells, and the next poll sorts for real.

    Degrading it instead is strictly worse than the bug the fallback was
    written for: the degrade records no pending miss, so the page reports
    `ready`, never kicks a sweep, and ties every row for the life of the rev —
    a sort that can never converge, rather than one that converges next poll.
    """
    payload = {
        "definition": _nav_then_script_column_table(ROTATE_CODE, REACHED_NAME_CODE),
        "sort": {"column": 2, "direction": "asc"},
        "limit": 2,
    }
    r = client.post(papi("/tables/evaluate"), json=payload)
    assert r.status_code == 200, r.text
    first = r.json()
    # Poll 1 pends (which is what KICKS the sweep) rather than silently tying.
    assert first["script_status"]["state"] == "computing"
    assert not any("build order" in w for w in first["warnings"])

    r = client.post(papi("/tables/evaluate"), json=payload)
    assert r.status_code == 200, r.text
    second = r.json()
    # Poll 2: the sweep filled both layers, so the sort is the REAL one
    # (t3 "T1" < t1 "T2" < t2 "T3"), not build order (t1, t2, t3).
    assert second["script_status"]["state"] == "ready"
    assert second["total"] == 3
    assert [row["key"][0] for row in second["rows"]] == ["t3", "t1"]
    assert second["warnings"] == []


# ---------------------------------------------------------------------------
# read-only entry mapping (Task 7): script_runner.open_session's
# record_ops=False -- SECURITY TRIPWIRE, see the Task 7 brief. A script
# COLUMN's `value()` is embedded evaluation: it must never be able to record
# an op, so a write attempt renders as an error cell (degraded-never-failing)
# and the model is left untouched.
# ---------------------------------------------------------------------------


def test_table_script_column_write_attempt_is_error_cell(
    client: TestClient, seed_things: list[str]
) -> None:
    """End-to-end pin of the embedded read-only guarantee: a script COLUMN
    whose snippet writes renders an error cell and mutates nothing.

    No sort / no sync-sweep fixture needed: the visible window's cells are
    always evaluated LIVE (routes/tables.py resets `script_ctx.cache_only =
    False` before rendering the window — see `test_unsorted_default_table_
    stays_inline` in test_tables_script_status.py), so the write attempt's
    `ReadOnlyError` surfaces on the very first request."""
    write_code = "def value(els):\n    return dr.create('Thing', {})"
    defn = {
        "row_source": {"kind": "scope", "types": []},
        "columns": [
            {"kind": "element"},
            {"kind": "script", "snippet": {"definition": {"code": write_code}}},
        ],
    }
    r = client.post(papi("/tables/evaluate"), json={"definition": defn})
    assert r.status_code == 200, r.text
    body = r.json()
    error_cells = [
        c for row in body["rows"] for c in row["cells"] if c["kind"] == "error"
    ]
    assert error_cells and len(error_cells) == len(seed_things)
    assert all("ReadOnly" in (c["message"] or "") for c in error_cells)

    r = client.get(papi("/model/elements"), params={"limit": 100})
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == len(seed_things)
