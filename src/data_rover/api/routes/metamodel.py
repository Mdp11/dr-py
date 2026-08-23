from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

import yaml

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel

from .. import content
from ..db import get_db
from ..db_models import User
from ..deps import Session, get_request_session, require_metamodel
from ..identity import get_current_user
from ..locking import METAMODEL_RESOURCE
from ..metamodel_ops import serialize_metamodel_blob
from ..schemas import RawMetamodelResponse

router = APIRouter()


def _peer_mm_conflict(session: Session, user_id: str) -> JSONResponse | None:
    """409 payload when a PEER holds the ``mm`` lease, else None.

    Honor-don't-require: the caller's own lease never blocks, and no lease
    at all is fine — the lease is a guarantee only if every metamodel writer
    honors it, exactly like the artifact writers honor ``art:`` leases.
    Callers: upload/clear here. `metamodel.rebind` ops instead hard-verify
    the `mm` lease at `POST /commits`, so this honor-only check covers only
    the two routes left in this module.
    """
    peers = session.lock_table.peer_leases(
        [METAMODEL_RESOURCE], user_id, now=time.monotonic()
    )
    if peers:
        return JSONResponse(
            status_code=409,
            content={
                "detail": "metamodel locked",
                "holder_email": peers[0].holder_email,
            },
        )
    return None


@router.post("/metamodel", response_model=None)
async def upload_metamodel(
    request: Request,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Metamodel | JSONResponse:
    # The mm lease honor rule comes FIRST, before the model-not-empty
    # check, so a locked metamodel refuses all writers uniformly.
    conflict = _peer_mm_conflict(session, user.id)
    if conflict is not None:
        return conflict
    # This destructive path is initial-bind only. Once a model has
    # content, a metamodel change must go through the non-destructive,
    # journaled `metamodel.rebind` op via POST /commits (this route clears
    # the model + history).
    if session.model is not None and session.model.elements:
        raise HTTPException(
            status_code=409,
            detail="model not empty; stage a metamodel.rebind op and commit it via POST /commits",
        )
    body = (await request.body()).decode("utf-8")
    content_type = request.headers.get("content-type", "")
    if "json" in content_type:
        data = await request.json() if body else {}
        blob = yaml.safe_dump(data)
    else:
        blob = body
    metamodel = load_metamodel_str(blob)
    session.set_metamodel(metamodel)  # clears the in-memory model (core semantics)
    # persist the metamodel + (re)bind the project's model row; changing the
    # metamodel clears the model, so drop durable history too. Non-empty
    # models go through the non-destructive `metamodel.rebind` op instead
    # (this path is initial-bind only).
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


@router.get("/metamodel/raw")
def get_metamodel_raw(
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> RawMetamodelResponse:
    """The current metamodel's source YAML for the live editor.

    Prefers the stored blob (author's comments/formatting intact); a session
    whose metamodel never landed in a durable row (legacy/test setups)
    degrades to re-serializing the in-memory object rather than failing.
    """
    metamodel = require_metamodel(session)
    model_row = content.get_model_row(db, project_id)
    if model_row is not None and model_row.metamodel_id is not None:
        mm_row = content.get_metamodel_row(db, model_row.metamodel_id)
        if mm_row is not None:
            return RawMetamodelResponse(blob=mm_row.blob, source="stored")
    return RawMetamodelResponse(
        blob=serialize_metamodel_blob(metamodel), source="serialized"
    )


@router.delete("/metamodel", status_code=204, response_model=None)
def clear_metamodel(
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> Response | JSONResponse:
    conflict = _peer_mm_conflict(session, user.id)
    if conflict is not None:
        return conflict
    session.set_metamodel(None)
    return Response(status_code=204)
