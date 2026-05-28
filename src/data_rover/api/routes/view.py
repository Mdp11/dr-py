from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from data_rover.core.view.validation import validate_view

from ..deps import Session, get_session, require_model
from ..schemas import (
    IssueOut,
    ViewIn,
    ViewOut,
    ViewSnapshotResponse,
    ViewStateResponse,
)

router = APIRouter()


@router.put("/view/snapshot")
def snapshot_view(
    payload: ViewIn,
    session: Session = Depends(get_session),
) -> ViewSnapshotResponse:
    _, model = require_model(session)
    try:
        view = payload.to_core()
    except Exception as exc:  # pydantic validation failure on nested data
        raise HTTPException(status_code=422, detail=f"Invalid view: {exc}") from exc
    session.view = view
    warnings = [IssueOut.from_core(i) for i in validate_view(view, model)]
    return ViewSnapshotResponse(view=ViewOut.from_core(view), warnings=warnings)


@router.get("/view")
def get_view(session: Session = Depends(get_session)) -> ViewStateResponse:
    view = session.view
    if view is None:
        return ViewStateResponse(view=None, warnings=[])
    _, model = require_model(session)
    warnings = [IssueOut.from_core(i) for i in validate_view(view, model)]
    return ViewStateResponse(view=ViewOut.from_core(view), warnings=warnings)


@router.delete("/view", status_code=204)
def clear_view(session: Session = Depends(get_session)) -> Response:
    session.view = None
    return Response(status_code=204)
