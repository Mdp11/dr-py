"""SweepJob lifecycle against TrustedRunner-style fakes (spec 2026-07-20 §4.3).

Uses the shared fakes in `tests/api/_script_fakes.py`: `CountingRunner` (all
calls succeed), `ScriptedRunner` (per-call-INDEX outcome, so timeout sequences
are deterministic) and `BlockingRunner` (every call parks on an Event, so the
async cancel/evict cases synchronize deterministically instead of sleeping).

Sync mode is pinned exactly the way `tests/api/conftest.py` pins
`validation_sweep_sync` — an env var read through `get_settings()` — via the
local `settings_sync_sweep` fixture. In sync mode `kick_or_join_sweep` runs the
whole sweep inline, so every assertion below observes a finished job.

That fixture ALSO pins `snippet_sweep_workers=1`: index-scripted outcome
sequences and exact call counts are only meaningful under serial execution.
The `test_parallel_*` block at the bottom opts back into the fan-out (and uses
`BarrierRunner` to synchronize on it deterministically).
"""

from __future__ import annotations

import threading

import pytest

from data_rover.api.script_sweep import (
    ScriptSweepRegistry,
    SweepJob,
    kick_or_join_sweep,
)
from data_rover.api.session import Session, SessionRegistry
from data_rover.api.settings import Settings, get_settings
from data_rover.api.table_cache import table_fingerprint
from data_rover.api.validation_sweep import SweepProgress
from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.evaluate import SortSpec, build_rows_ex, order_rows
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    ElementColumn,
    ScopeRows,
    ScriptColumn,
    TableDefinition,
)

from ._script_fakes import (
    BarrierRunner,
    BlockingRunner,
    CountingRunner,
    ScriptedRunner,
    UnavailableRunner,
    ok,
    timeout,
)

VALUE_CODE = "def value(els): return len(els)"


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="name", datatype="string")]
            )
        ]
    )


def _model(n: int) -> Model:
    """A model of `n` Block elements with deterministic display names."""
    mm = _mm()
    model = Model(mm)
    for i in range(n):
        el = model.create_element("Block")
        model.set_property(el, "name", f"Block {i:02d}")
    return model


def _defn() -> TableDefinition:
    """Scope table: an element column + a COLLAPSE script column. `keep_empty`
    defaults True, so `build_rows_ex` itself never calls the snippet — the
    sweep's per-row loop is what exercises the guest."""
    return TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ElementColumn(),
            ScriptColumn(
                snippet=SnippetSource(definition=SnippetDefinition(code=VALUE_CODE))
            ),
        ],
    )


def _session_with(model: Model) -> Session:
    """A bare Session wired to `model` at rev 0 (the cell cache's initial stamp
    is 0, so rev-0 writes are readable)."""
    return Session(metamodel=model.metamodel, model=model)


@pytest.fixture
def settings_sync_sweep(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Pin `snippet_sweep_sync=True` the same way conftest pins
    `validation_sweep_sync`: an env var, then a fresh `get_settings()`.

    ALSO pins `snippet_sweep_workers=1` (Task 11). Sharding the cell work
    across workers makes `ScriptedRunner`'s call INDEX — and therefore any
    scripted timeout/success SEQUENCE, and any exact "aborted at exactly the
    threshold" call count — scheduling-dependent. The guard-semantics tests
    below assert those exact sequences, so they need the serial executor; the
    fan-out itself is covered by the `test_parallel_*` tests, which opt back in
    with `model_copy(update={"snippet_sweep_workers": 4})`. Both assertions are
    load-bearing: a renamed env var must fail here, not degrade silently."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_WORKERS", "1")
    settings = get_settings()
    assert settings.snippet_sweep_sync is True
    assert settings.snippet_sweep_workers == 1
    return settings


