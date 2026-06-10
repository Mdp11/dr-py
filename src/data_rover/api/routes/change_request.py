"""POST /model/apply-cr — apply a change request to an inline model snapshot."""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.change_request import (
    ChangeRequest,
    CRConflictError,
    apply_change_request,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import change_request_dirty_ids
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

from ..deps import Session, get_session, require_metamodel
from ..schemas import (
    ApplyCrRequest,
    ApplyCrResponse,
    IssueOut,
    ModelOut,
)
from ._snapshot import _build_model_from_payload

router = APIRouter()


def _gate_cr_result(metamodel: Metamodel, base: Model, result: Model,
                    cr: ChangeRequest) -> None:
    """422 gate for entities the CR introduced or rewired.

    The inline payload was already gated by ``_build_model_from_payload``, so
    only the CR's delta needs checking (this replaces the former full
    round-trip of the result model through a second payload build):

    - added/modified elements: type must exist and not be abstract
    - added/modified relationships: type must exist, endpoints must resolve
    - deleted elements: no surviving relationship may still reference them
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
        if rel.source_id not in result.elements:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Relationship {rid!r} references unknown source "
                    f"{rel.source_id!r}"
                ),
            )
        if rel.target_id not in result.elements:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Relationship {rid!r} references unknown target "
                    f"{rel.target_id!r}"
                ),
            )

    # CR deletes do not cascade: every relationship that touched a deleted
    # element in the base must have been deleted/re-targeted by the CR too
    for e in cr.elements_deleted:
        indexes = base.indexes
        for rid in sorted(indexes.outgoing_ids(e.id) | indexes.incoming_ids(e.id)):
            survivor = result.relationships.get(rid)
            if survivor is None:
                continue
            if survivor.source_id not in result.elements:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Relationship {rid!r} references unknown source "
                        f"{survivor.source_id!r}"
                    ),
                )
            if survivor.target_id not in result.elements:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Relationship {rid!r} references unknown target "
                        f"{survivor.target_id!r}"
                    ),
                )


@router.post("/model/apply-cr", response_model=None)
def apply_cr(
    payload: ApplyCrRequest,
    session: Session = Depends(get_session),
) -> ApplyCrResponse | JSONResponse:
    metamodel = require_metamodel(session)
    base = _build_model_from_payload(
        metamodel,
        payload.model.elements,
        payload.model.relationships,
    )
    cr = payload.cr.to_core()

    try:
        result = apply_change_request(base, cr)
    except CRConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={"conflicts": [asdict(c) for c in exc.conflicts]},
        )

    # Same 422 gate as POST /model so that a CR adding an element/relationship
    # with an unknown type_name (etc.) is rejected — but checked on the CR
    # delta only, instead of rebuilding the whole result model a second time.
    _gate_cr_result(metamodel, base, result, cr)

    # Incremental validation: one full pass on the BASE model seeds the issue
    # store, then only the entities the CR could have affected are
    # re-validated on the result and spliced in. The response still carries
    # the full-equivalent issue list for the result model.
    pipeline = default_pipeline()
    state = ValidationState()
    state.set_full(pipeline.validate(base, Scope.all()))
    dirty = change_request_dirty_ids(base, result, cr)
    state.replace(dirty, pipeline.validate(result, Scope(dirty)))

    return ApplyCrResponse(
        model=ModelOut.from_core(result),
        issues=[IssueOut.from_core(i) for i in state.all_issues()],
    )
