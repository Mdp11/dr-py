"""Table evaluation (read-only; viewer-callable). Resolves navigation refs, then
builds/sorts/pages rows through the pure core evaluator, caching the ordered row
list per session. No write_mutex — same benign-race stance as routes/read.py."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session as DbSession

from data_rover.core.model.model import Model
from data_rover.core.navigation.resolve import NavigationResolveError
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, NavigationDefinition
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
    SortSpec,
    TableLimits,
    build_rows,
    build_rows_ex,
    iter_export_rows,
    order_rows,
)
from data_rover.core.table.resolve import resolve_table_refs, table_has_script
from data_rover.core.table.schema import TABLE_ADAPTER, TableDefinition

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind
from ..deps import Session, get_request_session, require_model
from ..schemas import (
    EvaluateTableIn,
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
    `pending` cell can never be reported as `ready`.

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
    never for cell-level capping (which cannot happen with this override)."""
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
        keys, truncated = build_rows(metamodel, model, defn, limits, script=script_ctx)
        ordered = order_rows(
            metamodel, model, defn, keys, sort, limits, script=script_ctx
        )

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

        def _notice() -> str | None:
            # `row_iter` (and therefore any script column's `value()` calls)
            # is consumed lazily INSIDE `build_workbook` — `script_ctx.errored`
            # is only fully settled once that consumption finishes, so this
            # must be a callable invoked AFTER the row loop, not a value
            # computed up front.
            if script_ctx is not None and script_ctx.errored:
                return (
                    "Some script cells failed or exceeded the evaluation "
                    "budget; affected cells are marked #ERROR."
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
        if script_ctx is not None and script_ctx.errored:
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
