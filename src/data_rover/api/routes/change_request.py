"""POST /model/apply-cr — apply a change request to an inline model snapshot."""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from data_rover.core.model.change_request import (
    CRConflictError,
    apply_change_request,
)
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from ..deps import Session, get_session, require_metamodel
from ..schemas import (
    ApplyCrRequest,
    ApplyCrResponse,
    ElementOut,
    IssueOut,
    ModelOut,
    RelationshipOut,
)
from ._snapshot import _build_model_from_payload

router = APIRouter()


@router.post("/model/apply-cr", response_model=None)
def apply_cr(
    payload: ApplyCrRequest,
    session: Session = Depends(get_session),
) -> ApplyCrResponse | JSONResponse:
    metamodel = require_metamodel(session)
    target = _build_model_from_payload(
        metamodel,
        payload.model.elements,
        payload.model.relationships,
    )

    try:
        result = apply_change_request(target, payload.cr.to_core())
    except CRConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={"conflicts": [asdict(c) for c in exc.conflicts]},
        )

    # Re-validate types and endpoints via the same gate as POST /model so that
    # a CR adding an element/relationship with an unknown type_name raises 422.
    result = _build_model_from_payload(
        metamodel,
        [ElementOut.from_core(e) for e in result.elements.values()],
        [RelationshipOut.from_core(r) for r in result.relationships.values()],
    )

    issues = default_pipeline().validate(result, Scope.all())
    return ApplyCrResponse(
        model=ModelOut.from_core(result),
        issues=[IssueOut.from_core(i) for i in issues],
    )
