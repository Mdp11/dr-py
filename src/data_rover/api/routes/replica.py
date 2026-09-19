"""The routes a replica opens from and catches up by."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session as DbSession

from .. import replica
from ..db import get_db
from ..deps import Session, get_request_session
from ..schemas import ReplicaTailOut

router = APIRouter()


@router.get("/replica/tail")
def get_tail(
    project_id: str,
    from_rev: int = Query(ge=0),
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ReplicaTailOut:
    # Under the mutex no journal writer sits between its rev bump and its
    # db.commit(), so every row up to this head is durable.
    with session.write_mutex:
        head = session.model_rev
    return ReplicaTailOut(**replica.build_tail(db, project_id, from_rev, head))
