"""Named views: list / read / add / delete.

Add and delete are DIRECT actions (the ``POST /metamodel`` stance): applied
under ``write_mutex`` to ``session.views`` and the ``views`` table on the
request's transaction, never journaled, never undoable, broadcast as a
``view`` feed event. Folder edits INSIDE a view stay on the check-out/commit
path (``view.*`` ops, each naming its view by ``view_id``).
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session as DbSession

from data_rover.core.view.ids import ensure_folder_ids, iter_folders
from data_rover.core.view.schema import View
from data_rover.core.view.validation import validate_view

from .. import content
from ..db import get_db
from ..db_models import User
from ..deps import Session, get_request_session, require_model
from ..feed import view_event
from ..identity import get_current_user
from ..locking import folder_resource, view_resource
from ..schemas import (
    CreateViewIn,
    IssueOut,
    ViewOut,
    ViewStateResponse,
    ViewSummaryOut,
)

router = APIRouter()


@router.get("/views")
def list_views(
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> list[ViewSummaryOut]:
    # names/revs come off the rows (the durable truth for both); the session
    # dict only carries content.
    return [
        ViewSummaryOut(id=r.id, name=r.name, view_rev=r.view_rev)
        for r in content.list_views(db, project_id)
    ]


@router.get("/views/{view_id}")
def get_view(
    project_id: str,
    view_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ViewStateResponse:
    view = session.views.get(view_id)
    row = content.get_view(db, project_id, view_id)
    if view is None or row is None:
        raise HTTPException(status_code=404, detail="view not found")
    _, model = require_model(session)
    known = content.list_artifact_ids(db, project_id)
    warnings = [
        IssueOut.from_core(i)
        for i in validate_view(view, model, known_artifact_ids=known)
    ]
    return ViewStateResponse(
        id=row.id,
        view=ViewOut.from_core(view),
        warnings=warnings,
        view_rev=row.view_rev,
    )


@router.post("/views", status_code=201)
def create_view(
    project_id: str,
    payload: CreateViewIn,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ViewSummaryOut:
    # the row's name is authoritative — the document's own is overwritten
    # (and may be absent: a bare ``{}`` is a valid empty view)
    try:
        view = View.model_validate({**payload.view, "name": payload.name})
    except ValidationError as exc:
        first = exc.errors()[0]
        loc = ".".join(str(p) for p in first["loc"])
        raise HTTPException(
            status_code=422, detail=f"invalid view document: {loc}: {first['msg']}"
        ) from exc
    ensure_folder_ids(view)
    with session.write_mutex:
        try:
            row = content.create_view(
                db, project_id, name=payload.name, blob=view.model_dump_json()
            )
        except content.DuplicateViewNameError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        db.commit()
        session.views[row.id] = view
        session.hub.broadcast(view_event("created", {"id": row.id, "name": row.name}))
    return ViewSummaryOut(id=row.id, name=row.name, view_rev=row.view_rev)


@router.delete("/views/{view_id}", status_code=204)
def delete_view(
    project_id: str,
    view_id: str,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
) -> Response:
    with session.write_mutex:
        view = session.views.get(view_id)
        row = content.get_view(db, project_id, view_id)
        if view is None or row is None:
            raise HTTPException(status_code=404, detail="view not found")
        # Honor (not verify) leases, like every other non-commit writer: a
        # peer editing anywhere in this view — its root or any folder —
        # blocks the delete; the caller's own leases never do.
        resources = [view_resource(view_id)] + [
            folder_resource(f.id) for f in iter_folders(view)
        ]
        if session.lock_table.peer_leases(resources, user.id, now=time.monotonic()):
            raise HTTPException(
                status_code=409, detail="view is checked out by someone else"
            )
        name = row.name
        content.delete_view(db, project_id, view_id)
        db.commit()
        del session.views[view_id]
        session.hub.broadcast(view_event("deleted", {"id": view_id, "name": name}))
    return Response(status_code=204)
