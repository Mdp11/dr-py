"""Table evaluation (read-only; viewer-callable). Resolves navigation refs, then
builds/sorts/pages rows through the pure core evaluator, caching the ordered row
list per session. No write_mutex — same benign-race stance as routes/read.py."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session as DbSession

from data_rover.core.model.model import Model
from data_rover.core.navigation.resolve import NavigationResolveError
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, NavigationDefinition
from data_rover.core.table.cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ValueCell,
    ValuesCell,
    evaluate_cells,
)
from data_rover.core.table.evaluate import (
    SortSpec,
    TableLimits,
    build_rows,
    iter_export_rows,
    order_rows,
)
from data_rover.core.table.resolve import _resolve_table_navigation_refs
from data_rover.core.table.schema import TABLE_ADAPTER, TableDefinition

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind
from ..deps import Session, get_request_session, require_model
from ..schemas import (
    EvaluateTableIn,
    TableCellOut,
    TableColumnOut,
    TablePageOut,
    TableRowOut,
)
from ..table_cache import table_fingerprint
from ..table_export import build_workbook
from .read import _tree_item

router = APIRouter()


def _resolve_table(
    payload: EvaluateTableIn, project_id: str, db: DbSession
) -> TableDefinition:
    """The table's own definition (from `artifact_id` or inline), with every
    embedded navigation ref inlined via `_resolve_table_navigation_refs` — the
    core evaluator (Tasks 4-6) assumes a fully ref-free definition."""
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

    return _resolve_table_navigation_refs(defn, _fetch)


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
    assert isinstance(cell, ElementsCell)
    return TableCellOut(
        kind="elements",
        items=[_tree_item(model, e) for e in cell.element_ids],
        total=cell.total,
        truncated=cell.truncated,
    )


@router.post("/tables/evaluate")
def evaluate_table(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> TablePageOut:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).
    Row ORDER is cached per session (Task 7's TableOrderCache) keyed on the
    RESOLVED definition's fingerprint + sort + model_rev, so paging through a
    large table re-evaluates cells per page but not the (possibly expensive)
    row build+sort. No write_mutex — same benign-race stance as
    routes/read.py: a concurrent mutation simply misses the cache (stale
    model_rev) rather than corrupting it."""
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
        cached = session.table_order_cache.get(fp, sort_key, rev)
        if cached is not None:
            cached_rows, truncated = cached
            ordered = list(cached_rows)
        else:
            keys, truncated = build_rows(metamodel, model, defn, limits)
            ordered = order_rows(metamodel, model, defn, keys, sort, limits)
            session.table_order_cache.put(fp, sort_key, rev, tuple(ordered), truncated)
        window = ordered[payload.offset : payload.offset + payload.limit]
        cells = evaluate_cells(metamodel, model, defn, window, limits)
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
        truncated=truncated,
        offset=payload.offset,
        model_rev=rev,
    )


@router.post("/tables/export")
def export_table(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
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
        keys, truncated = build_rows(metamodel, model, defn, limits)
        ordered = order_rows(metamodel, model, defn, keys, sort, limits)
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    name = "table"
    if payload.artifact_id is not None:
        row = content.get_artifact(db, payload.artifact_id)
        if row is not None:
            name = row.name
    headers = [c.header or c.kind for c in defn.columns]
    widths = [c.width_px for c in defn.columns]
    blob = build_workbook(
        model,
        headers,
        widths,
        name,
        iter_export_rows(metamodel, model, defn, ordered, limits),
    )
    resp_headers = {"Content-Disposition": f'attachment; filename="{name}.xlsx"'}
    if truncated:
        resp_headers["X-Table-Truncated"] = "true"
    return Response(
        content=blob,
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers=resp_headers,
    )
