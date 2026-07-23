"""Table evaluation (read-only; viewer-callable). Resolves navigation refs, then
builds/sorts/pages rows through the pure core evaluator, caching the ordered row
list per session. No write_mutex — same benign-race stance as routes/read.py."""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.navigation.resolve import NavigationResolveError
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, NavigationDefinition
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import ScriptRunner
from data_rover.core.script.schema import SNIPPET_ADAPTER, SnippetDefinition
from data_rover.core.table.cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
    evaluate_cells,
)
from data_rover.core.table.evaluate import (
    SORT_SCRIPT_NAV_WARNING,
    RowKey,
    SortSpec,
    TableLimits,
    build_rows,
    build_rows_ex,
    iter_export_rows,
    order_rows,
    sort_falls_back_to_build_order,
)
from data_rover.core.table.resolve import resolve_table_refs, table_has_script
from data_rover.core.table.schema import TABLE_ADAPTER, TableDefinition

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind
from ..deps import Session, get_request_session, require_model
from ..schemas import (
    EvaluateTableIn,
    ScriptErrorItemOut,
    ScriptErrorsOut,
    ScriptStatusOut,
    TableCellOut,
    TableColumnOut,
    TablePageOut,
    TableRowOut,
)
from ..script_eval import close_script_context, open_script_context
from ..script_runner import get_runner
from ..script_sweep import SweepJob, kick_or_join_sweep
from ..settings import Settings, get_settings
from ..table_cache import table_fingerprint
from ..table_export import build_workbook
from .read import _tree_item

router = APIRouter()


def _resolve_table(
    payload: EvaluateTableIn, project_id: str, db: DbSession
) -> TableDefinition:
    """The table's own definition (from `artifact_id` or inline), with every
    embedded navigation ref AND `ScriptColumn`/`ScriptStep` snippet ref
    inlined via `resolve_table_refs` — the core evaluator (Tasks 4-6, 9-10)
    assumes a fully ref-free definition. A dangling snippet ref is left in
    place (degrades to an error cell at evaluation time); a dangling
    navigation ref still raises `LookupError` (422)."""
    if payload.artifact_id is not None:
        row = content.get_artifact(db, payload.artifact_id)
        if (
            row is None
            or row.project_id != project_id
            or row.kind is not ArtifactKind.table
        ):
            raise LookupError(payload.artifact_id)
        defn = TABLE_ADAPTER.validate_python(row.payload)
    else:
        assert payload.definition is not None  # schema: exactly one of the two
        defn = payload.definition

    def _fetch(artifact_id: str) -> NavigationDefinition:
        r = content.get_artifact(db, artifact_id)
        if (
            r is None
            or r.project_id != project_id
            or r.kind is not ArtifactKind.navigation
        ):
            raise LookupError(artifact_id)
        return NAVIGATION_ADAPTER.validate_python(r.payload)

    def _fetch_snippet(artifact_id: str) -> SnippetDefinition:
        r = content.get_artifact(db, artifact_id)
        if (
            r is None
            or r.project_id != project_id
            or r.kind is not ArtifactKind.code_snippet
        ):
            raise LookupError(artifact_id)
        return SNIPPET_ADAPTER.validate_python(r.payload)

    return resolve_table_refs(defn, _fetch, snippet_fetch=_fetch_snippet)


def _cell_out(model: Model, cell: Cell) -> TableCellOut:
    if isinstance(cell, ElementCell):
        return TableCellOut(
            kind="element",
            item=_tree_item(model, cell.element_id) if cell.element_id else None,
        )
    if isinstance(cell, ValueCell):
        return TableCellOut(
            kind="value",
            present=cell.present,
            value=cell.value,
            element_id=cell.element_id,
            editable=cell.editable,
        )
    if isinstance(cell, ValuesCell):
        return TableCellOut(
            kind="values",
            present=cell.present,
            values=cell.values,
            total=cell.total,
            truncated=cell.truncated,
        )
    if isinstance(cell, ErrorCell):
        return TableCellOut(
            kind="error", message=cell.message, traceback=cell.traceback
        )
    if isinstance(cell, PendingCell):
        return TableCellOut(kind="pending")
    assert isinstance(cell, ElementsCell)
    return TableCellOut(
        kind="elements",
        items=[_tree_item(model, e) for e in cell.element_ids],
        total=cell.total,
        truncated=cell.truncated,
    )


def _drain(rows: Iterator[list[Cell]]) -> None:
    """Consume a lazy row stream for its SIDE EFFECTS only (the script calls
    each cell makes), discarding the cells chunk-by-chunk. Used by the export's
    completeness probe, where materializing the list would defeat the very
    bounded-peak-memory property `iter_export_rows` exists to provide."""
    for _ in rows:
        pass