def test_sweep_fills_cache_and_completes(settings_sync_sweep: Settings) -> None:
    model = _model(4)
    session = _session_with(model)
    defn = _defn()
    runner = CountingRunner()

    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings_sync_sweep, 0
    )
    assert job.state == "done"
    assert job.done == job.total == 4  # one script cell per row
    assert runner.calls == 4

    # Every cell now serves cache-only: a fresh cache-only context that builds
    # AND sorts the whole table finds zero pending misses (one sweep serves
    # both cell rendering and every sort order — the job key excludes the sort).
    ctx = ScriptEvalContext(
        runner,
        model,
        RunLimits(),
        ScriptBudget.start(60),
        cell_cache=session.script_cell_cache,
        rev=0,
        cache_only=True,
    )
    built = build_rows_ex(model.metamodel, model, defn, script=ctx)
    order_rows(
        model.metamodel,
        model,
        defn,
        built.keys,
        SortSpec(column=1, direction="asc"),
        script=ctx,
    )
    assert ctx.pending_misses == 0
    assert runner.calls == 4  # the cache-only pass added no guest calls


def test_kick_is_idempotent_and_failed_jobs_are_remembered(
    settings_sync_sweep: Settings,
) -> None:
    model = _model(5)
    session = _session_with(model)
    defn = _defn()
    runner = ScriptedRunner(lambda i, ids: timeout())  # every call times out

    job1 = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings_sync_sweep, 0
    )
    assert job1.state == "failed"
    assert "consecutive" in (job1.message or "")
    # Aborted at exactly the threshold, not once per row.
    assert runner.calls[0] == settings_sync_sweep.snippet_sweep_timeout_abort
    calls_after_fail = runner.calls[0]

    # Same (fingerprint, rev): the FAILED job comes back as-is — no re-kick and
    # no new guest calls. Timeout results are deliberately never cached, so
    # without failed-job memory a polling client would restart the grind on
    # every poll.
    job2 = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings_sync_sweep, 0
    )
    assert job2 is job1
    assert job2.state == "failed"
    assert runner.calls[0] == calls_after_fail


def test_consecutive_timeout_abort_resets_on_success(
    settings_sync_sweep: Settings,
) -> None:
    model = _model(6)
    session = _session_with(model)
    defn = _defn()
    # By call index: T T OK T T OK ... — never 3 in a row, so the abort guard
    # never trips (a success resets the counter) and the sweep completes.
    runner = ScriptedRunner(lambda i, ids: ok(1) if i % 3 == 2 else timeout())

    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings_sync_sweep, 0
    )
    assert job.state == "done"
    assert job.message is None
    assert job.done == job.total == 6
    assert runner.calls[0] == 6


def test_ceiling_abort(settings_sync_sweep: Settings) -> None:
    model = _model(3)
    session = _session_with(model)
    defn = _defn()
    runner = CountingRunner()
    # A 0s ceiling exhausts the ScriptBudget before the very first row.
    settings = settings_sync_sweep.model_copy(update={"snippet_sweep_ceiling_s": 0.0})

    job = kick_or_join_sweep(session, model.metamodel, model, defn, runner, settings, 0)
    assert job.state == "failed"
    assert "ceiling" in (job.message or "")
    assert runner.calls == 0  # aborted before any guest call


def test_touch_model_cancels_and_new_rev_rekicks() -> None:
    model = _model(3)
    session = _session_with(model)
    defn = _defn()
    runner = BlockingRunner()
    settings = Settings()  # async: snippet_sweep_sync defaults False

    job = kick_or_join_sweep(session, model.metamodel, model, defn, runner, settings, 0)
    assert job.state == "running"
    # Deterministic sync point: the daemon thread is now parked INSIDE a call.
    assert runner.entered.wait(timeout=5.0)
    fp = job.fingerprint

    session.touch_model()  # out-of-protocol mutation: cancel + clear sweeps
    assert job.cancel.is_set()
    assert session.script_sweeps.get(fp, 0) is None  # gone at the old rev
    assert session.model_rev == 1  # the next evaluate re-kicks at the new rev

    runner.proceed.set()  # release the parked call; the thread aborts and exits


def test_set_model_cancels_sweeps() -> None:
    model = _model(3)
    session = _session_with(model)
    defn = _defn()
    runner = BlockingRunner()

    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, Settings(), 0
    )
    assert runner.entered.wait(timeout=5.0)

    session.set_model(_model(2))  # model replacement is the other invalidation
    assert job.cancel.is_set()
    assert session.script_sweeps.get(job.fingerprint, 0) is None

    runner.proceed.set()


