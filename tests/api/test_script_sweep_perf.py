"""Perf regression guards for the embedded-evaluation fast paths.

Opt-in (``pytestmark = pytest.mark.perf``, deselected by the default
``-m "not integration and not perf"`` addopts): these need the fetched
CPython-WASI guest binary AND they measure wall time, so they have no place in
the normal suite.

Three properties are worth a timing/counting test because losing any of them
silently reintroduces the ~49 s whole-table freeze this work removed (or the
per-read bridge chatter that goes with it), with every functional test still
green:

1. **Per-call round-trip.** `ScriptRunner.open_session` exists so a whole-table
   pass pays ONE guest boot and then N cheap calls. A regression that boots per
   call (or re-execs the module per call) is ~100x slower per cell and nothing
   else notices.
2. **Sweep sharding.** The sweep fans its per-cell work across
   `snippet_sweep_workers` threads. A regression that serialises them again —
   an over-broad lock, a shared session, a per-item global-slot acquire — costs
   the whole speedup while every assertion about RESULTS still holds (results
   are identical by design).
3. **Bridge trip collapse.** A one-hop traversal (read the row, follow an
   outgoing relationship, read the far element) should cost ONE bridge
   dispatch per cell, not three: the root rides the call frame (root
   piggyback), the far endpoint rides the hop response (far-endpoint
   inlining on hops), and a repeated read within one call is served from the
   guest's own memo. Losing far-endpoint inlining or the guest memo fails this
   guard; the root piggyback leg is pinned by test_trip_counts.py (see
   test_trips_per_cell_budget).

The bounds in 1-2 are deliberately loose: the numbers on the reference machine
are ~0.3-1 ms/call and a ~3-4x sharding speedup; the assertions are 5 ms/call
and a 0.7x wall-time ratio, so roughly an order of magnitude and 4x of
headroom respectively absorb CI noise, cold caches and shared runners. The
bound in 3 is tighter (1.5 vs. a measured ~1.0 trips/cell) because it counts
discrete dispatches rather than timing wall clock, so it has no noise to
absorb — only enough headroom to not flap on an incidental extra call.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from data_rover.api.script_sweep import kick_or_join_sweep, reset_global_slots
from data_rover.api.session import Session, get_session
from data_rover.api.settings import Settings, get_settings
from data_rover.core.table.schema import TABLE_ADAPTER

from .conftest import AUTH_HEADERS, papi, seed_default_project

if TYPE_CHECKING:
    from data_rover.api.script_runner import WasmScriptRunner

pytestmark = pytest.mark.perf  # timing-based; needs the fetched guest binary

GUEST = "spikes/code_exec/vendor/python.wasm"
LIB = "spikes/code_exec/vendor/lib/python3.14"

#: See `test_script_sweep_wasm.POOL`: 4 sweep workers + the sweep's own serial
#: context must all get an instance, or the run degrades to `unavailable` and
#: measures the wrong thing.
POOL = 6

#: Calls timed by the round-trip budget, after a warm-up.
CALLS = 200
#: Per-call ceiling. Reference machine: ~0.3-0.5 ms.
MAX_MS_PER_CALL = 5.0

#: Rows swept by the sharding guard. Small enough to run twice in a few
#: seconds, big enough that per-cell work dominates thread start-up.
SWEEP_ROWS = 400
#: `workers=4` must beat this fraction of the `workers=1` wall time. Real
#: speedup is ~3-4x (ratio ~0.25-0.35); 0.7 is a loose floor that only a
#: genuinely re-serialised sweep can fail.
MAX_SPEEDUP_RATIO = 0.7

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
relationships:
  - name: Links
    source: Thing
    target: Thing
    source_multiplicity: "0..*"
    target_multiplicity: "0..*"
"""

#: Trivial body: the budget test is measuring the BRIDGE round trip, not the
#: snippet, so the guest-side work must be negligible.
CHEAP_CODE = "def value(els):\n    return els[0]['name']"

#: Deliberately CPU-bound (~ms of guest work per call) so the sharding test
#: measures parallel execution rather than queue and thread overhead.
HEAVY_CODE = (
    "def value(els):\n"
    "    total = 0\n"
    "    for i in range(60000):\n"
    "        total += i * i\n"
    "    return f'{els[0][\"name\"]}:{total}'\n"
)


def _eid(i: int) -> str:
    return f"t{i:04d}"


@pytest.fixture(scope="module")
def wasm_runner() -> Iterator[WasmScriptRunner]:
    if not os.path.exists(GUEST):
        pytest.skip("guest binary not fetched (bash spikes/code_exec/fetch_python_wasi.sh)")
    from data_rover.api.script_runner import WasmScriptRunner

    r = WasmScriptRunner(GUEST, LIB, pool_size=POOL)
    yield r
    r.close()


@pytest.fixture
def app() -> Iterator[FastAPI]:
    seed_default_project()
    application = create_app()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI, wasm_runner: WasmScriptRunner) -> TestClient:
    app.dependency_overrides[get_runner] = lambda: wasm_runner
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


