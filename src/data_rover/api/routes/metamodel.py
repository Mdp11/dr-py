from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session as DbSession

import yaml

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel

from .. import content
from ..db import get_db
from ..deps import Session, get_request_session, require_metamodel

router = APIRouter()


@router.post("/metamodel")
async def upload_metamodel(
    request: Request,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> Metamodel:
    body = (await request.body()).decode("utf-8")
    content_type = request.headers.get("content-type", "")
    if "json" in content_type:
        import yaml as _yaml  # local: keep top-level import set unchanged

        data = await request.json() if body else {}
        blob = _yaml.safe_dump(data)
    else:
        blob = body
    metamodel = load_metamodel_str(blob)
    session.set_metamodel(metamodel)  # clears the in-memory model (core semantics)
    # persist the metamodel + (re)bind the project's model row; changing the
    # metamodel clears the model, so drop durable history too (Phase 6 will
    # replace this destructive swap with a non-destructive rebind).
    # Metamodel has no name field (only enums/elements/relationships); the row
    # name is cosmetic, leave it "".
    mm_row = content.create_metamodel(db, name="", version=1, blob=blob)
    content.upsert_model_row(db, project_id, metamodel_id=mm_row.id)
    content.clear_history(db, project_id)
    content.set_model_rev(db, project_id, session.model_rev)
    db.commit()
    return metamodel


@router.get("/metamodel")
def get_metamodel(session: Session = Depends(get_request_session)) -> Metamodel:
    return require_metamodel(session)


@router.delete("/metamodel", status_code=204)
def clear_metamodel(session: Session = Depends(get_request_session)) -> Response:
    session.set_metamodel(None)
    return Response(status_code=204)
