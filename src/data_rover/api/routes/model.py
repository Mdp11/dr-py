from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..deps import Session, get_session, require_metamodel, require_model
from ..schemas import InlineModel, ModelOut, SnapshotIn
from ._snapshot import _build_model_from_payload

router = APIRouter()


@router.post("/model")
def upload_model(
    payload: InlineModel,
    session: Session = Depends(get_session),
) -> ModelOut:
    metamodel = require_metamodel(session)
    model = _build_model_from_payload(
        metamodel, payload.elements, payload.relationships
    )
    session.model = model
    session.validation = None  # previous full-run baseline is now stale
    return ModelOut.from_core(model)


@router.get("/model")
def get_model(session: Session = Depends(get_session)) -> ModelOut:
    _, model = require_model(session)
    return ModelOut.from_core(model)


@router.put("/model/snapshot")
def snapshot_model(
    payload: SnapshotIn,
    session: Session = Depends(get_session),
) -> ModelOut:
    metamodel = require_metamodel(session)
    model = _build_model_from_payload(
        metamodel, payload.elements, payload.relationships
    )
    session.model = model
    session.validation = None  # previous full-run baseline is now stale
    return ModelOut.from_core(model)


@router.delete("/model", status_code=204)
def clear_model(session: Session = Depends(get_session)) -> Response:
    session.model = None
    session.validation = None
    return Response(status_code=204)