def _status_from_job(job: SweepJob) -> ScriptStatusOut:
    """Map a `SweepJob` onto the wire status of the request that kicked/joined it.

    CALLERS ONLY REACH THIS AFTER PENDING WAS SEEN (in the cache-only
    whole-table pass, in the visible-window pass, or both) — that is the
    function's whole precondition, and it is why no branch here can return
    `ready`. This response was already assembled before those values existed
    (possibly degraded to build order, possibly carrying `pending` cells), so
    even a sync/racing sweep that FINISHED during this very request must report
    `computing`: the client polls once more and gets the clean page from the
    now-full cache.

    Both DEAD job states collapse onto `failed`. `cancelled` is not a
    pathology (a rev change or an eviction cancelled it, never the snippet),
    but no thread is behind it any more, so reporting `computing` would strand
    the poller forever — `failed` is the honest terminal answer, and the cause
    of a cancel is always something (a commit) that re-keys the sweep registry
    and gets a fresh job kicked on the next request anyway.
    """
    if job.state in ("failed", "cancelled"):
        return ScriptStatusOut(
            state="failed", done=job.done, total=job.total, message=job.message
        )
    return ScriptStatusOut(state="computing", done=job.done, total=job.total)


#: Wire message for a TERMINAL sweep that still left holes at this rev — the
#: `done`-job case has no `job.message` of its own to borrow.
INCOMPLETE_SWEEP_MESSAGE = (
    "Some script values could not be computed at this revision; "
    "they are shown as not computed until the model changes."
)


