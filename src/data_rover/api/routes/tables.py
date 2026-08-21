"""Table evaluation (read-only; viewer-callable). Resolves navigation refs, then
builds/sorts/pages rows through the pure core evaluator, caching the ordered row
list per session. No write_mutex — same benign-race stance as routes/read.py."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.navigation.resolve import NavigationResolveError
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, NavigationDefinition
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.lint import derive_entry_points
from data_rover.core.script.runner import ScriptRunner
from data_rover.core.script.schema import SNIPPET_ADAPTER, SnippetDefinition
from data_rover.core.script.warnings import ScriptWarningCode
from data_rover.core.table.cells import (
    NOT_COMPUTED_MESSAGE,
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
    RowKey,
    SortSpec,
    TableLimits,
    build_rows_ex,
    iter_export_rows,
    order_rows,
    sort_falls_back_to_build_order,
)
from data_rover.core.table.export_layout import (
    export_definition,
    export_layout,
)
from data_rover.core.table.json_export import render_json
from data_rover.core.table.resolve import resolve_table_refs, table_has_script
from data_rover.core.table.schema import TABLE_ADAPTER, TableDefinition

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind
from ..deps import Session, get_request_session, require_model
from ..schemas import (
    EvaluateTableIn,
    ExportTableIn,
    JsonPreviewOut,
    ScriptErrorItemOut,
    ScriptErrorsOut,
    ScriptStatusOut,
    ScriptWarningOut,
    TableCellOut,
    TableColumnOut,
    TablePageOut,
    TableRowOut,
)
from ..script_eval import close_script_context, open_script_context
from ..script_runner import get_runner
from ..script_sweep import kick_or_join_sweep
from ..settings import Settings, get_settings
from ..table_cache import table_fingerprint
from ..table_export_engine import (
    MEDIA_TYPES,
    ExportPending,
    TransformUnavailableError,
    build_zip,
    export_context_vars,
    open_transform_host,
    run_table_export,
)
from ..table_export_engine import status_from_job as _status_from_job
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


def _resolve_transform_code(db: DbSession, project_id: str, ref: str, name: str) -> str:
    """Resolve a transform ref (spec §8) to its snippet CODE, strictly.

    Deliberately NOT the tolerant `_fetch_snippet`/resolve path script
    columns use: a dangling script-column ref degrades to error cells, but a
    dangling transform is a functional-contract hole — silently skipping it
    ships untransformed data — so every failure is a ValueError naming
    `name` (the routes' 422 mapping). The entry point is RE-DERIVED from the
    code, never read off the stored `entry_points` (advisory metadata only —
    core/script/schema.py — and stale for any snippet last written before
    "transform" joined _ENTRY_NAMES)."""
    r = content.get_artifact(db, ref)
    if (
        r is None
        or r.project_id != project_id
        or r.kind is not ArtifactKind.code_snippet
    ):
        raise ValueError(f"{name}: unknown transform snippet {ref}")
    snippet = SNIPPET_ADAPTER.validate_python(r.payload)
    if "transform" not in derive_entry_points(snippet.code):
        raise ValueError(
            f"{name}: snippet {ref} does not define a one-argument "
            "top-level transform(doc)"
        )
    return snippet.code


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
                if script_ctx is not None and sort_falls_back_to_build_order(
                    defn, sort
                ):
                    script_ctx.add_warning(ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)
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
            warnings = (
                [ScriptWarningOut.from_core(w) for w in script_ctx.warnings]
                if script_ctx is not None
                else []
            )
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
    payload: ExportTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).
    Thin route: resolves the table/sort, names the file from the artifact
    (falling back to `"table"`), and delegates the actual export to
    `table_export_engine.run_table_export` — see that function's docstring
    for the evaluation/pending/degradation mechanics shared with
    `POST /exports/run`.

    `payload.format` (default `"xlsx"`) picks what ships: a single `.xlsx`
    workbook, a single `.json` document, OR — when `json_split` is enabled
    on the table (P-13) and produced more than one file — an
    `application/zip` named `{name}.zip` bundling them (`build_zip`; same
    zip shape `/exports/run` uses for a whole exporter bundle). An
    `ExportPending` result short-circuits to the shared 202 protocol:
    `Retry-After: 1` with a `ScriptStatusOut` body the frontend polls on.

    `defn.transform` (spec §8) is the table's OWN transform, applied ONLY
    here: an `/exports/run` entry over the same table artifact renders
    UNtransformed (no-bleed — the entry's own `transform: None` unless it
    sets one, Task 7's concern, not this route's)."""
    metamodel, model = require_model(session)
    transform_host = None
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
        name = "table"
        if payload.artifact_id is not None:
            row = content.get_artifact(db, payload.artifact_id)
            if row is not None:
                name = row.name
        transform_code: str | None = None
        if defn.transform is not None:
            transform_code = _resolve_transform_code(
                db, project_id, defn.transform.ref, name
            )
            transform_host = open_transform_host(runner, model, settings)
        result = run_table_export(
            session=session,
            settings=settings,
            runner=runner,
            metamodel=metamodel,
            model=model,
            defn=defn,
            render_defn=defn,
            name=name,
            format=payload.format,
            sort=sort,
            template_vars=export_context_vars(session, project_id),
            transform_code=transform_code,
            transform_host=transform_host,
        )
        if isinstance(result, ExportPending):
            return JSONResponse(
                status_code=202,
                content=result.status.model_dump(),
                headers={"Retry-After": "1"},
            )
        if result.archive or len(result.files) > 1:
            blob = build_zip(result.files)
            media_type = "application/zip"
            filename = f"{name}.zip"
        else:
            filename, blob = result.files[0]
            media_type = MEDIA_TYPES.get(
                filename.rpartition(".")[2], "application/octet-stream"
            )
        resp_headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        if result.truncated:
            resp_headers["X-Table-Truncated"] = "true"
        if result.degraded:
            resp_headers["X-Table-Script-Errors"] = "true"
        return Response(content=blob, media_type=media_type, headers=resp_headers)
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TransformUnavailableError as exc:
        raise HTTPException(
            status_code=429 if exc.busy else 503, detail=str(exc)
        ) from exc
    finally:
        if transform_host is not None:
            transform_host.close()


#: Rows the preview renders before it stops. Read as a module global at call
#: time (never captured in a default argument) so a test can lower it.
PREVIEW_MAX_ROWS = 200


@router.post("/tables/json-preview")
def json_preview(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> JsonPreviewOut:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).

    Exists so the JSON-export settings UI can show a live sample WITHOUT
    reimplementing the grouping algorithm in TypeScript, where it would drift
    from `core/table/json_export.py`. Same renderer, bounded input.

    Bounded and CACHE-ONLY: it never kicks a script sweep and never answers
    202. A script cell that has not been computed simply renders its `$error`
    marker in the sample, which is the honest preview of what a user would get
    if they exported right now.

    The final top-level object is DROPPED when the window did not cover the
    whole table — a cheap heuristic, not a completeness guarantee. Grouping
    merges rows by key through a dict (see `render_json`), and a sort can
    scatter one group's rows across `ordered` so they are not contiguous;
    dropping only the last object assumes contiguity and catches just the
    common case where a sort keeps a group's rows together. When rows ARE
    scattered, an earlier-shown group can be truncated too — its window-cut
    array will look complete but be missing members that fall past
    `PREVIEW_MAX_ROWS`. So: when `truncated` is true, ANY object in `sample`
    may be short, not only the last one. Dropping the last object still avoids
    leaving the pane blank when a single group is wider than the window (the
    lone remaining object is then itself approximate), so it is kept despite
    not being a guarantee.
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
        # Same uncapped cell limits as the export: a preview whose navigation
        # arrays were capped at 20 would not be a preview of the export.
        limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)
        script_ctx, acquired = open_script_context(
            runner,
            model,
            settings,
            needs_script=table_has_script(defn),
            cell_cache=session.script_cell_cache,
            rev=session.model_rev,
        )
        if script_ctx is not None:
            script_ctx.cache_only = True
        build = build_rows_ex(metamodel, model, defn, limits, script=script_ctx)
        keys = build.keys
        ordered = order_rows(
            metamodel, model, defn, keys, sort, limits, script=script_ctx
        )
        window = ordered[:PREVIEW_MAX_ROWS]
        truncated = len(ordered) > len(window)
        layout = export_layout(defn)
        docs = render_json(
            model,
            export_definition(defn),
            window,
            iter_export_rows(metamodel, model, defn, window, limits, script=script_ctx),
            build.base_slots,
            order=layout.rank,
            row_number=(layout.row_number_pos, layout.row_number_key)
            if layout.row_number_pos is not None
            else None,
        )
        if truncated and len(docs) > 1:
            docs = docs[:-1]
        return JsonPreviewOut(
            sample=json.dumps(docs, ensure_ascii=False, indent=2),
            truncated=truncated,
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
