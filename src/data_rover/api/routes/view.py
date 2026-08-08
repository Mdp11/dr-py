from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from data_rover.core.view.validation import validate_view

from .. import content
from ..db import get_db
from ..deps import Session, get_request_session, require_model
from ..schemas import IssueOut, ViewOut, ViewStateResponse

router = APIRouter()


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
    known = content.list_artifact_ids(db, project_id)
    warnings = [
        IssueOut.from_core(i)
        for i in validate_view(view, model, known_artifact_ids=known)
    ]
    return ViewStateResponse(
        view=ViewOut.from_core(view), warnings=warnings, view_rev=view_rev
    )
