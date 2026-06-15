"""Paged/on-demand read endpoints (Phase C2-read of the large-model overhaul).

The frontend currently downloads the whole model (~80 MB) to browse it; these
endpoints serve the same UI features server-side so it can fetch summaries,
search results, graph neighborhoods, containment-tree levels, and the pending
change set on demand. Each handler is a faithful port of the client-side
logic it replaces (file references on the handlers) computed over the
:class:`~data_rover.core.model.indexes.IndexSet` instead of full scans where
an index exists. All endpoints are strictly read-only: no session field is
mutated, ``model_rev`` does not move, no op-log entry is produced.

Ordering contracts (deterministic paging)
-----------------------------------------
- element listing: model insertion order; with ``q`` score-descending then
  id ascending (ports ``Sidebar/Search.svelte`` scoring; plain string
  comparison stands in for ``localeCompare``)
- neighborhood: nodes in BFS discovery order (per frontier node, incident
  relationship ids ascending), edges sorted by relationship id
- per-element relationships: relationship id ascending
- containment roots, excluded pool and children: display-name then id
  ascending (the order ``Sidebar/ContainmentTree.svelte`` renders; a paged
  client cannot re-sort a level, so the server emits render order)
- /model/changes: entities in first-touch op-log order, partitioned into
  added/modified/deleted
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.view.schema import Folder, View

from ..changes import compact_changes
from ..deps import Session, get_session, require_model
from ..schemas import (
    ChangesOut,
    ChangesSummaryOut,
    ContainmentItem,
    ContainmentPage,
    CrBaseline,
    ElementOut,
    ElementPage,
    ModelSummary,
    NeighborhoodOut,
    RelationshipOut,
    RelationshipPage,
)

router = APIRouter()

#: hard cap on ``limit`` for every paged endpoint in this module
MAX_PAGE_LIMIT = 500


class BatchElementsIn(BaseModel):
    ids: list[str]


class BatchElementsOut(BaseModel):
    items: list[ElementOut]


def _require_element(model: Model, element_id: str) -> None:
    """404 via KeyError so the whole /model/elements/{id} resource family
    shares the errors.py ``{"error": ...}`` envelope (the single-element GET
    in routes/elements.py 404s through ``Model.get_element``'s KeyError)."""
    if element_id not in model.elements:
        raise KeyError(f"No element with id {element_id!r}")


# ---------------------------------------------------------------------------
# GET /model/summary
# ---------------------------------------------------------------------------


def model_summary(session: Session) -> ModelSummary:
    """Build the GET /model/summary payload for the current session model.

    Shared with the Phase C3 load endpoints (routes/model.py), which return
    this exact shape after installing a freshly loaded model. 404s through
    ``require_model`` when no model is loaded.
    """
    _, model = require_model(session)
    return ModelSummary(
        model_rev=session.model_rev,
        element_count=len(model.elements),
        relationship_count=len(model.relationships),
        elements_by_type={
            name: len(ids)
            for name, ids in sorted(model.indexes.elements_by_type.items())
        },
        issue_counts=(
            session.validation.counts() if session.validation is not None else None
        ),
        undo_depth=len(session.op_log),
    )


@router.get("/model/summary")
def get_model_summary(session: Session = Depends(get_session)) -> ModelSummary:
    """Cheap whole-model statistics for headers/status bars.

    ``issue_counts`` is ``None`` until a full validation run has seeded the
    session issue store (POST /model/validate without scope, the C3 load
    endpoints, or the first accepted ops batch) — "not validated" is
    distinct from "zero issues".
    """
    return model_summary(session)


# ---------------------------------------------------------------------------
# GET /model/elements — paged listing + search
# ---------------------------------------------------------------------------


def _search_score(element: Element, q: str, type_matches: bool) -> float:
    """Port of the scoring loop in ``Sidebar/Search.svelte``.

    ``q`` must already be trimmed + lowercased and non-empty. Substring
    matches score: name property +2, id +1, type name +1, every other
    string-valued property +0.5; an element with score 0 is not a hit.
    ``type_matches`` is the type-name check, hoisted out so the caller can
    memoize it per distinct type instead of re-lowercasing per element.
    """
    score = 0.0
    props = element.properties
    name = props.get("name")
    if isinstance(name, str) and q in name.lower():
        score += 2.0
    if q in element.id.lower():
        score += 1.0
    if type_matches:
        score += 1.0
    for key, value in props.items():
        if key == "name":
            continue
        if isinstance(value, str) and q in value.lower():
            score += 0.5
    return score


@router.get("/model/elements")
def list_elements(
    type: str | None = None,
    q: str | None = None,
    limit: int = Query(100, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
) -> ElementPage:
    """Paged element listing with optional exact-type filter and search.

    Without ``q`` items come in model insertion order; with ``q`` they are
    ranked by the Search.svelte score (descending) with id-ascending
    tiebreak. ``total`` counts all matches BEFORE paging. A blank ``q``
    (empty/whitespace) is treated as absent, mirroring the frontend.
    """
    _, model = require_model(session)
    query = (q or "").strip().lower()

    if query:
        hits: list[tuple[float, str]] = []
        #: per-request memo: does ``query`` match this type name? (saves one
        #: lowercase + substring scan per element on large models)
        type_matches: dict[str, bool] = {}
        for element in model.elements.values():
            if type is not None and element.type_name != type:
                continue
            tn = element.type_name
            matches = type_matches.get(tn)
            if matches is None:
                matches = query in tn.lower()
                type_matches[tn] = matches
            score = _search_score(element, query, matches)
            if score > 0:
                hits.append((-score, element.id))
        hits.sort()
        return ElementPage(
            items=[
                ElementOut.from_core(model.elements[eid])
                for _, eid in hits[offset : offset + limit]
            ],
            total=len(hits),
        )

    if type is not None:
        total = len(model.indexes.elements_by_type.get(type) or ())
    else:
        total = len(model.elements)
    items: list[ElementOut] = []
    if offset < total:
        skipped = 0
        for element in model.elements.values():
            if type is not None and element.type_name != type:
                continue
            if skipped < offset:
                skipped += 1
                continue
            items.append(ElementOut.from_core(element))
            if len(items) >= limit:
                break
    return ElementPage(items=items, total=total)


# ---------------------------------------------------------------------------
# POST /model/elements/batch — fetch many elements by id in one request
# ---------------------------------------------------------------------------


@router.post("/model/elements/batch")
def batch_elements(
    payload: BatchElementsIn,
    session: Session = Depends(get_session),
) -> BatchElementsOut:
    """Fetch many elements by id in one request. Ids are returned in request
    order (duplicates produce duplicate results); unknown/deleted ids are
    silently omitted (a stale window id must not fail the whole batch). Caps at
    MAX_PAGE_LIMIT ids (422 above)."""
    _, model = require_model(session)
    if len(payload.ids) > MAX_PAGE_LIMIT:
        raise HTTPException(
            status_code=422,
            detail=f"too many ids: {len(payload.ids)} (max {MAX_PAGE_LIMIT})",
        )
    items = [
        ElementOut.from_core(model.elements[eid])
        for eid in payload.ids
        if eid in model.elements
    ]
    return BatchElementsOut(items=items)


# ---------------------------------------------------------------------------
# GET /model/elements/{id}/neighborhood — BFS graph extraction
# ---------------------------------------------------------------------------


@router.get("/model/elements/{element_id}/neighborhood")
def get_neighborhood(
    element_id: str,
    hops: int = Query(2, ge=1, le=5),
    cap: int = Query(60, ge=1, le=MAX_PAGE_LIMIT),
    session: Session = Depends(get_session),
) -> NeighborhoodOut:
    """Port of ``buildGraph`` in ``Workspace/graph-data.ts`` over the IndexSet.

    Frontier-by-frontier BFS treating relationships as undirected, with
    ``cap`` as a hard cap on the node count: once reached, every further
    undiscovered neighbor sets ``truncated`` and is dropped (matching the
    frontend's continue-not-break). Edges are every relationship whose BOTH
    endpoints made it into the node set. O(visited · degree); discovery
    order is per frontier node, incident relationship ids ascending (the
    frontend scans the global relationship list instead, so under
    truncation the surviving node CHOICE can differ — the semantics of
    hops/cap/truncated are identical).
    """
    _, model = require_model(session)
    _require_element(model, element_id)
    idx = model.indexes
    rels = model.relationships

    hops_by_id: dict[str, int] = {element_id: 0}
    node_ids: list[str] = [element_id]
    truncated = False
    frontier: list[str] = [element_id]
    for depth in range(hops):
        next_frontier: list[str] = []
        for fid in frontier:
            for rid in sorted(idx.outgoing_ids(fid) | idx.incoming_ids(fid)):
                rel = rels[rid]
                candidates: list[str] = []
                if rel.source_id == fid and rel.target_id not in hops_by_id:
                    candidates.append(rel.target_id)
                if rel.target_id == fid and rel.source_id not in hops_by_id:
                    candidates.append(rel.source_id)
                for cand in candidates:
                    if cand in hops_by_id:
                        continue
                    if len(node_ids) >= cap:
                        truncated = True
                        continue
                    hops_by_id[cand] = depth + 1
                    node_ids.append(cand)
                    next_frontier.append(cand)
        if not next_frontier:
            break
        frontier = next_frontier

    edge_ids: set[str] = set()
    for nid in node_ids:
        for rid in idx.outgoing_ids(nid):
            if rels[rid].target_id in hops_by_id:
                edge_ids.add(rid)
    return NeighborhoodOut(
        nodes=[ElementOut.from_core(model.elements[nid]) for nid in node_ids],
        edges=[RelationshipOut.from_core(rels[rid]) for rid in sorted(edge_ids)],
        hops_by_id=hops_by_id,
        truncated=truncated,
    )


# ---------------------------------------------------------------------------
# GET /model/elements/{id}/relationships
# ---------------------------------------------------------------------------


@router.get("/model/elements/{element_id}/relationships")
def list_element_relationships(
    element_id: str,
    direction: Literal["both", "in", "out"] = "both",
    limit: int = Query(100, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
) -> RelationshipPage:
    """Relationships incident to one element, sorted by relationship id,
    paged (a hub element can have an arbitrarily large incident set).

    ``both`` deduplicates self-loops (a relationship whose source and target
    are both this element appears once). ``total`` counts the whole incident
    set BEFORE paging.
    """
    _, model = require_model(session)
    _require_element(model, element_id)
    idx = model.indexes
    if direction == "out":
        ids = set(idx.outgoing_ids(element_id))
    elif direction == "in":
        ids = set(idx.incoming_ids(element_id))
    else:
        ids = set(idx.outgoing_ids(element_id)) | set(idx.incoming_ids(element_id))
    return RelationshipPage(
        items=[
            RelationshipOut.from_core(model.relationships[rid])
            for rid in sorted(ids)[offset : offset + limit]
        ],
        total=len(ids),
    )


# ---------------------------------------------------------------------------
# Containment tree levels (Sidebar/ContainmentTree.svelte semantics)
# ---------------------------------------------------------------------------


def _display_name(element: Element) -> str:
    """``displayName`` in ContainmentTree.svelte: non-empty name prop or id."""
    name = element.properties.get("name")
    return name if isinstance(name, str) and name else element.id


def _containment_child_ids(model: Model, element_id: str) -> list[str]:
    """Distinct elements whose FIRST containment parent is *element_id*.

    "First containment parent wins" exactly as in ContainmentTree.svelte:
    a child with containment edges from several parents belongs only to the
    parent of its first such edge (relationship insertion order — which is
    what ``IndexSet.first_parent`` returns). Unsorted (incident-set order);
    callers sort.
    """
    idx = model.indexes
    out: dict[str, None] = {}
    for rid in idx.outgoing_ids(element_id):
        rel = model.relationships[rid]
        if not model.metamodel.is_containment(rel.type_name):
            continue
        child = rel.target_id
        if child not in out and idx.first_parent(child) == element_id:
            out[child] = None
    return list(out)


def _containment_item(model: Model, element_id: str) -> ContainmentItem:
    return ContainmentItem(
        element=ElementOut.from_core(model.elements[element_id]),
        child_count=len(_containment_child_ids(model, element_id)),
    )


@router.get("/model/containment/roots")
def list_containment_roots(
    limit: int = Query(100, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
) -> ContainmentPage:
    """Elements with no containment parent, sorted by display name then id.

    Display-name order (not insertion order) on purpose, exactly like
    ``list_containment_children``: it is the order ContainmentTree.svelte renders
    the root level in, and a paged client cannot re-sort a level it only holds
    one page of — re-sorting an accumulated prefix would make scroll auto-load
    reshuffle rows above the viewport (a visible "jump").
    """
    _, model = require_model(session)
    idx = model.indexes
    root_ids = [eid for eid in model.elements if idx.first_parent(eid) is None]
    root_ids.sort(key=lambda eid: (_display_name(model.elements[eid]), eid))
    return ContainmentPage(
        items=[
            _containment_item(model, eid) for eid in root_ids[offset : offset + limit]
        ],
        total=len(root_ids),
    )


def _placed_element_ids(view: View) -> set[str]:
    """All element ids referenced anywhere in the view's folder tree."""
    out: set[str] = set()

    def walk(folders: list[Folder]) -> None:
        for folder in folders:
            out.update(folder.elements)
            walk(folder.folders)

    walk(view.folders)
    return out


@router.get("/model/containment/roots/excluded")
def list_excluded_roots(
    limit: int = Query(100, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
) -> ContainmentPage:
    """Containment roots NOT placed in the active view (the 'excluded pool').
    Sorted by display name then id, like ``list_containment_roots`` (so the
    paged pool grows by appending, never reshuffling). With no active view,
    every root is excluded (returns all roots)."""
    _, model = require_model(session)
    idx = model.indexes
    placed = _placed_element_ids(session.view) if session.view is not None else set()
    root_ids = [
        eid
        for eid in model.elements
        if idx.first_parent(eid) is None and eid not in placed
    ]
    root_ids.sort(key=lambda eid: (_display_name(model.elements[eid]), eid))
    return ContainmentPage(
        items=[
            _containment_item(model, eid) for eid in root_ids[offset : offset + limit]
        ],
        total=len(root_ids),
    )


@router.get("/model/elements/{element_id}/children")
def list_containment_children(
    element_id: str,
    limit: int = Query(100, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
) -> ContainmentPage:
    """Containment children of one element, sorted by display name then id.

    Display-name order (not insertion order) on purpose: it is the order
    ContainmentTree.svelte renders a level in, and a paged client cannot
    re-sort a level it only holds one page of.
    """
    _, model = require_model(session)
    _require_element(model, element_id)
    child_ids = _containment_child_ids(model, element_id)
    child_ids.sort(key=lambda cid: (_display_name(model.elements[cid]), cid))
    return ContainmentPage(
        items=[
            _containment_item(model, cid) for cid in child_ids[offset : offset + limit]
        ],
        total=len(child_ids),
    )


# ---------------------------------------------------------------------------
# GET /model/changes — op log compacted into a datarover.cr/v1 document
# (compaction engine lives in api/changes.py, shared with the C3 save flow)
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    """UTC timestamp in the shape JS ``Date.toISOString()`` produces."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


@router.get("/model/changes")
def get_changes(session: Session = Depends(get_session)) -> ChangesOut:
    """The pending change set as a ``datarover.cr/v1`` change request.

    Same JSON shape as the frontend's ``buildChangeRequest`` export (plus
    ``complete``), and round-trip applicable: POSTing the BASE model
    snapshot together with this document to /model/apply-cr reproduces the
    current session model entity-wise. ``baseline`` counts describe the BASE
    model (current counts minus adds plus deletes); ``filename`` is null —
    the server does not know what file the model came from. With an empty
    op log the document has empty op lists (200, not an error).
    """
    _, model = require_model(session)
    ops = compact_changes(model, session.op_log)
    return ChangesOut(
        createdAt=_now_iso(),
        baseline=CrBaseline(
            filename=None,
            elementCount=len(model.elements)
            - len(ops.elements.added)
            + len(ops.elements.deleted),
            relationshipCount=len(model.relationships)
            - len(ops.relationships.added)
            + len(ops.relationships.deleted),
        ),
        ops=ops,
        complete=session.op_log_dropped == 0,
    )


@router.get("/model/changes/summary")
def get_changes_summary(
    session: Session = Depends(get_session),
) -> ChangesSummaryOut:
    """Counts over the COMPACTED change set (same compaction as
    /model/changes, so e.g. create-then-delete histories count zero ops)."""
    _, model = require_model(session)
    ops = compact_changes(model, session.op_log)
    adds = len(ops.elements.added) + len(ops.relationships.added)
    modifies = len(ops.elements.modified) + len(ops.relationships.modified)
    deletes = len(ops.elements.deleted) + len(ops.relationships.deleted)
    return ChangesSummaryOut(
        batches=len(session.op_log),
        ops=adds + modifies + deletes,
        adds=adds,
        modifies=modifies,
        deletes=deletes,
        complete=session.op_log_dropped == 0,
    )