@router.post("/tables/evaluate")
def evaluate_table(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> TablePageOut:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).
    Row ORDER is cached per session (Task 7's TableOrderCache) keyed on the
    RESOLVED definition's fingerprint + sort + model_rev, so paging through a
    large table re-evaluates cells per page but not the (possibly expensive)
    row build+sort. No write_mutex — same benign-race stance as
    routes/read.py: a concurrent mutation simply misses the cache (stale
    model_rev) rather than corrupting it.

    Script columns (spec §4.1-4.2): the WHOLE-TABLE passes (`build_rows_ex` +
    `order_rows`) run CACHE-ONLY — the guest is never invoked O(rows) times
    inside a request, because that is precisely the grind that used to freeze
    the UI. Every miss records a pending cell; if any were recorded the
    response DEGRADES to build order (a sort computed over half-pending values
    would reshuffle visibly on every poll) and a background `SweepJob` is
    kicked/joined to fill the cell cache. Only the visible window is evaluated
    live, so a page still shows real values while the rest is computing.
    `script_status` carries the poll-again contract; it stays None for tables
    that have no script column at all. It is computed AFTER the window pass on
    every branch (order-cache hit included), so a window that renders a
    `pending` cell can never be reported as `ready`. A TERMINAL sweep that
    still left holes reports `failed`, not `computing` (decision table at the
    call site) — otherwise failed-job memory would hand the same dead job back
    forever and the client would poll a permanently build-ordered page once a
    second for the life of the rev.

    Lock stance for the sweep kick: this route holds NO session lock (no
    `write_mutex` — see above), so kicking is safe even in the sync sweep mode
    where `kick_or_join_sweep` runs the whole sweep on this thread."""
    metamodel, model = require_model(session)
    try:
        defn = _resolve_table(payload, project_id, db)
        sort = (
            SortSpec(column=payload.sort.column, direction=payload.sort.direction)
            if payload.sort is not None
            else None
        )
        # `TableSortIn` only enforces `column >= 0`; guard the upper bound here
        # (against the RESOLVED column count) so an out-of-range index raises a
        # clear ValueError->422 rather than an IndexError inside `order_rows`
        # that the LookupError clause below would mislabel "unknown artifact".
        if sort is not None and not (0 <= sort.column < len(defn.columns)):
            raise ValueError(
                f"sort column {sort.column} out of range "
                f"(table has {len(defn.columns)} columns)"
            )
        limits = TableLimits()
        # Fingerprint the RESOLVED definition (not the raw request body): two
        # requests that reach the same resolved shape via different refs (or
        # via an inline copy) share a cache entry, and editing a REFERENCED
        # navigation artifact changes this fingerprint on the next request.
        fp = table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), sort)
        sort_key = "none" if sort is None else f"{sort.column}:{sort.direction}"
        # Sample the rev ONCE and reuse it for the cache probe, the store, and
        # the response. Re-reading `session.model_rev` after the (unlocked)
        # build+sort would let a commit that lands mid-computation store rows
        # built against the OLD model under the NEW rev's key — poisoning the
        # cache for every subsequent request instead of merely missing it.
        rev = session.model_rev
        script_ctx, acquired = open_script_context(
            runner,
            model,
            settings,
            needs_script=table_has_script(defn),
            cell_cache=session.script_cell_cache,
            rev=rev,
        )
        try:
            cached = session.table_order_cache.get(fp, sort_key, rev)
            if cached is not None:
                cached_rows, truncated, base_total = cached
                ordered = list(cached_rows)
                # RE-DERIVE the sort-degraded warning on the cache-hit path.
                # `order_rows` — the only thing that emits it — is skipped
                # entirely here, and a degraded order IS cacheable (the degrade
                # records no pending miss, so the poisoning guard below stores
                # it). Without this, exactly one request per rev explains why
                # the table the user asked to sort is in build order; every
                # reload, tab reopen, and second viewer at the same rev gets an
                # unsorted table with no explanation anywhere. Cheap and safe:
                # `sort_falls_back_to_build_order` is O(definition) and reads
                # nothing but the definition (no cache, no model, no context),
                # and every cached order was necessarily built by the CACHE-ONLY
                # pass below — this route is the only writer — so the predicate
                # answers for the order actually in hand. It runs BEFORE the
                # window pass, so `MAX_SCRIPT_WARNINGS` can never crowd it out.
                if script_ctx is not None and sort_falls_back_to_build_order(defn, sort):
                    script_ctx.add_warning(SORT_SCRIPT_NAV_WARNING)
            else:
                # Whole-table passes are CACHE-ONLY (spec §4.1): the guest is
                # never driven O(rows) times inside a request. A miss records a
                # pending cell instead of blocking; the visible window below is
                # still evaluated live.
                if script_ctx is not None:
                    script_ctx.cache_only = True
                built = build_rows_ex(metamodel, model, defn, limits, script=script_ctx)
                truncated, base_total = built.truncated, built.base_total
                ordered = order_rows(
                    metamodel, model, defn, built.keys, sort, limits, script=script_ctx
                )
                if script_ctx is not None:
                    script_ctx.cache_only = False
                    if script_ctx.pending_misses > 0:
                        # Sort/filter incomplete: degrade to build order (a sort
                        # over half-pending values would visibly reshuffle on
                        # every poll). The status/sweep decision itself is
                        # deferred until after the window pass below.
                        ordered = list(built.keys)
            window = ordered[payload.offset : payload.offset + payload.limit]
            cells = evaluate_cells(
                metamodel, model, defn, window, limits, script=script_ctx
            )
            # Cache-poisoning guard: only store a FRESHLY built order (a cache
            # hit is already cached), and only when nothing this request ran
            # through the script errored — `script_ctx.errored` only settles
            # once cell evaluation (not just build/order) has actually run,
            # since an unsorted keep_empty=True script column never calls
            # `value()` until cells are rendered. A bad order (or an order
            # built against a since-superseded rev) must never be cached:
            # neither the fingerprint (code hash) nor `rev` changes on retry,
            # so a poisoned entry would be served forever. `pending_misses > 0`
            # is the Phase B addition, and it is read here at its FINAL value
            # (the window pass has already run): if the whole-table pass went
            # pending, this order is the DEGRADED build order rather than the
            # requested sort and caching it would freeze the table unsorted for
            # this rev; if only the window went pending, the order is fine but
            # declining to cache it is merely conservative.
            if cached is None and (
                script_ctx is None
                or (
                    not script_ctx.errored
                    and script_ctx.pending_misses == 0
                    and session.model_rev == rev
                )
            ):
                session.table_order_cache.put(
                    fp, sort_key, rev, tuple(ordered), truncated, base_total
                )
            # Status is finalized HERE, after the window pass, so that EVERY
            # branch — including an order-cache HIT — observes the final
            # `pending_misses`. The window is not automatically pending-free
            # just because the whole-table pass was: an `expand` script column
            # re-derives its cell with a FORCED cache-only call (cells.py), and
            # on an order-cache hit there is no per-request memo to serve it,
            # so an independently LRU-evicted cell-cache entry surfaces as a
            # `PendingCell`. Reporting `ready` there would stop the client
            # polling and strand that cell until the rev moves.
            script_status: ScriptStatusOut | None = None
            if script_ctx is not None:
                if script_ctx.pending_misses == 0:
                    script_status = ScriptStatusOut(state="ready")
                elif runner is None:
                    # Nothing to sweep with: a kicked job could only fail.
                    script_status = ScriptStatusOut(
                        state="failed", message="script runner unavailable"
                    )
                else:
                    job = kick_or_join_sweep(
                        session, metamodel, model, defn, runner, settings, rev
                    )
                    script_status = _status_from_job(job)
                    # Terminality is read off the WIRE state (which collapses
                    # both DEAD job states, `failed` and `cancelled`, onto
                    # `failed`) PLUS the `done` job state — which
                    # `_status_from_job` deliberately reports as `computing`
                    # and so cannot be recovered from `script_status` alone.
                    #
                    # Once a job exists the honest question is not "did the job
                    # finish" but "would a RETRY ACTUALLY HELP", i.e. is the
                    # cache complete NOW. A RE-PROBE answers it, and (exactly
                    # as in `export_table`) is only ever CONSULTED for a
                    # terminal job:
                    #
                    #   job state       | re-probe? | answer
                    #   ----------------+-----------+--------------------------
                    #   running         | SKIPPED   | `computing` — work is
                    #                   |           | genuinely in flight and
                    #                   |           | nothing a re-probe could
                    #                   |           | find changes that answer,
                    #                   |           | so running one would just
                    #                   |           | re-pay the whole-table
                    #                   |           | pass (whose navigation
                    #                   |           | walk is NOT memoized)
                    #                   |           | once per poll second.
                    #   terminal, none  | consulted | `computing` — the cache
                    #   re-probe misses |           | filled in behind this
                    #                   |           | request (a sync sweep
                    #                   |           | fills it AFTER this
                    #                   |           | request's build), so one
                    #                   |           | more poll returns the
                    #                   |           | clean, correctly SORTED
                    #                   |           | page. True even when the
                    #                   |           | job died `failed`/
                    #                   |           | `cancelled`: the job is
                    #                   |           | dead, the DATA is not.
                    #   terminal, some  | consulted | `failed` — nothing will
                    #   re-probe misses |           | ever fill those cells at
                    #                   |           | this rev (`put` refuses
                    #                   |           | non-deterministic error
                    #                   |           | kinds while the sweep
                    #                   |           | only aborts on a
                    #                   |           | CONSECUTIVE run of them;
                    #                   |           | the per-session cell
                    #                   |           | cache can also LRU-evict
                    #                   |           | the sweep's own earlier
                    #                   |           | writes), and failed-job
                    #                   |           | memory hands the same
                    #                   |           | terminal job back to
                    #                   |           | every later poll. Saying
                    #                   |           | `computing` here would
                    #                   |           | loop the client forever
                    #                   |           | on a page that is also
                    #                   |           | permanently stuck in
                    #                   |           | BUILD order.
                    #
                    # `ready` is still unreachable on this whole branch: the
                    # rows in THIS response predate whatever the re-probe found.
                    terminal = script_status.state == "failed" or job.state == "done"
                    if terminal:
                        # RE-PROBE: replay this request's own passes with a
                        # fresh miss baseline. Truthful despite reusing the
                        # context — a `pending` result is never memoized and
                        # never cached, so every cell that missed re-consults
                        # the (now sweep-filled) cell cache, while cells this
                        # request already computed live are served from the
                        # memo (no fresh guest work, no double-counting).
                        # Cache-only throughout: the question is what a RETRY
                        # would find, and a retry's whole-table pass is
                        # cache-only too.
                        miss_baseline = script_ctx.pending_misses
                        script_ctx.cache_only = True
                        if cached is None:
                            re_built = build_rows_ex(
                                metamodel, model, defn, limits, script=script_ctx
                            )
                            order_rows(
                                metamodel,
                                model,
                                defn,
                                re_built.keys,
                                sort,
                                limits,
                                script=script_ctx,
                            )
                        evaluate_cells(
                            metamodel, model, defn, window, limits, script=script_ctx
                        )
                        script_ctx.cache_only = False
                        if script_ctx.pending_misses > miss_baseline:
                            script_status = ScriptStatusOut(
                                state="failed",
                                done=job.done,
                                total=job.total,
                                message=job.message or INCOMPLETE_SWEEP_MESSAGE,
                            )
                        else:
                            script_status = ScriptStatusOut(
                                state="computing", done=job.done, total=job.total
                            )
            warnings = list(script_ctx.warnings) if script_ctx is not None else []
        finally:
            close_script_context(script_ctx, acquired)
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    columns = [
        TableColumnOut(kind=c.kind, header=c.header, width_px=c.width_px)
        for c in defn.columns
    ]
    rows = [
        TableRowOut(key=list(k), cells=[_cell_out(model, cell) for cell in row])
        for k, row in zip(window, cells)
    ]
    return TablePageOut(
        columns=columns,
        rows=rows,
        total=len(ordered),
        base_total=base_total,
        truncated=truncated,
        offset=payload.offset,
        model_rev=rev,
        warnings=warnings,
        script_status=script_status,
    )


@router.post("/tables/export")
def export_table(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).
    Exports the WHOLE table (every row `build_rows`/`order_rows` produce,
    honoring `max_rows` and the requested sort) as a single-sheet `.xlsx` —
    unlike `/tables/evaluate`, there is no `offset`/`limit` windowing here.

    Cells are evaluated with `max_cell_elements` overridden to effectively
    unbounded (10**9): the interactive page route caps a navigation cell's
    element list at `cell_cap` purely for on-screen display, but an export
    must contain the COMPLETE reached set for every navigation cell — capping
    it here would silently drop data the user asked to export. Row count is
    still governed by `TableLimits.max_rows`; `X-Table-Truncated` is set when
    `build_rows` reports an incomplete row set (its own `max_rows` cap, or an
    underlying navigation that hit its `max_chains`/`max_visited` budget),
    never for cell-level capping (which cannot happen with this override).

    Script columns (spec §4.4): an export is the one route that MUST touch every
    row, so running it inline would be exactly the O(rows) guest grind Phase B
    exists to remove. Instead the whole thing runs CACHE-ONLY and the route
    probes for completeness first; if anything is still uncomputed it kicks/joins
    the background sweep and answers **202 + `Retry-After: 1`** with a
    `ScriptStatusOut` body (the frontend retries on that exact shape) rather than
    downloading a half-computed workbook. The 202-vs-ship decision is made by
    RE-PROBING the cache after the kick/join (decision table at the call site):
    a finished sweep does not imply a complete cache, so "would a retry help"
    — not "is the job over" — is the discriminator. When it would not (a
    terminal sweep that still left holes, or no runner at all) the file ships
    with pending cells as `#ERROR`, flagged by `X-Table-Script-Errors` and a
    trailing notice row."""
    metamodel, model = require_model(session)
    script_ctx = None
    acquired = False
    try:
        defn = _resolve_table(payload, project_id, db)
        sort = (
            SortSpec(column=payload.sort.column, direction=payload.sort.direction)
            if payload.sort is not None
            else None
        )
        if sort is not None and not (0 <= sort.column < len(defn.columns)):
            raise ValueError(
                f"sort column {sort.column} out of range "
                f"(table has {len(defn.columns)} columns)"
            )
        # Export never caps cells: lift the server-wide ceiling AND drop each
        # navigation column's per-column `cell_cap` display preference.
        limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)
        rev = session.model_rev
        script_ctx, acquired = open_script_context(
            runner,
            model,
            settings,
            needs_script=table_has_script(defn),
            cell_cache=session.script_cell_cache,
            rev=rev,
        )
        # Every whole-table pass below (build, order, the completeness probe AND
        # the export render itself) runs CACHE-ONLY: an export must never drive
        # the guest O(rows) times inline (spec §4.4). The flag is set once here
        # and deliberately never cleared.
        if script_ctx is not None:
            script_ctx.cache_only = True
        keys, truncated = build_rows(metamodel, model, defn, limits, script=script_ctx)
        ordered = order_rows(
            metamodel, model, defn, keys, sort, limits, script=script_ctx
        )
        if script_ctx is not None:
            # COMPLETENESS PROBE — do not "optimize" this pass away.
            #
            # `build_rows`/`order_rows` only invoke a script column's `value()`
            # when that column FILTERS (`keep_empty=False`), is the SORT column,
            # or is an EXPAND column. A plain collapse `keep_empty=True` DISPLAY
            # column is invisible to both, so judging completeness from those two
            # passes alone reports `pending_misses == 0` on a stone-cold cache —
            # and the export 200s with a silent `#ERROR` in every row of that
            # column. Rendering every row here is what makes the check honest.
            #
            # It is cheap: cache-only means dict lookups and no guest work, and
            # the per-request memo makes the later `iter_export_rows` render
            # nearly free. The rows are streamed and DISCARDED chunk-by-chunk
            # (`for _ in ...: pass`) exactly like the real render, so the probe
            # never materializes 50 000 rows x every column just to throw them
            # away — it makes the same calls at a bounded peak memory.
            _drain(
                iter_export_rows(
                    metamodel, model, defn, ordered, limits, script=script_ctx
                )
            )
            if script_ctx.pending_misses > 0 and runner is not None:
                # Lock stance: this route holds NO session lock (no write_mutex —
                # same benign-race stance as /tables/evaluate), so kicking is
                # safe even in the sync sweep mode where `kick_or_join_sweep`
                # runs the whole sweep on this thread. We never BLOCK on a job.
                job = kick_or_join_sweep(
                    session, metamodel, model, defn, runner, settings, rev
                )
                status = _status_from_job(job)
                # Terminality is read off the WIRE state, which collapses both
                # DEAD job states (`failed` and `cancelled`) onto `failed` (no
                # thread is behind either), PLUS the `done` job state — which
                # `_status_from_job` deliberately reports as `computing` and so
                # cannot be recovered from `status` alone.
                terminal = status.state == "failed" or job.state == "done"
                #
                # The honest question, once a job exists, is not "did the job
                # finish" but "would a RETRY ACTUALLY HELP", i.e. is the cache
                # complete NOW — and a RE-PROBE (below) is how that gets
                # answered. But the re-probe is only ever CONSULTED for a
                # terminal job:
                #
                #   job state       | re-probe? | answer
                #   ----------------+-----------+------------------------------
                #   running         | SKIPPED   | 202 unconditionally (FIX A) —
                #                   |           | work is genuinely in flight,
                #                   |           | and nothing a re-probe could
                #                   |           | find changes that answer, so
                #                   |           | running it would just be an
                #                   |           | O(rows) navigation-column
                #                   |           | re-walk paid for nothing:
                #                   |           | non-script columns are NOT
                #                   |           | memoized, so this cost would
                #                   |           | repeat every second of a poll
                #                   |           | loop that already knows its
                #                   |           | answer.
                #   terminal, none  | consulted | 202 — the cache IS complete
                #   re-probe misses |           | but THIS request's `ordered`
                #                   |           | predates it (sync sweeps fill
                #                   |           | the cache after the build), so
                #                   |           | retry for correct order and
                #                   |           | real values. The wire `state`
                #                   |           | in the body is forced to
                #                   |           | `computing` here (FIX B) even
                #                   |           | when `job.state` is a DEAD
                #                   |           | `failed`/`cancelled` — the
                #                   |           | retry WILL succeed (the values
                #                   |           | are already in the cache), so
                #                   |           | reporting the job's own dead
                #                   |           | state would tell the client to
                #                   |           | abandon a download the very
                #                   |           | next poll would deliver.
                #   terminal, some  | consulted | fall through — nothing will
                #   re-probe misses |           | ever fill those cells at this
                #                   |           | rev (`ScriptCellCache.put`
                #                   |           | refuses non-deterministic
                #                   |           | error kinds while the sweep
                #                   |           | only aborts on a CONSECUTIVE
                #                   |           | run of them, so one
                #                   |           | intermittently-timing-out cell
                #                   |           | leaves a permanent hole in an
                #                   |           | otherwise `done` sweep), so
                #                   |           | ship the honest terminal
                #                   |           | export (`#ERROR`). Answering
                #                   |           | 202 off `state != "failed"`
                #                   |           | alone would loop forever here
                #                   |           | (same rev => failed-job memory
                #                   |           | hands back the same `done` job
                #                   |           | => `computing` => 202 => ...).
                if not terminal:
                    return JSONResponse(
                        status_code=202,
                        content=status.model_dump(),
                        headers={"Retry-After": "1"},
                    )
                # RE-PROBE (terminal jobs only — see table above). The
                # re-reading is TRUTHFUL despite reusing this context: a
                # `pending` result is never memoized and never written to the
                # cell cache (see `ScriptEvalContext.call`), so every cell that
                # missed the first time re-consults the (now sweep-filled) cell
                # cache instead of being served a stale pending from the memo.
                # Only genuine HITS are memoized, and those were not misses in
                # the first probe either. A fresh miss counter baseline is all
                # that is needed to keep the first probe's misses out of it.
                miss_baseline = script_ctx.pending_misses
                _drain(
                    iter_export_rows(
                        metamodel, model, defn, ordered, limits, script=script_ctx
                    )
                )
                still_pending = script_ctx.pending_misses > miss_baseline
                if not still_pending:
                    # FIX B: the wire body must not say `state: "failed"` here.
                    # This 202 means "the cache filled in behind this request —
                    # retry and you'll get real data", which is true REGARDLESS
                    # of what killed the job (a `done` sweep already reports
                    # `computing` via `_status_from_job`; a `failed`/`cancelled`
                    # one does not, and that mismatch is exactly the bug: the
                    # job is dead, but the DATA it needed is not, because those
                    # cells were satisfied some other way — pre-warmed, or
                    # computed before the abort landed). `ScriptStatusOut`'s own
                    # docstring defines `failed` as work that "will not finish
                    # on its own"; that is false here, so the body must not
                    # claim it. Status code, `Retry-After`, and `done`/`total`
                    # are untouched — only the wire `state` is overridden.
                    body = status.model_dump()
                    body["state"] = "computing"
                    return JSONResponse(
                        status_code=202,
                        content=body,
                        headers={"Retry-After": "1"},
                    )
            # Fall through on a terminal-but-incomplete sweep (or no runner at
            # all) and export with pending rendered as `#ERROR` — the honest
            # terminal answer.

        name = "table"
        if payload.artifact_id is not None:
            row = content.get_artifact(db, payload.artifact_id)
            if row is not None:
                name = row.name
        # Hidden columns are evaluated (a visible column may reference them)
        # but never exported: filter headers/widths AND each row's cells by
        # position.
        visible = [i for i, c in enumerate(defn.columns) if not c.hidden]
        headers = [defn.columns[i].header or defn.columns[i].kind for i in visible]
        widths = [defn.columns[i].width_px for i in visible]
        all_rows = iter_export_rows(
            metamodel, model, defn, ordered, limits, script=script_ctx
        )
        # Baseline for the RENDER's own pending misses (see `_degraded` below).
        # Sampled here, after every probe pass, so only cells that the workbook
        # actually rendered as `#ERROR: not computed` are counted.
        render_miss_baseline = script_ctx.pending_misses if script_ctx else 0

        def _degraded() -> bool:
            """Did this workbook ship any `#ERROR` cell?

            `errored` alone is NOT the answer. A cache-only `pending` result is
            a deliberate non-error (it must not poison the row-order cache, so
            `ScriptEvalContext.call` leaves `errored` False by design) — but
            `table_export.py` still renders it `#ERROR: not computed`. On the
            terminal fall-through above, and on the runner-unavailable path
            (whose context is cache-only too, so its cells come back `pending`
            rather than `unavailable`), EVERY affected cell is `#ERROR` while
            `errored` stays False. Signalling nothing there hands the user a
            workbook that looks authoritative and is entirely `#ERROR`, and a
            programmatic client a clean 200. So OR in the misses the render
            itself recorded. `errored`'s meaning is left untouched."""
            if script_ctx is None:
                return False
            return (
                script_ctx.errored or script_ctx.pending_misses > render_miss_baseline
            )

        def _notice() -> str | None:
            # `row_iter` (and therefore any script column's `value()` calls)
            # is consumed lazily INSIDE `build_workbook` — the flags `_degraded`
            # reads are only fully settled once that consumption finishes, so
            # this must be a callable invoked AFTER the row loop, not a value
            # computed up front.
            if _degraded():
                return (
                    "Some script cells failed, could not be computed, or "
                    "exceeded the evaluation budget; affected cells are "
                    "marked #ERROR."
                )
            return None

        blob = build_workbook(
            model,
            headers,
            widths,
            name,
            ([row[i] for i in visible] for row in all_rows),
            notice_provider=_notice,
        )
        resp_headers = {"Content-Disposition": f'attachment; filename="{name}.xlsx"'}
        if truncated:
            resp_headers["X-Table-Truncated"] = "true"
        if _degraded():  # settled: `build_workbook` has consumed every row
            resp_headers["X-Table-Script-Errors"] = "true"
        return Response(
            content=blob,
            media_type=(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
            headers=resp_headers,
        )
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        close_script_context(script_ctx, acquired)


#: Hard cap on the number of error ITEMS one recap response carries.
#: `total_errors` is always the full count, so a table whose script column
#: fails on every one of 50 000 rows still reports the true scale — it just
#: does not ship 50 000 grid addresses to render a list nobody scrolls. Read
#: as a module global at call time (never captured in a default argument) so a
#: test can lower it.
SCRIPT_ERRORS_CAP = 200

#: Wire message for a cell that is still `pending` after a TERMINAL sweep.
#: Deliberately the same wording `table_export.py` renders into a degraded
#: workbook cell (`#ERROR: not computed`), so the two surfaces agree.
NOT_COMPUTED_MESSAGE = "not computed"


def _collect_script_errors(
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    ordered: list[RowKey],
    limits: TableLimits,
    script_ctx: ScriptEvalContext,
) -> tuple[list[ScriptErrorItemOut], int]:
    """`(items, total)` — one CACHE-ONLY render pass over the WHOLE table,
    collecting every `ErrorCell` (the snippet failed) and every `PendingCell`
    (nothing computed it yet) as an addressable error item.

    `total` counts every hit; `items` stops growing at `SCRIPT_ERRORS_CAP` —
    the caller derives `truncated` from the difference rather than this
    function returning a third flag.

    Rows are streamed through `iter_export_rows` (chunked, like the export
    render) rather than materialized, so the peak memory of a 50 000-row recap
    is one chunk of cells, not the whole grid. `script_ctx` must already be in
    cache-only mode: a miss must record a pending cell, never drive the guest
    O(rows) times inside a request.
    """
    items: list[ScriptErrorItemOut] = []
    total = 0
    for row_index, row in enumerate(
        iter_export_rows(metamodel, model, defn, ordered, limits, script=script_ctx)
    ):
        for column_index, cell in enumerate(row):
            if isinstance(cell, PendingCell):
                message = NOT_COMPUTED_MESSAGE
            elif isinstance(cell, ErrorCell):
                message = cell.message
            else:
                continue
            total += 1
            if len(items) >= SCRIPT_ERRORS_CAP:
                continue
            key = ordered[row_index]
            eid = key[0] if key and isinstance(key[0], str) else None
            column = defn.columns[column_index]
            items.append(
                ScriptErrorItemOut(
                    row_index=row_index,
                    row_element_id=eid,
                    row_label=(
                        display_name(model.elements[eid])
                        if eid is not None and eid in model.elements
                        else None
                    ),
                    column_index=column_index,
                    column_label=column.header or column.kind,
                    message=message,
                )
            )
    return items, total


@router.post("/tables/script-errors")
def table_script_errors(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).

    Whole-table script-error recap. The client only ever renders a WINDOW of a
    virtualized table and the sweep skips already-cached cells, so neither the
    client nor the sweep can enumerate a table's failures — this route is the
    only complete answer, and it is what the error badge/panel jumps from.

    CACHE-ONLY, exactly like `/tables/export`: the whole-table passes never
    drive the guest inline (that O(rows) grind is what Phase B exists to
    remove), so a cell nothing has computed yet comes back `pending` rather
    than being computed here. While a sweep is still filling those holes the
    answer is **202 + `Retry-After: 1`** with a `ScriptStatusOut` body — the
    STATUS CODE, not the body, is the retry signal. After a TERMINAL sweep the
    remaining `pending` cells are reported as ordinary error items ("not
    computed") at 200: failed-job memory hands the same dead job back at this
    rev forever, so another 202 would loop the client until the next commit.

    ORDER: `payload.sort` is forwarded and the whole degrade decision of
    `/tables/evaluate` is reproduced verbatim (order-cache hit first, else
    build+sort, else — if anything went pending — collapse back to build
    order). `row_index` is a GRID ADDRESS: if the recap's order and the page's
    order could ever disagree, jump-to-cell would scroll to the wrong row,
    which is worse than not offering it. Same `TableLimits()` as the page route
    and the sweep for the same reason (export's uncapped limits are a
    display-only difference, but "same inputs" is the invariant worth keeping).
    `EvaluateTableIn` is reused for the payload, but `offset`/`limit` are
    IGNORED here: a recap of a window would defeat the point, so `row_index`
    is always a whole-table index regardless of what the caller sends.

    DEGRADED, NEVER FAILED: no script column, no runner, or no free
    concurrency slot all answer 200 with whatever the cache holds — this route
    must not 5xx any more than the page route may.

    NO RUNNER ⇒ ZERO ERRORS, not N. With `runner is None` every cell of the
    cache-only pass comes back `pending` (cache-only wins over unavailable
    mode) and the sweep kick below is guarded on `runner is not None`, so the
    unguarded route reported one "not computed" error PER CELL — a 50 000-row
    table badged "50000 script errors" when the only true statement is "the
    sandbox isn't running". That count is not merely useless, it is
    confidently wrong: nothing was evaluated, so nothing is known to have
    failed. And it is not information the user is missing either — the page
    route renders those same cells LIVE, so its cells and status strip already
    say the runner is unavailable. The honest recap is empty.
    """
    metamodel, model = require_model(session)
    script_ctx = None
    acquired = False
    try:
        defn = _resolve_table(payload, project_id, db)
        sort = (
            SortSpec(column=payload.sort.column, direction=payload.sort.direction)
            if payload.sort is not None
            else None
        )
        if sort is not None and not (0 <= sort.column < len(defn.columns)):
            raise ValueError(
                f"sort column {sort.column} out of range "
                f"(table has {len(defn.columns)} columns)"
            )
        limits = TableLimits()
        rev = session.model_rev
        script_ctx, acquired = open_script_context(
            runner,
            model,
            settings,
            needs_script=table_has_script(defn),
            cell_cache=session.script_cell_cache,
            rev=rev,
        )
        if script_ctx is None or runner is None:
            # Two ways to have nothing honest to report (see the docstring):
            #   - no script work in this definition at all — `ErrorCell` is only
            #     ever produced by a script column, so the recap is empty by
            #     construction and the whole-table render would be pure waste;
            #   - no runner — every cell would come back `pending` and be
            #     counted as a "not computed" error, which says nothing about
            #     the snippets and is already surfaced by the page route.
            # Both answer the same empty 200 body; the wire shape is unchanged
            # (deliberately no `kind` discriminator — the frontend is built
            # against `ScriptErrorsOut` as it stands).
            return JSONResponse(
                ScriptErrorsOut(errors=[], total_errors=0, truncated=False).model_dump()
            )
        # Set once, deliberately never cleared: EVERY pass below (build, order,
        # the render, and the re-probe) is cache-only.
        script_ctx.cache_only = True
        # Row order, derived exactly as `evaluate_table` derives it (see the
        # docstring). The order cache is CONSULTED but never written: an entry
        # stored from here could only duplicate what the page route already
        # stores, and this route has no window pass, so `script_ctx.errored`
        # settles later here than it does there — the cache-poisoning guard
        # would be reading a different thing under the same name.
        fp = table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), sort)
        sort_key = "none" if sort is None else f"{sort.column}:{sort.direction}"
        cached = session.table_order_cache.get(fp, sort_key, rev)
        if cached is not None:
            ordered = list(cached[0])
        else:
            built = build_rows_ex(metamodel, model, defn, limits, script=script_ctx)
            ordered = order_rows(
                metamodel, model, defn, built.keys, sort, limits, script=script_ctx
            )
            if script_ctx.pending_misses > 0:
                # Same degrade as the page route: a sort computed over
                # half-pending values is not the order the grid is showing.
                ordered = list(built.keys)
        items, total = _collect_script_errors(
            metamodel, model, defn, ordered, limits, script_ctx
        )
        if script_ctx.pending_misses > 0 and runner is not None:
            # Lock stance: this route holds NO session lock (no write_mutex —
            # same benign-race stance as the other table routes), so kicking is
            # safe even in the sync sweep mode where `kick_or_join_sweep` runs
            # the whole sweep on this thread. We never BLOCK on a job.
            job = kick_or_join_sweep(
                session, metamodel, model, defn, runner, settings, rev
            )
            status = _status_from_job(job)
            # Terminality is read off the WIRE state (which collapses both DEAD
            # job states, `failed` and `cancelled`, onto `failed`) PLUS the
            # `done` state, which `_status_from_job` deliberately reports as
            # `computing` and so cannot be recovered from `status` alone. The
            # decision table is `export_table`'s, unchanged:
            #
            #   running         -> 202, no re-probe (work is genuinely in
            #                      flight; a re-probe is an O(rows) re-walk
            #                      that cannot change the answer).
            #   terminal, cache -> 202. The cache filled in BEHIND this
            #   now complete      request, so this pass's `ordered` is the
            #                     degraded build order and its items may name
            #                     rows that now compute fine. One more poll
            #                     returns the clean, correctly SORTED recap.
            #                     The body's `state` is forced to `computing`
            #                     even for a dead job (export's FIX B): the
            #                     retry WILL succeed, so claiming `failed`
            #                     would tell the client to give up on an
            #                     answer the next poll delivers.
            #   terminal, holes -> 200 with those cells as "not computed"
            #   remain            errors. Nothing will fill them at this rev
            #                     (`ScriptCellCache.put` refuses
            #                     non-deterministic error kinds while the
            #                     sweep only aborts on a CONSECUTIVE run of
            #                     them; the cell cache can also LRU-evict the
            #                     sweep's own writes), and failed-job memory
            #                     hands the same job back to every later poll,
            #                     so a 202 here loops forever.
            terminal = status.state == "failed" or job.state == "done"
            if not terminal:
                return JSONResponse(
                    status_code=202,
                    content=status.model_dump(),
                    headers={"Retry-After": "1"},
                )
            # RE-PROBE (terminal jobs only). Truthful despite reusing this
            # context: a `pending` result is never memoized and never written
            # to the cell cache, so every cell that missed re-consults the
            # (now sweep-filled) cache, while cells already in hand come from
            # the memo — no fresh guest work, no double counting.
            miss_baseline = script_ctx.pending_misses
            re_items, re_total = _collect_script_errors(
                metamodel, model, defn, ordered, limits, script_ctx
            )
            if script_ctx.pending_misses == miss_baseline:
                body = status.model_dump()
                body["state"] = "computing"
                return JSONResponse(
                    status_code=202,
                    content=body,
                    headers={"Retry-After": "1"},
                )
            items, total = re_items, re_total
        # Falls through here on: a complete cache (the common case) and a
        # terminal sweep whose re-probe still missed. The no-runner case does
        # NOT reach here — it returns the empty recap ~100 lines above (see the
        # docstring: a runnerless recap would count one "not computed" error
        # per cell for something no snippet did).
        return JSONResponse(
            ScriptErrorsOut(
                errors=items,
                total_errors=total,
                truncated=total > len(items),
            ).model_dump()
        )
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        close_script_context(script_ctx, acquired)
