from __future__ import annotations

from fastapi import APIRouter, Depends

from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from ..deps import Session, get_session, require_model
from ..schemas import IssueOut, ValidateRequest
from ._snapshot import _build_model_from_payload

router = APIRouter()


@router.post("/model/validate")
def validate_model(
    payload: ValidateRequest | None = None,
    session: Session = Depends(get_session),
) -> list[IssueOut]:
    metamodel, current = require_model(session)
    if payload is not None and payload.inline is not None:
        model = _build_model_from_payload(
            metamodel,
            payload.inline.elements,
            payload.inline.relationships,
        )
    else:
        model = current
    scope = (
        Scope(payload.scope) if payload and payload.scope is not None else Scope.all()
    )
    issues = default_pipeline().validate(model, scope)
    return [IssueOut.from_core(i) for i in issues]
