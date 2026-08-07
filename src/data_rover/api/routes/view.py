from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session as DbSession

from data_rover.core.view.ids import ensure_folder_ids
from data_rover.core.view.validation import validate_view

from .. import content
from ..db import get_db
from ..deps import Session, get_request_session, require_model
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
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ViewSnapshotResponse:
    _, model = require_model(session)
    try:
        view = payload.to_core()
    except Exception as exc:  # pydantic validation failure on nested data
        raise HTTPException(status_code=422, detail=f"Invalid view: {exc}") from exc
    # Unconditional and idempotent: a client that already echoes ids back
    # (the common case once every folder has one) gets no-op treatment, while
    # a client still on an old, id-less shape gets healed right here — the PUT
    # path is one of the three id-entry points alongside hydration/import.
    ensure_folder_ids(view)
    session.view = view
    view_rev = 0
    if content.get_model_row(db, project_id) is not None:
        view_row = content.upsert_single_view(
            db, project_id, name=view.name, blob=view.model_dump_json()
        )
        db.commit()
        view_rev = view_row.view_rev
    known = {row.id for row in content.list_artifacts(db, project_id)}
    warnings = [
        IssueOut.from_core(i)
        for i in validate_view(view, model, known_artifact_ids=known)
    ]
    return ViewSnapshotResponse(
        view=ViewOut.from_core(view), warnings=warnings, view_rev=view_rev
    )


@router.get("/view")
def get_view(
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ViewStateResponse:
    view_row = content.get_single_view(db, project_id)
    view_rev = view_row.view_rev if view_row is not None else None
    view = session.view
    if view is None:
        return ViewStateResponse(view=None, warnings=[], view_rev=view_rev)
    _, model = require_model(session)
    known = {row.id for row in content.list_artifacts(db, project_id)}
    warnings = [
        IssueOut.from_core(i)
        for i in validate_view(view, model, known_artifact_ids=known)
    ]
    return ViewStateResponse(
        view=ViewOut.from_core(view), warnings=warnings, view_rev=view_rev
    )


@router.delete("/view", status_code=204)
def clear_view(session: Session = Depends(get_request_session)) -> Response:
    session.view = None
    return Response(status_code=204)
