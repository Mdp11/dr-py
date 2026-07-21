"""SweepJob lifecycle against TrustedRunner-style fakes (spec 2026-07-20 §4.3).

Uses the shared fakes in `tests/api/_script_fakes.py`: `CountingRunner` (all
calls succeed), `ScriptedRunner` (per-call-INDEX outcome, so timeout sequences
are deterministic) and `BlockingRunner` (every call parks on an Event, so the
async cancel/evict cases synchronize deterministically instead of sleeping).

Sync mode is pinned exactly the way `tests/api/conftest.py` pins
`validation_sweep_sync` — an env var read through `get_settings()` — via the
local `settings_sync_sweep` fixture. In sync mode `kick_or_join_sweep` runs the
whole sweep inline, so every assertion below observes a finished job.
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
from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.evaluate import SortSpec, build_rows_ex, order_rows
from data_rover.core.table.schema import (
    ElementColumn,
    ScopeRows,
    ScriptColumn,
    TableDefinition,
)

from ._script_fakes import BlockingRunner, CountingRunner, ScriptedRunner, ok, timeout

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
    `validation_sweep_sync`: an env var, then a fresh `get_settings()`."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    settings = get_settings()
    assert settings.snippet_sweep_sync is True
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
