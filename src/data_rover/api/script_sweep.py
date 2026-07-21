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

Sharding (spec §4.3): the row BUILD stays serial — it may itself call the
guest to resolve expand columns or script-as-source columns, and every later
stage depends on its output — but the per-cell work after it is fanned out
across up to `settings.snippet_sweep_workers` threads, each driving its OWN
`ScriptEvalContext` and therefore its own guest instance. Results are
identical to serial execution: the WASM determinism guarantee makes a cell's
value a pure function of (code, model, element ids), the cell cache is
internally locked, and the pathology counters are job-global (see
`_SharedGuards`).

DON'T rely on module-global state inside a snippet. Mutating a module global
between `value()` calls was already outside the determinism guarantee (see
`core/script/embed.py`), but sharding makes it reachable in a NEW way: two
cells of the same table can now land on different guest instances, so
"accumulate into a global across cells" no longer even sees a single
interpreter. Snippet entry points must be pure functions of their arguments.
"""

from __future__ import annotations

import logging
import queue
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
    a single session from monopolising the process-wide worker slots. That last
    property depends on the LOCK ORDER in ``_run``: this lock is taken BEFORE
    the process-wide slot, so a session's queued sweeps wait here holding no
    global capacity at all.
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
        # LOCK ORDER — per-session `run_lock` FIRST, process-wide `slot`
        # SECOND, everywhere, no exceptions. Taking the slot first would have
        # a session's queued sweeps sit on their own run_lock while HOLDING
        # global capacity: four tables of one project would occupy all four
        # slots with one thread working and three idle, starving every other
        # project for up to the sweep ceiling — the exact opposite of what
        # `ScriptSweepRegistry.run_lock` is documented to do. This way a
        # queued sweep blocks on its session's lock holding nothing global.
        # No deadlock: these are the only two locks acquired together on this
        # path (everything deeper — the cell cache, `_SharedGuards.lock`, the
        # registry's own `_lock`, the work queue — is a leaf taken and
        # released strictly inside, and `kick()` releases `_lock` before
        # calling `start`), so the acquisition order is globally consistent.
        with session.script_sweeps.run_lock, slot:
            # Re-check after queuing: the job may have been cancelled (or the
            # rev moved) while this thread waited for the run lock / a slot.
            if _aborted(session, job):
                _cancelled(job)
                return
            _run_inner(session, metamodel, model, defn, runner, settings, job)
    except Exception:
        logger.exception("script sweep failed for table %s", job.fingerprint[:12])
        _fail(job, "internal sweep error")


#: One unit of shardable sweep work: (snippet code, root element ids). The
#: entry point is always "value" — expand columns were resolved by the serial
#: row build, which happens before any fan-out.
_Item = tuple[str, tuple[str, ...]]


@dataclass
class _SharedGuards:
    """Job-global pathology counters plus the lock that publishes them.

    BOTH counters must be counted ACROSS workers, not per worker: 4 workers
    each seeing 2 consecutive timeouts is 8 timeouts in a row for the job, not
    "under the limit 4 times". Per-worker counters would let a pathological
    table burn ``workers x threshold`` guest calls before giving up, and — for
    ``unavailable`` — cache nothing at all while doing it.

    ``lock`` also guards every write to ``job.state``/``job.message``/
    ``job.done``, which several workers touch concurrently.
    """

    lock: threading.Lock = field(default_factory=threading.Lock)
    consecutive_timeouts: int = 0
    consecutive_unavailable: int = 0


def _ceiling_message(settings: Settings) -> str:
    return f"sweep ceiling ({settings.snippet_sweep_ceiling_s:g}s) exceeded"


def _drain(
    session: Session,
    settings: Settings,
    job: SweepJob,
    budget: ScriptBudget,
    wctx: ScriptEvalContext,
    q: queue.SimpleQueue[_Item],
    guards: _SharedGuards,
) -> None:
    """Pull items off the shared queue until it is empty or the job goes
    terminal. Run by every worker thread (and, at ``workers == 1``, by the
    calling thread with the serial context).

    Every exit that ends the JOB (not just this worker) sets a TERMINAL state
    under ``guards.lock`` — a job left ``running`` behind dead threads strands
    a polling client forever, because failed-job memory hands it back as-is.
    The first terminal writer wins; later workers observe ``state != running``
    and simply stop, so an abort reason is never overwritten.
    """
    while True:
        try:
            code, roots = q.get_nowait()
        except queue.Empty:
            return
        with guards.lock:
            if job.state != "running":
                return  # another worker already ended the job
        if _aborted(session, job):
            with guards.lock:
                if job.state == "running":
                    _cancelled(job)
            return
        if budget.exhausted:
            with guards.lock:
                if job.state == "running":
                    _fail(job, _ceiling_message(settings))
            return
        res = wctx.call(code, "value", list(roots))
        kind = res.error.kind if res.error is not None else None
        with guards.lock:
            if kind == "timeout":
                # Timeouts are environmental and never cached, so a snippet
                # that keeps timing out would otherwise be re-run for every
                # remaining cell of a huge table.
                guards.consecutive_timeouts += 1
                guards.consecutive_unavailable = 0
                if guards.consecutive_timeouts >= settings.snippet_sweep_timeout_abort:
                    if job.state == "running":
                        _fail(
                            job,
                            f"aborted after {guards.consecutive_timeouts} "
                            "consecutive snippet timeouts",
                        )
                    return
            elif kind == "unavailable":
                # WHY this guard exists: `unavailable` results (no runner, or
                # an exhausted wasm warm pool) are deliberately never cached
                # either. Without it a sweep against a busy/absent runner
                # grinds every cell, caches NOTHING, and still ends
                # state="done" — a "success" indistinguishable from a real
                # one. Since kick() returns a same-rev done job as-is, nothing
                # ever re-kicks and the table renders pending forever. Shares
                # the timeout guard's threshold and its
                # reset-on-any-other-outcome discipline.
                guards.consecutive_unavailable += 1
                guards.consecutive_timeouts = 0
                if (
                    guards.consecutive_unavailable
                    >= settings.snippet_sweep_timeout_abort
                ):
                    if job.state == "running":
                        _fail(
                            job,
                            f"aborted after {guards.consecutive_unavailable} "
                            "consecutive results with the script runner "
                            "unavailable",
                        )
                    return
            else:
                guards.consecutive_timeouts = 0
                guards.consecutive_unavailable = 0
            job.done += 1


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

        # Enumerate the cell work list through the SERIAL context: resolving a
        # script-as-source column may itself call the guest, and the resolution
        # order is part of the definition's dependency order. Dedupe: rows
        # sharing a binding produce identical (code, roots) items, and
        # computing them once matches ScriptEvalContext's own memo semantics
        # (which is what the serial implementation did too — a repeat binding
        # hit the memo instead of the guest).
        items: list[_Item] = []
        seen: set[_Item] = set()
        dup_or_empty = 0
        for key in built.keys:
            if _aborted(session, job):
                _cancelled(job)
                return
            if budget.exhausted:
                _fail(job, _ceiling_message(settings))
                return
            for col in script_cols:
                assert col.snippet.definition is not None
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
                item = (col.snippet.definition.code, tuple(roots))
                if not roots or item in seen:
                    # Empty-source cells have nothing to compute and duplicate
                    # bindings are computed by the item they duplicate, so both
                    # are already "done" as far as progress is concerned.
                    dup_or_empty += 1
                    continue
                seen.add(item)
                items.append(item)
        job.done += dup_or_empty  # still single-threaded here

        guards = _SharedGuards()
        q: queue.SimpleQueue[_Item] = queue.SimpleQueue()
        for it in items:
            q.put(it)
        workers = max(1, settings.snippet_sweep_workers)
        if workers == 1 or len(items) <= 1:
            # No fan-out worth its thread: reuse the serial context (and its
            # already-open guest session).
            _drain(session, settings, job, budget, ctx, q, guards)
        else:

            def _worker() -> None:
                try:
                    wctx = ScriptEvalContext(
                        runner,
                        model,
                        limits,
                        budget,
                        cell_cache=session.script_cell_cache,
                        rev=job.rev,
                        # Same cancellation probe as the serial context: without
                        # it an evicted session's ~80 MB model stays reachable
                        # from a worker until the sweep ceiling.
                        should_abort=job.cancel.is_set,
                    )
                    try:
                        _drain(session, settings, job, budget, wctx, q, guards)
                    finally:
                        wctx.close()
                except Exception:
                    # A worker thread's exception would otherwise be swallowed
                    # by threading, and the join below would then declare the
                    # job "done". Mirror `_run`'s outer guard instead.
                    logger.exception(
                        "script sweep worker failed for table %s",
                        job.fingerprint[:12],
                    )
                    with guards.lock:
                        if job.state == "running":
                            _fail(job, "internal sweep error")

            threads = [
                threading.Thread(target=_worker, name=f"script-sweep-w{i}", daemon=True)
                for i in range(min(workers, len(items)))
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        # Only a job no worker ended is a success; an abort already wrote its
        # own terminal state (failed/cancelled) and must not be overwritten.
        if job.state == "running":
            job.state = "done"
    finally:
        ctx.close()