def _seed(client: TestClient, rows: int) -> Session:
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
                {
                    "id": _eid(i),
                    "type_name": "Thing",
                    "properties": {"name": f"N{i:04d}"},
                }
                for i in range(rows)
            ],
            "relationships": [
                {
                    "id": f"r{i:04d}",
                    "type_name": "Links",
                    "source_id": _eid(i),
                    "target_id": _eid((i + 1) % rows),
                    "properties": {},
                }
                for i in range(rows)
            ],
        },
    )
    assert r.status_code == 200, r.text
    return get_session()


@pytest.fixture
def small_model(client: TestClient):
    """A handful of elements is plenty: the round-trip budget calls `value()`
    over the SAME element repeatedly, so the model size is irrelevant."""
    return _seed(client, 8).model


@pytest.fixture
def big_session(client: TestClient) -> Session:
    return _seed(client, SWEEP_ROWS)


def _wait_for_pool(runner: WasmScriptRunner, want: int, timeout_s: float = 60.0) -> None:
    """Block until the background refill thread has `want` warm instances
    parked.

    Reaching into `_pool` is deliberate: the `workers=4` leg needs 4 worker
    contexts plus the serial one to get an instance IMMEDIATELY, and starting
    it against a pool the previous leg just drained would measure boot latency
    instead of parallelism (and, at worst, degrade to `unavailable`).
    """
    deadline = time.monotonic() + timeout_s
    while runner._pool.qsize() < want and time.monotonic() < deadline:
        time.sleep(0.05)


def test_percall_roundtrip_budget(wasm_runner: WasmScriptRunner, small_model) -> None:
    """`CALLS` warm `value()` calls on ONE open session must average under
    `MAX_MS_PER_CALL`.

    The session is booted and warmed OUTSIDE the timed region, so what is
    measured is exactly the per-call bridge round trip — which is the thing a
    "boot a guest per cell" regression would blow up.
    """
    from data_rover.core.script.runner import RunLimits, ScriptBudget

    ids = sorted(small_model.elements)
    sess = wasm_runner.open_session(
        small_model, CHEAP_CODE, RunLimits(), budget=ScriptBudget.start(300)
    )
    try:
        assert sess.boot_error is None, sess.boot_error
        for i in range(20):  # warm-up: first calls pay lazy import/JIT costs
            assert sess.call("value", [ids[i % len(ids)]]).error is None

        t0 = time.perf_counter()
        for i in range(CALLS):
            res = sess.call("value", [ids[i % len(ids)]])
            assert res.error is None, res.error
        elapsed = time.perf_counter() - t0
    finally:
        sess.close()

    per_call_ms = elapsed * 1000 / CALLS
    print(f"\nper-call round trip: {per_call_ms:.3f} ms ({CALLS} calls in {elapsed:.3f}s)")
    assert per_call_ms < MAX_MS_PER_CALL, (
        f"per-call round trip regressed to {per_call_ms:.2f} ms "
        f"(budget {MAX_MS_PER_CALL} ms) — a per-call guest boot?"
    )


def _table() -> dict[str, Any]:
    return {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [
            {"kind": "element"},
            {"kind": "script", "snippet": {"definition": {"code": HEAVY_CODE}}},
        ],
    }


def _cold_sweep_setup(
    session: Session,
    runner: WasmScriptRunner,
    workers: int,
    monkeypatch: pytest.MonkeyPatch,
) -> Settings:
    """Shared cold-sweep ritual: force sync sweeping at `workers`, drop the
    lazily-sized process-wide sweep semaphore so the new worker count actually
    takes effect, and reset the per-session cache/order/job state so the sweep
    that follows is genuinely cold (no reused cache, no remembered job).

    Also waits for the pool to have `workers + 1` warm instances parked (the
    `workers` sweep contexts plus the sweep's own serial context all need one
    immediately, or the run degrades to `unavailable` and measures the wrong
    thing) — see `_wait_for_pool`.
    """
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_WORKERS", str(workers))
    settings: Settings = get_settings()
    assert settings.snippet_sweep_sync is True
    assert settings.snippet_sweep_workers == workers
    # The process-wide sweep semaphore is sized lazily from settings on first
    # use; drop it so this leg's worker count actually takes effect.
    reset_global_slots()
    # Cold cache + no remembered job, without reloading the model.
    session.table_order_cache.clear()
    session.script_cell_cache.clear_and_stamp(session.model_rev)
    session.script_sweeps.cancel_all()
    _wait_for_pool(runner, min(POOL, workers + 1))
    return settings


def _time_sweep(
    session: Session,
    runner: WasmScriptRunner,
    workers: int,
    monkeypatch: pytest.MonkeyPatch,
) -> float:
    """Run ONE cold sweep of the heavy table at `workers` and return its wall
    time. `snippet_sweep_sync` makes `kick_or_join_sweep` run the job inline, so
    the measurement needs no polling and no sleeping."""
    settings = _cold_sweep_setup(session, runner, workers, monkeypatch)

    defn = TABLE_ADAPTER.validate_python(_table())
    assert session.metamodel is not None and session.model is not None
    t0 = time.perf_counter()
    job = kick_or_join_sweep(
        session,
        session.metamodel,
        session.model,
        defn,
        runner,
        settings,
        session.model_rev,
    )
    elapsed = time.perf_counter() - t0
    assert job.state == "done", (job.state, job.message)
    assert job.done == SWEEP_ROWS, job.done
    assert session.script_cell_cache.size == SWEEP_ROWS
    return elapsed