def test_evict_cancels_sweeps() -> None:
    reg = SessionRegistry()
    session = reg.get("p")  # empty-fallback Session, registered under "p"
    session.metamodel = _mm()
    session.model = _model(3)
    defn = _defn()
    runner = BlockingRunner()

    job = kick_or_join_sweep(
        session, session.metamodel, session.model, defn, runner, Settings(), 0
    )
    assert runner.entered.wait(timeout=5.0)

    reg.evict("p")  # a RUNNING sweep must never block eviction
    assert job.cancel.is_set()
    assert reg.peek("p") is None  # the session really was evicted

    runner.proceed.set()


def test_registry_get_is_rev_scoped() -> None:
    reg = ScriptSweepRegistry()

    def _noop(job: SweepJob) -> None:
        pass

    job = reg.kick("fp", 5, _noop)
    assert reg.get("fp", 5) is job
    assert reg.get("fp", 6) is None  # a different rev is a miss
    assert reg.get("other", 5) is None
    # A newer rev for the same fingerprint REPLACES the job (unlike a same-rev
    # kick, which returns the existing one).
    newer = reg.kick("fp", 6, _noop)
    assert newer is not job
    assert reg.get("fp", 6) is newer


def test_registry_cancel_all_clears_and_signals() -> None:
    reg = ScriptSweepRegistry()

    def _noop(job: SweepJob) -> None:
        pass

    j1 = reg.kick("a", 0, _noop)
    j2 = reg.kick("b", 0, _noop)
    reg.cancel_all()
    assert j1.cancel.is_set() and j2.cancel.is_set()
    assert reg.get("a", 0) is None and reg.get("b", 0) is None


def test_run_lock_is_public() -> None:
    """The per-session run lock that serializes job threads is a PUBLIC
    attribute: module-level `_run()` takes it directly instead of reaching into
    a private field."""
    reg = ScriptSweepRegistry()
    assert isinstance(reg.run_lock, type(threading.Lock()))


def _fingerprint(defn: TableDefinition) -> str:
    """The sweep's job key: the definition dumped with a None sort (the job
    key deliberately excludes the sort — see the module docstring)."""
    return table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), None)


def test_cancelled_job_reaches_a_terminal_state(
    settings_sync_sweep: Settings,
) -> None:
    """A job aborted by cancellation must end `cancelled`, NOT `running`.

    Pre-fix the abort path `return`ed without touching `job.state`, so the job
    stayed `running` with a dead thread behind it and failed-job memory handed
    that zombie to every later poll forever.
    """
    model = _model(4)
    session = _session_with(model)
    defn = _defn()
    fp = _fingerprint(defn)

    def _outcome(i: int, ids: list[str]) -> object:
        if i == 0:
            job = session.script_sweeps.get(fp, 0)
            assert job is not None
            job.cancel.set()  # cancelled mid-run, exactly like evict does
        return ok(1)

    runner = ScriptedRunner(_outcome)  # type: ignore[arg-type]
    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings_sync_sweep, 0
    )
    assert job.state == "cancelled"
    assert job.state != "running"
    assert runner.calls[0] == 1  # stopped at the next cell, not at the end


def test_rev_rollback_aborted_job_is_terminal(settings_sync_sweep: Settings) -> None:
    """The other abort trigger — `session.model_rev` moving off `job.rev` —
    must also land a terminal state. `routes/metamodel_swap.py` rolls the rev
    BACK on its DB-persist failure path, so an aborted job can find itself
    registered at the current rev again; left `running` it would be returned
    by `kick` forever."""
    model = _model(4)
    session = _session_with(model)
    defn = _defn()

    def _outcome(i: int, ids: list[str]) -> object:
        if i == 0:
            session.model_rev += 1  # a commit landed under the sweep
        return ok(1)

    runner = ScriptedRunner(_outcome)  # type: ignore[arg-type]
    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings_sync_sweep, 0
    )
    assert job.state == "cancelled"


