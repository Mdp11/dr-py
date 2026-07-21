"""Background whole-table script evaluation (spec 2026-07-20 §4.3).

A SweepJob computes every script-column cell of ONE resolved table definition
at ONE model rev, writing results into the session's ScriptCellCache. The job
key deliberately EXCLUDES the sort: `_sort_value` calls the same
(code, "value", ids) keys as cell rendering, so one sweep serves every sort
order, the keep_empty filter, cell rendering, and export.

Failed-job memory: a job aborted by a pathology guard stays registered for
its (fingerprint, rev) and is returned as-is by kick() — WITHOUT it the next
poll would restart the grind, because timeouts are deliberately not cached.
touch_model/set_model cancel-and-clear the registry, so the next commit
retries naturally.

Reads run lock-free (benign-race stance): the job aborts when
session.model_rev moves, and cache writes are rev-stamped, so a raced commit
merely wastes the job's remaining work, never poisons anything.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import ScriptBudget, ScriptRunner
from data_rover.core.table.evaluate import (
    TableLimits,
    build_rows_ex,
    resolve_source_elements,
)
from data_rover.core.table.schema import TABLE_ADAPTER, ScriptColumn, TableDefinition

from .script_runner import run_limits_from_settings
from .settings import Settings
from .table_cache import table_fingerprint

if TYPE_CHECKING:
    # Import-cycle guard: `session.py` imports ScriptSweepRegistry from THIS
    # module at runtime, so the back-reference must stay type-only.
    from .session import Session

logger = logging.getLogger(__name__)


@dataclass
class SweepJob:
    """One background sweep of one table definition at one model rev.

    ``done``/``total`` drive the client's progress readout (``total`` is None
    until the row build finishes). ``message`` carries the abort reason of a
    ``failed`` job. ``cancel`` is set by the session invalidation hooks and by
    eviction; the run loop checks it between cells.

    ``state`` has THREE terminal values. ``cancelled`` is distinct from
    ``failed`` on purpose: a cancelled job hit no pathology (the session was
    evicted, or the rev moved under it), so a client-facing status must be
    able to tell the two apart. Every exit from the run loop MUST leave a
    terminal state — a job left ``running`` behind a dead thread strands a
    polling client forever, because failed-job memory returns it as-is.
    """

    fingerprint: str
    rev: int
    state: Literal["running", "done", "failed", "cancelled"] = "running"
    done: int = 0
    total: int | None = None
    message: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


class ScriptSweepRegistry:
    """Per-session job table plus a run lock serializing job threads.

    ``run_lock`` is PUBLIC on purpose: the module-level ``_run`` takes it
    directly rather than reaching into a private attribute. It gives one active
    sweep per session — a queued job blocks its own daemon thread on the lock,
    a natural FIFO for the handful of tables a user flips between, and it keeps
    a single session from monopolising the process-wide worker slots.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.run_lock = threading.Lock()
        self._jobs: dict[str, SweepJob] = {}

    def get(self, fingerprint: str, rev: int) -> SweepJob | None:
        with self._lock:
            job = self._jobs.get(fingerprint)
            return job if job is not None and job.rev == rev else None

    def kick(
        self, fingerprint: str, rev: int, start: Callable[[SweepJob], None]
    ) -> SweepJob:
        """Get-or-create the job for ``(fingerprint, rev)``.

        An existing job at the SAME rev is returned as-is whatever its state —
        running, done, or **failed** (failed-job memory, see the module
        docstring). Only a rev change creates a new job (and calls ``start``).

        If ``start`` raises (e.g. ``Thread.start`` under thread exhaustion),
        the freshly registered job is REMOVED before the exception propagates:
        leaving it in place would register a threadless "running" job that
        failed-job memory hands back to every later poll forever. Dropping it
        lets the next kick try again.
        """
        created = False
        with self._lock:
            job = self._jobs.get(fingerprint)
            if job is None or job.rev != rev:
                job = SweepJob(fingerprint=fingerprint, rev=rev)
                self._jobs[fingerprint] = job
                created = True
        if created:
            try:
                start(job)
            except BaseException:
                with self._lock:
                    if self._jobs.get(fingerprint) is job:
                        del self._jobs[fingerprint]
                raise
        return job

    def cancel_all(self) -> None:
        """Signal every registered job and forget them (invalidation/evict)."""
        with self._lock:
            jobs = list(self._jobs.values())
            self._jobs.clear()
        for j in jobs:
            j.cancel.set()


def kick_or_join_sweep(
    session: Session,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    runner: ScriptRunner,
    settings: Settings,
    rev: int,
) -> SweepJob:
    """Start (or join) the sweep for ``defn`` at ``rev`` on ``session``.

    The fingerprint is computed with a None sort deliberately — see the module
    docstring: one sweep serves every sort order of the same definition.
    """
    fp = table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), None)

    def _start(job: SweepJob) -> None:
        if settings.snippet_sweep_sync:
            _run(session, metamodel, model, defn, runner, settings, job)
        else:
            threading.Thread(
                target=_run,
                args=(session, metamodel, model, defn, runner, settings, job),
                name="script-sweep",
                daemon=True,
            ).start()

    return session.script_sweeps.kick(fp, rev, _start)


def reset_global_slots() -> None:
    """Test seam: drop the lazily-sized process-wide semaphore so a test that
    pins different sweep settings gets a freshly sized one (mirrors the other
    `reset_*` seams, e.g. `script_runner.reset_runner`). Call from the api
    conftest's per-test cleanup."""
    global _global_slots
    with _global_slots_lock:
        _global_slots = None


def _aborted(session: Session, job: SweepJob) -> bool:
    return job.cancel.is_set() or session.model_rev != job.rev


