"""POST /model/apply-cr and POST /model/compare — dry-run proposals.

A dry run: the CRs are applied sequentially and TRANSIENTLY to the session
model (``apply_change_request`` is pure, so each step is a fresh copy), the
combined base -> final change request is derived, gated, and translated into
an op batch (``api/change_request_ops.py``). Nothing is applied, journalled
or validated here — the client stages the batch and ``POST /commits/preview``
validates it like any manual edit.

POST /model/compare diffs the session model against an uploaded model and
returns the same document shape; Replace in the UI is that CR fed straight
back to apply-cr.

The session model is read WITHOUT the write mutex (the ``/snippets/run``
precedent): the response carries the ``model_rev`` it saw, and the client
refuses to stage a proposal whose rev has moved.

409 ``{cr_index, conflicts, model_rev}`` names the FIRST CR that conflicts
with the model as left by its predecessors; 422 is the metamodel gate
(unknown/abstract type, dangling endpoint, non-cascaded delete) or an
element type change, which the op protocol cannot express.
"""

from __future__ import annotations

import json
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.change_request import (
    ChangeRequest,
    CRConflictError,
    apply_change_request,
    diff_models,
)
from data_rover.core.model.model import Model

from ..change_request_ops import UnsupportedChangeError, ops_for_change
from ..deps import Session, get_request_session, require_model
from ..schemas import (
    ChangesOut,
    CompareResponse,
    CrBaseline,
    CrElementOps,
    CrOps,
    CrRelationshipOps,
    ElementOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    ProposeCrRequest,
    ProposeCrResponse,
    RelationshipOut,
)
from ._snapshot import build_model_from_dicts
from .read import _now_iso

router = APIRouter()


def _require_endpoint(result: Model, rid: str, role: str, element_id: str) -> None:
    """422 unless *element_id* resolves in the result model."""
    if element_id not in result.elements:
        raise HTTPException(
            status_code=422,
            detail=(f"Relationship {rid!r} references unknown {role} {element_id!r}"),
        )


def _gate_cr_result(
    metamodel: Metamodel, base: Model, result: Model, cr: ChangeRequest
) -> None:
    """422 gate for entities the CR introduced or rewired.

    The inline payload was already gated by ``_build_model_from_payload``, so
    only the CR's delta needs checking:

    - added/modified elements: type must exist and not be abstract
    - added/modified relationships: type must exist, endpoints must resolve
    - deleted elements: no surviving relationship may still reference them

    The last two checks interlock: a relationship rewired onto a deleted
    element is already caught by the added/modified endpoint checks, so the
    deleted-elements loop only needs to walk the relationships incident in
    the BASE model. The added/modified checks run on every listed ``after``
    state, so a CR that modifies an entity invalidly AND deletes it in the
    same request is rejected.
    """
    for el in (*cr.elements_added, *(m.after for m in cr.elements_modified)):
        et = metamodel.element_type(el.type_name)
        if et is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown element type {el.type_name!r}",
            )
        if et.abstract:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Element type {el.type_name!r} is abstract and cannot be "
                    f"instantiated"
                ),
            )

    checked_rels = [(r.id, r) for r in cr.relationships_added]
    checked_rels += [(m.id, m.after) for m in cr.relationships_modified]
    for rid, rel in checked_rels:
        if metamodel.relationship_type(rel.type_name) is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown relationship type {rel.type_name!r}",
            )
        _require_endpoint(result, rid, "source", rel.source_id)
        _require_endpoint(result, rid, "target", rel.target_id)

    # CR deletes do not cascade: every relationship that touched a deleted
    # element in the base must have been deleted/re-targeted by the CR too
    for e in cr.elements_deleted:
        indexes = base.indexes
        for rid in sorted(indexes.outgoing_ids(e.id) | indexes.incoming_ids(e.id)):
            survivor = result.relationships.get(rid)
            if survivor is None:
                continue
            _require_endpoint(result, rid, "source", survivor.source_id)
            _require_endpoint(result, rid, "target", survivor.target_id)


def _changes_out(base: Model, cr: ChangeRequest) -> ChangesOut:
    """Serialize a core CR as a ``datarover.cr/v1`` document whose baseline
    describes *base*. ``filename`` is null — the server never knows the file."""
    return ChangesOut(
        createdAt=_now_iso(),
        baseline=CrBaseline(
            filename=None,
            elementCount=len(base.elements),
            relationshipCount=len(base.relationships),
        ),
        ops=CrOps(
            elements=CrElementOps(
                added=[ElementOut.from_core(e) for e in cr.elements_added],
                modified=[
                    ModifiedElementOut(
                        id=m.id,
                        before=ElementOut.from_core(m.before),
                        after=ElementOut.from_core(m.after),
                    )
                    for m in cr.elements_modified
                ],
                deleted=[ElementOut.from_core(e) for e in cr.elements_deleted],
            ),
            relationships=CrRelationshipOps(
                added=[RelationshipOut.from_core(r) for r in cr.relationships_added],
                modified=[
                    ModifiedRelationshipOut(
                        id=m.id,
                        before=RelationshipOut.from_core(m.before),
                        after=RelationshipOut.from_core(m.after),
                    )
                    for m in cr.relationships_modified
                ],
                deleted=[
                    RelationshipOut.from_core(r) for r in cr.relationships_deleted
                ],
            ),
        ),
    )


@router.post("/model/apply-cr", response_model=None)
def propose_cr(
    payload: ProposeCrRequest,
    session: Session = Depends(get_request_session),
) -> ProposeCrResponse | JSONResponse:
    """See the module docstring."""
    metamodel, base = require_model(session)
    model_rev = session.model_rev

    current = base
    for index, cr_in in enumerate(payload.crs):
        try:
            current = apply_change_request(current, cr_in.to_core())
        except CRConflictError as exc:
            return JSONResponse(
                status_code=409,
                content={
                    "cr_index": index,
                    "conflicts": [asdict(c) for c in exc.conflicts],
                    "model_rev": model_rev,
                },
            )

    combined = diff_models(base, current)
    _gate_cr_result(metamodel, base, current, combined)
    try:
        ops = ops_for_change(combined)
    except UnsupportedChangeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return ProposeCrResponse(
        model_rev=model_rev, cr=_changes_out(base, combined), ops=ops
    )


@router.post("/model/compare")
async def compare_model(
    request: Request,
    session: Session = Depends(get_request_session),
) -> CompareResponse:
    """Diff the session model against the raw other-model JSON body.

    The body is the save-file shape (``{"elements": [...], "relationships":
    [...]}``), buffered and parsed like POST /model/upload. It is built
    ``strict=False``: an unknown type in the file is still comparable (only
    staging it is not — the propose route's gate catches that); reserved
    ids, duplicate ids and dangling endpoints stay 422 because the diff
    needs a well-formed model. Direction is always session -> other; the
    client inverts client-side. Read-only, so viewers may call it.
    """
    metamodel, base = require_model(session)
    body = await request.body()
    try:
        raw = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=422, detail=f"Request body is not valid JSON: {exc}"
        ) from exc
    other = build_model_from_dicts(metamodel, raw, strict=False)
    cr = diff_models(base, other)
    return CompareResponse(
        model_rev=session.model_rev,
        cr=_changes_out(base, cr),
        other_element_count=len(other.elements),
        other_relationship_count=len(other.relationships),
    )