def test_kick_drops_the_job_when_start_raises() -> None:
    """`Thread.start()` can raise (thread exhaustion). The job must not stay
    registered, or every later kick returns a threadless "running" zombie."""
    reg = ScriptSweepRegistry()

    def _boom(job: SweepJob) -> None:
        raise RuntimeError("can't start new thread")

    with pytest.raises(RuntimeError):
        reg.kick("fp", 0, _boom)
    assert reg.get("fp", 0) is None  # dropped, not remembered

    started: list[SweepJob] = []
    job = reg.kick("fp", 0, started.append)  # the NEXT kick gets a fresh job
    assert started == [job]
    assert job.state == "running"
    assert reg.get("fp", 0) is job


def test_runner_unavailable_fails_instead_of_reporting_done(
    settings_sync_sweep: Settings,
) -> None:
    """A sweep whose runner is never available caches NOTHING (unavailable is
    not a cacheable kind), so without the consecutive-unavailable guard it
    would report `done` having achieved nothing and failed-job memory would
    block every retry at that rev."""
    model = _model(8)
    session = _session_with(model)
    defn = _defn()
    runner = UnavailableRunner()

    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings_sync_sweep, 0
    )
    assert job.state == "failed"
    assert "unavailable" in (job.message or "")
    # Aborted at exactly the threshold, sharing the timeout guard's setting.
    assert runner.opens == settings_sync_sweep.snippet_sweep_timeout_abort
    assert session.script_cell_cache.size == 0


def test_evict_refused_leaves_the_sweep_running() -> None:
    """Eviction the guard REFUSES must not cancel the sweep: the idle sweeper
    retries every interval, so a repeatedly-killed sweep on a long-lived
    session would restart forever and never converge."""
    reg = SessionRegistry()
    session = reg.get("p")
    session.metamodel = _mm()
    session.model = _model(3)
    session.validation_sweep = SweepProgress(running=True)  # guard refuses evict
    defn = _defn()
    runner = BlockingRunner()

    job = kick_or_join_sweep(
        session, session.metamodel, session.model, defn, runner, Settings(), 0
    )
    assert runner.entered.wait(timeout=5.0)

    reg.evict("p")
    assert reg.peek("p") is session  # eviction really was refused
    assert not job.cancel.is_set()  # ...so the sweep survives untouched
    assert job.state == "running"

    runner.proceed.set()


# --- Task 11: sharding the cell work across parallel guest sessions ---------
#
# These tests opt BACK IN to the fan-out (`settings_sync_sweep` pins
# `snippet_sweep_workers=1` for the deterministic-sequence tests above). Sync
# mode still drives the fan-out inline: the worker threads are spawned AND
# joined inside `_run_inner`, so `kick_or_join_sweep` still returns a finished
# job and nothing here has to sleep.

PARALLEL_WORKERS = 4


def _parallel(settings: Settings, workers: int = PARALLEL_WORKERS) -> Settings:
    return settings.model_copy(update={"snippet_sweep_workers": workers})


def _cache_snapshot(session: Session, model: Model) -> dict[str, object]:
    """Read every swept cell back through a CACHE-ONLY context: the only
    supported way to observe what a sweep actually stored (the cache's dict is
    private). A pending miss here means the sweep left a hole."""
    probe = ScriptEvalContext(
        CountingRunner(),
        model,
        RunLimits(),
        ScriptBudget.start(60),
        cell_cache=session.script_cell_cache,
        rev=0,
        cache_only=True,
    )
    snapshot: dict[str, object] = {
        eid: probe.call(VALUE_CODE, "value", [eid]).value for eid in model.elements
    }
    assert probe.pending_misses == 0, "sweep left uncomputed cells behind"
    return snapshot