def _fail(job: SweepJob, message: str) -> None:
    job.state = "failed"
    job.message = message


def _cancelled(job: SweepJob) -> None:
    """Mark an aborted job terminal.

    EVERY ``_aborted()`` return path must go through here. A bare ``return``
    leaves ``state="running"`` with a dead thread behind it, and failed-job
    memory (``kick`` returns a same-rev job as-is) then hands that zombie back
    to every subsequent poll — the client waits on a sweep nobody is running.
    Reachable both when the rev rolls BACK onto the job's rev (see
    ``routes/metamodel_swap.py``'s DB-failure path) and after any cancel.
    """
    job.state = "cancelled"
    job.message = "sweep cancelled"


#: Process-wide bound on concurrently RUNNING sweep jobs (spec §4.3: sweeps
#: get their own pool, bounded across ALL sessions — N open projects must not
#: mean N×workers guest instances). Lazily sized from settings on first use.
_global_slots: threading.BoundedSemaphore | None = None
_global_slots_lock = threading.Lock()


def _acquire_global_slot(settings: Settings) -> threading.BoundedSemaphore:
    global _global_slots
    with _global_slots_lock:
        if _global_slots is None:
            _global_slots = threading.BoundedSemaphore(
                max(1, settings.snippet_sweep_workers)
            )
        return _global_slots


def _run(
    session: Session,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    runner: ScriptRunner,
    settings: Settings,
    job: SweepJob,
) -> None:
    try:
        slot = _acquire_global_slot(settings)
        with slot, session.script_sweeps.run_lock:
            # Re-check after queuing: the job may have been cancelled (or the
            # rev moved) while this thread waited for a slot / the run lock.
            if _aborted(session, job):
                _cancelled(job)
                return
            _run_inner(session, metamodel, model, defn, runner, settings, job)
    except Exception:
        logger.exception("script sweep failed for table %s", job.fingerprint[:12])
        _fail(job, "internal sweep error")


def _run_inner(
    session: Session,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    runner: ScriptRunner,
    settings: Settings,
    job: SweepJob,
) -> None:
    limits = run_limits_from_settings(settings)
    budget = ScriptBudget.start(settings.snippet_sweep_ceiling_s)
    ctx = ScriptEvalContext(
        runner,
        model,
        limits,
        budget,
        cell_cache=session.script_cell_cache,
        rev=job.rev,
        # Cancellation granularity INSIDE the serial row build: for a
        # definition with an expand script column (or a script column used as
        # a source) `build_rows_ex` IS the grind, and without this probe a
        # cancelled job would keep an evicted session's model alive until the
        # ceiling. Aborted calls come back kind="cancelled", which the cell
        # cache refuses to store.
        should_abort=job.cancel.is_set,
    )
    try:
        # Serial prefix: computes (and caches) every expand/keep_empty/
        # script-as-source item in dependency order.
        built = build_rows_ex(metamodel, model, defn, TableLimits(), script=ctx)
        if _aborted(session, job):
            _cancelled(job)
            return
        script_cols = [
            c
            for c in defn.columns
            if isinstance(c, ScriptColumn)
            and c.mode != "expand"  # expand items were built above
            and c.snippet.definition is not None
        ]
        expand_count = sum(
            1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
        )
        base_slots = (len(built.keys[0]) - expand_count) if built.keys else 1
        job.total = len(built.keys) * len(script_cols)
        consecutive_timeouts = 0
        consecutive_unavailable = 0
        for key in built.keys:
            for col in script_cols:
                if _aborted(session, job):
                    _cancelled(job)
                    return
                if budget.exhausted:
                    _fail(
                        job,
                        f"sweep ceiling ({settings.snippet_sweep_ceiling_s:g}s)"
                        " exceeded",
                    )
                    return
                roots = resolve_source_elements(
                    metamodel,
                    model,
                    defn,
                    key,
                    col.source,
                    base_slots,
                    TableLimits(),
                    script=ctx,
                )
                if roots:
                    assert col.snippet.definition is not None
                    res = ctx.call(col.snippet.definition.code, "value", roots)
                    kind = res.error.kind if res.error is not None else None
                    if kind == "timeout":
                        # Timeouts are environmental and never cached, so a
                        # snippet that keeps timing out would otherwise be
                        # re-run for every remaining cell of a huge table.
                        consecutive_timeouts += 1
                        consecutive_unavailable = 0
                        if consecutive_timeouts >= settings.snippet_sweep_timeout_abort:
                            _fail(
                                job,
                                f"aborted after {consecutive_timeouts} "
                                "consecutive snippet timeouts",
                            )
                            return
                    elif kind == "unavailable":
                        # WHY this guard exists: `unavailable` results (no
                        # runner, or an exhausted wasm warm pool) are
                        # deliberately never cached either. Without it a sweep
                        # against a busy/absent runner grinds every cell,
                        # caches NOTHING, and still ends state="done" — a
                        # "success" indistinguishable from a real one. Since
                        # kick() returns a same-rev done job as-is, nothing
                        # ever re-kicks and the table renders pending forever.
                        # Shares the timeout guard's threshold and its
                        # reset-on-any-other-outcome discipline.
                        consecutive_unavailable += 1
                        consecutive_timeouts = 0
                        if (
                            consecutive_unavailable
                            >= settings.snippet_sweep_timeout_abort
                        ):
                            _fail(
                                job,
                                f"aborted after {consecutive_unavailable} "
                                "consecutive results with the script runner "
                                "unavailable",
                            )
                            return
                    else:
                        consecutive_timeouts = 0
                        consecutive_unavailable = 0
                job.done += 1
        job.state = "done"
    finally:
        ctx.close()