def test_parallel_sweep_speedup(
    wasm_runner: WasmScriptRunner,
    big_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A `workers=4` sweep of `SWEEP_ROWS` heavy cells must finish in under
    `MAX_SPEEDUP_RATIO` of the `workers=1` wall time."""
    serial = _time_sweep(big_session, wasm_runner, 1, monkeypatch)
    sharded = _time_sweep(big_session, wasm_runner, 4, monkeypatch)
    ratio = sharded / serial
    print(
        f"\nsweep of {SWEEP_ROWS} heavy cells: workers=1 {serial:.2f}s, "
        f"workers=4 {sharded:.2f}s, ratio {ratio:.2f} (budget < {MAX_SPEEDUP_RATIO})"
    )
    assert ratio < MAX_SPEEDUP_RATIO, (
        f"sharded sweep took {ratio:.2f}x the serial wall time "
        f"({sharded:.2f}s vs {serial:.2f}s) — is the fan-out serialised?"
    )


#: Traversal snippet for the trips-per-cell guard: one hop plus a far-element
#: read per row. Post trip-collapse this costs exactly ONE dispatch per cell
#: (the hop); the far endpoints ride the hop response and the root rides the
#: call frame. Budget 1.5 leaves a little headroom over the measured 1.0/cell,
#: not room for a per-read regression (which would cost 2+ extra trips per
#: cell) — see `big_session`'s ring of `Links` edges, without which
#: `els[0].outgoing()` is always empty and this snippet never exercises a hop at
#: all — though on this ring the root is also memo-primed by the previous
#: row's hop; see the test docstring.
TRAVERSAL_CODE = (
    "def value(els):\n"
    "    n = els[0]['name']\n"
    "    for rel in els[0].outgoing():\n"
    "        n = n + rel.destination()['name']\n"
    "    return n\n"
)
MAX_TRIPS_PER_CELL = 1.5


def test_trips_per_cell_budget(
    wasm_runner: WasmScriptRunner,
    big_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sweep of `SWEEP_ROWS` one-hop traversal cells must average under
    `MAX_TRIPS_PER_CELL` bridge dispatches per cell.

    This is the regression guard for the trip-collapse work: root piggyback
    (the row's own element data rides the call frame instead of a separate
    `dr.element` round trip), the guest-side read memo (a repeated
    `dr.element` read within one call is served from the guest's own cache),
    and far-endpoint inlining on hops (the related element's data rides the
    `outgoing()` response itself, so the `rel.destination()` read below is a
    memo hit rather than a bridge dispatch).

    Mutation-probed: disabling the read memo costs 3.0 trips/cell and disabling
    far-endpoint inlining costs 2.0 — both fail this budget. Disabling the ROOT
    PIGGYBACK alone measures 1.0025 and PASSES, because the ring means row i's
    hop response inlines row i+1's element and thereby primes its root; only
    row 0 pays a fetch. That leg is pinned instead by
    tests/script/test_trip_counts.py::test_root_piggyback_zero_trips_for_property_math
    and tests/api/test_snippets_wasm.py::test_embedded_session_trip_collapse_wasm
    (exact `calls == ["outgoing"]`). To bring it under THIS guard, retarget the
    edges at a non-row element type.

    `workers=1` here (unlike the sharding test) so the module-global `count`
    list below is a safe, uncontended counter — if this ever runs with
    `workers > 1` the increment needs a lock.
    """
    from data_rover.core.script.bridge import BridgeDispatcher

    count = [0]  # safe only because workers=1 below: single-threaded sweep
    orig = BridgeDispatcher.dispatch

    def counting(self, req):  # type: ignore[no-untyped-def]
        count[0] += 1
        return orig(self, req)

    monkeypatch.setattr(BridgeDispatcher, "dispatch", counting)
    settings = _cold_sweep_setup(big_session, wasm_runner, 1, monkeypatch)

    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Thing"]},
            "columns": [
                {"kind": "element"},
                {"kind": "script", "snippet": {"definition": {"code": TRAVERSAL_CODE}}},
            ],
        }
    )
    assert big_session.metamodel is not None and big_session.model is not None
    job = kick_or_join_sweep(
        big_session,
        big_session.metamodel,
        big_session.model,
        defn,
        wasm_runner,
        settings,
        big_session.model_rev,
    )
    assert job.state == "done", (job.state, job.message)
    per_cell = count[0] / SWEEP_ROWS
    print(f"\nbridge trips per cell: {per_cell:.2f} ({count[0]} trips / {SWEEP_ROWS} cells)")
    assert per_cell < MAX_TRIPS_PER_CELL, (
        f"{per_cell:.2f} bridge trips/cell (budget {MAX_TRIPS_PER_CELL}) — "
        f"{count[0]} trips over {SWEEP_ROWS} cells — lost the far-endpoint inline, or the guest read memo?"
    )