def test_parallel_sweep_matches_serial_results(settings_sync_sweep: Settings) -> None:
    """The determinism guarantee is what makes the cell cache sound, so
    sharding must not perturb a single byte: same model + same definition ⇒
    identical cache contents and identical done/total, at 1 worker and at 4."""
    model = _model(8)  # ONE model, so element ids are identical across runs
    defn = _defn()
    snapshots: dict[int, dict[str, object]] = {}

    for workers in (1, PARALLEL_WORKERS):
        session = _session_with(model)
        # Value derived from the element ids, NOT the call index: identical
        # under any scheduling, which is exactly the property under test.
        runner = ScriptedRunner(lambda i, ids: ok("|".join(ids)))
        job = kick_or_join_sweep(
            session,
            model.metamodel,
            model,
            defn,
            runner,
            _parallel(settings_sync_sweep, workers),
            0,
        )
        assert job.state == "done", job.message
        assert job.done == job.total == 8
        assert runner.calls[0] == 8  # one guest call per distinct cell either way
        snapshots[workers] = _cache_snapshot(session, model)

    assert snapshots[1] == snapshots[PARALLEL_WORKERS]
    assert snapshots[PARALLEL_WORKERS] == {
        eid: {"kind": "scalar", "value": eid} for eid in model.elements
    }


def test_parallel_sweep_uses_multiple_sessions(settings_sync_sweep: Settings) -> None:
    """The fan-out really opens one guest session PER WORKER.

    Synchronization is a `threading.Barrier`, not a count-after-the-fact: with
    a plain counter a fast worker can drain the queue before a slow one ever
    starts, so `opens` would be scheduling-dependent. The barrier forces all
    four workers to be in-flight simultaneously, making `opens == 4` exact. A
    missing participant breaks the barrier after a bounded 10s wait, which
    surfaces as `state == "failed"` here rather than a hung suite."""
    model = _model(8)  # >= workers, so every worker is guaranteed an item
    session = _session_with(model)
    defn = _defn()
    runner = BarrierRunner(parties=PARALLEL_WORKERS)

    job = kick_or_join_sweep(
        session,
        model.metamodel,
        model,
        defn,
        runner,
        _parallel(settings_sync_sweep),
        0,
    )
    assert job.state == "done", job.message
    assert job.done == job.total == 8
    assert not runner.barrier.broken
    # Exactly one per worker: the SERIAL prefix context never touches the guest
    # for this definition (keep_empty defaults True), so it opens nothing.
    assert runner.opens == PARALLEL_WORKERS


def test_parallel_consecutive_timeout_abort_is_global(
    settings_sync_sweep: Settings,
) -> None:
    """The consecutive-timeout counter is JOB-GLOBAL, not per worker.

    With per-worker counters, 4 workers would each grind their own run of
    `snippet_sweep_timeout_abort` calls before giving up — 4x the threshold.
    The bound below (`threshold + workers`) is strictly under that, so the test
    genuinely discriminates a shared counter from four private ones."""
    model = _model(40)  # far more rows than any bound below
    session = _session_with(model)
    defn = _defn()
    runner = ScriptedRunner(lambda i, ids: timeout())  # every call times out
    settings = _parallel(settings_sync_sweep)
    abort_at = settings.snippet_sweep_timeout_abort

    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings, 0
    )
    assert job.state == "failed"
    assert "consecutive snippet timeouts" in (job.message or "")
    # >= threshold (it takes that many to trip) and <= threshold + one in-flight
    # call per worker; NOT O(rows) and not workers x threshold.
    assert abort_at <= runner.calls[0] <= abort_at + PARALLEL_WORKERS
    assert session.script_cell_cache.size == 0  # timeouts are never cached


def test_parallel_consecutive_unavailable_abort_is_global(
    settings_sync_sweep: Settings,
) -> None:
    """Same discipline for the SECOND pathology guard: `unavailable` results
    are not cacheable either, so a per-worker counter would let a sweep against
    an exhausted guest pool grind `workers x threshold` cells and still cache
    nothing."""
    model = _model(40)
    session = _session_with(model)
    defn = _defn()
    runner = UnavailableRunner()  # every open_session raises
    settings = _parallel(settings_sync_sweep)
    abort_at = settings.snippet_sweep_timeout_abort

    job = kick_or_join_sweep(
        session, model.metamodel, model, defn, runner, settings, 0
    )
    assert job.state == "failed"
    assert "unavailable" in (job.message or "")
    assert abort_at <= runner.opens <= abort_at + PARALLEL_WORKERS
    assert session.script_cell_cache.size == 0
