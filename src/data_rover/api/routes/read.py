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
- containment roots: model insertion order; children: display-name then id
  ascending (the order ``Sidebar/ContainmentTree.svelte`` renders)
- /model/changes: entities in first-touch op-log order, partitioned into
  added/modified/deleted
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from typing_extensions import assert_never

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model

from ..deps import Session, get_session, require_model
from ..schemas import (
    ChangesOut,
    ChangesSummaryOut,
    ContainmentItem,
    ContainmentPage,
    CrBaseline,
    CrElementOps,
    CrOps,
    CrRelationshipOps,
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ElementOut,
    ElementPage,
    ModelSummary,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    NeighborhoodOut,
    OpIn,
    RelationshipList,
    RelationshipOut,
    UpdateElementOp,
    UpdateRelationshipOp,
)
from ..session import AppliedBatch

router = APIRouter()

#: hard cap on ``limit`` for every paged endpoint in this module
MAX_PAGE_LIMIT = 500


def _require_element(model: Model, element_id: str) -> None:
    if element_id not in model.elements:
        raise HTTPException(
            status_code=404, detail=f"No element with id {element_id!r}"
        )


# ---------------------------------------------------------------------------
# GET /model/summary
# ---------------------------------------------------------------------------


@router.get("/model/summary")
def get_model_summary(session: Session = Depends(get_session)) -> ModelSummary:
    """Cheap whole-model statistics for headers/status bars.

    ``issue_counts`` is ``None`` until a full validation run has seeded the
    session issue store (POST /model/validate without scope, or the first
    accepted ops batch) — "not validated" is distinct from "zero issues".
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


# ---------------------------------------------------------------------------
# GET /model/elements — paged listing + search
# ---------------------------------------------------------------------------


def _search_score(element: Element, q: str) -> float:
    """Port of the scoring loop in ``Sidebar/Search.svelte``.

    ``q`` must already be trimmed + lowercased and non-empty. Substring
    matches score: name property +2, id +1, type name +1, every other
    string-valued property +0.5; an element with score 0 is not a hit.
    """
    score = 0.0
    props = element.properties
    name = props.get("name")
    if isinstance(name, str) and q in name.lower():
        score += 2.0
    if q in element.id.lower():
        score += 1.0
    if q in element.type_name.lower():
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
        for element in model.elements.values():
            if type is not None and element.type_name != type:
                continue
            score = _search_score(element, query)
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
    session: Session = Depends(get_session),
) -> RelationshipList:
    """Relationships incident to one element, sorted by relationship id.

    ``both`` deduplicates self-loops (a relationship whose source and target
    are both this element appears once).
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
    return RelationshipList(
        items=[
            RelationshipOut.from_core(model.relationships[rid]) for rid in sorted(ids)
        ]
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
    """Elements with no containment parent, in model insertion order
    (ContainmentTree renders roots unsorted)."""
    _, model = require_model(session)
    idx = model.indexes
    root_ids = [eid for eid in model.elements if idx.first_parent(eid) is None]
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
# ---------------------------------------------------------------------------


@dataclass
class _ElState:
    type_name: str
    properties: dict[str, Any]


@dataclass
class _RelState:
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any]


def _merge_patch(props: dict[str, Any], patch: dict[str, Any]) -> None:
    """JSON-merge-patch over a scratch property dict (None deletes the key)."""
    for key, value in patch.items():
        if value is None:
            props.pop(key, None)
        else:
            props[key] = value


def _touch(
    op: OpIn, touched_els: dict[str, None], touched_rels: dict[str, None]
) -> None:
    if isinstance(op, CreateElementOp):
        touched_els.setdefault(op.temp_id)
    elif isinstance(op, (UpdateElementOp, DeleteElementOp)):
        touched_els.setdefault(op.id)
    elif isinstance(op, CreateRelationshipOp):
        touched_rels.setdefault(op.temp_id)
    elif isinstance(op, (UpdateRelationshipOp, DeleteRelationshipOp)):
        touched_rels.setdefault(op.id)
    else:
        assert_never(op)


def _apply_inverse(
    op: OpIn, el_state: dict[str, _ElState], rel_state: dict[str, _RelState]
) -> None:
    """Step the scratch entity states one inverse op backwards in history.

    Inverse create ops carry the full pre-delete snapshot (the ops layer
    records properties on the inverse unit), so a "create" here reinstates
    the complete state; updates are merge patches; deletes drop the entity
    (it was created later in history than the point we are rewinding to).
    """
    if isinstance(op, CreateElementOp):
        el_state[op.temp_id] = _ElState(op.type_name, dict(op.properties))
    elif isinstance(op, UpdateElementOp):
        _merge_patch(el_state[op.id].properties, op.properties_patch)
    elif isinstance(op, DeleteElementOp):
        el_state.pop(op.id, None)
    elif isinstance(op, CreateRelationshipOp):
        rel_state[op.temp_id] = _RelState(
            op.type_name, op.source_id, op.target_id, dict(op.properties)
        )
    elif isinstance(op, UpdateRelationshipOp):
        _merge_patch(rel_state[op.id].properties, op.properties_patch)
    elif isinstance(op, DeleteRelationshipOp):
        rel_state.pop(op.id, None)
    else:
        assert_never(op)


def _compact_changes(model: Model, op_log: list[AppliedBatch]) -> CrOps:
    """Compact the op log into one base-vs-current change set.

    Two passes over the RETAINED log, O(logged ops), no model copy:

    1. collect every touched entity id (inverse ops included — containment
       cascades appear only there) in first-touch order;
    2. rewind a scratch state map from the CURRENT model back through every
       batch's inverse ops (newest batch first) to recover each touched
       entity's BASE state — the model as of the oldest retained batch's
       pre-state.

    Classification per entity then yields the compaction rules for free:
    absent->present = added (final state; create-then-modify collapses into
    one add), present->absent = deleted (first before-state), changed
    present->present = modified (first before, last after), absent->absent
    (created and deleted within history) or unchanged = omitted. Before
    states are serialized with ``rev=0``: the session model's rev counters
    only ever move forward, the base rev is unrecoverable — and the CR apply
    path explicitly ignores rev when matching.
    """
    touched_els: dict[str, None] = {}
    touched_rels: dict[str, None] = {}
    for batch in op_log:
        for op in batch.ops:
            _touch(op, touched_els, touched_rels)
        for op in batch.inverse_ops:
            _touch(op, touched_els, touched_rels)

    el_state: dict[str, _ElState] = {}
    rel_state: dict[str, _RelState] = {}
    for eid in touched_els:
        element = model.elements.get(eid)
        if element is not None:
            el_state[eid] = _ElState(element.type_name, dict(element.properties))
    for rid in touched_rels:
        rel = model.relationships.get(rid)
        if rel is not None:
            rel_state[rid] = _RelState(
                rel.type_name, rel.source_id, rel.target_id, dict(rel.properties)
            )
    for batch in reversed(op_log):
        for op in batch.inverse_ops:
            _apply_inverse(op, el_state, rel_state)

    elements = CrElementOps()
    for eid in touched_els:
        base = el_state.get(eid)
        current = model.elements.get(eid)
        if base is None and current is not None:
            elements.added.append(ElementOut.from_core(current))
        elif base is not None and current is None:
            elements.deleted.append(
                ElementOut(id=eid, type_name=base.type_name, properties=base.properties)
            )
        elif base is not None and current is not None:
            if (
                base.type_name != current.type_name
                or base.properties != current.properties
            ):
                elements.modified.append(
                    ModifiedElementOut(
                        id=eid,
                        before=ElementOut(
                            id=eid,
                            type_name=base.type_name,
                            properties=base.properties,
                        ),
                        after=ElementOut.from_core(current),
                    )
                )

    relationships = CrRelationshipOps()
    for rid in touched_rels:
        rbase = rel_state.get(rid)
        rcurrent = model.relationships.get(rid)
        if rbase is None and rcurrent is not None:
            relationships.added.append(RelationshipOut.from_core(rcurrent))
        elif rbase is not None and rcurrent is None:
            relationships.deleted.append(
                RelationshipOut(
                    id=rid,
                    type_name=rbase.type_name,
                    source_id=rbase.source_id,
                    target_id=rbase.target_id,
                    properties=rbase.properties,
                )
            )
        elif rbase is not None and rcurrent is not None:
            if (
                rbase.type_name != rcurrent.type_name
                or rbase.source_id != rcurrent.source_id
                or rbase.target_id != rcurrent.target_id
                or rbase.properties != rcurrent.properties
            ):
                relationships.modified.append(
                    ModifiedRelationshipOut(
                        id=rid,
                        before=RelationshipOut(
                            id=rid,
                            type_name=rbase.type_name,
                            source_id=rbase.source_id,
                            target_id=rbase.target_id,
                            properties=rbase.properties,
                        ),
                        after=RelationshipOut.from_core(rcurrent),
                    )
                )

    return CrOps(elements=elements, relationships=relationships)


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
    ops = _compact_changes(model, session.op_log)
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
    ops = _compact_changes(model, session.op_log)
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
