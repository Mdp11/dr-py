"""The routes a replica opens from and catches up by."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session as DbSession

from .. import content, replica
from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership, Snapshot
from ..deps import Session, get_request_session
from ..schemas import ReplicaTailOut, SnapshotDescriptorOut
from ..snapshot_rows import write_snapshot_from_rows
from ..storage import get_snapshot_store

logger = logging.getLogger(__name__)

router = APIRouter()


def _descriptor(snap: Snapshot, request: Request) -> SnapshotDescriptorOut:
    # a path, not an absolute URL: behind the dev proxy the backend's host is
    # not the browser's origin
    url = request.url.path.removesuffix("/snapshot") + f"/snapshots/{snap.rev}"
    assert snap.metamodel_id is not None and snap.state_digest is not None
    assert snap.elements is not None and snap.relationships is not None
    return SnapshotDescriptorOut(
        rev=snap.rev,
        metamodel_id=snap.metamodel_id,
        state_digest=snap.state_digest,
        elements=snap.elements,
        relationships=snap.relationships,
        url=url,
    )


@router.get("/replica/snapshot")
def get_snapshot_descriptor(
    project_id: str,
    request: Request,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> SnapshotDescriptorOut:
    model_row = content.get_model_row(db, project_id)
    if model_row is None:
        raise HTTPException(status_code=404, detail="No model loaded")

    snap = replica.pick_snapshot(db, project_id, model_row.model_rev)
    if snap is not None:
        return _descriptor(snap, request)

    # Under the row lock no commit moves the head: look again (a second opener
    # finds what the first wrote), then write from the rows.
    locked = content.lock_model_row(db, project_id)
    if locked is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    head = locked.model_rev
    snap = replica.pick_snapshot(db, project_id, head)
    if snap is None:
        try:
            head = write_snapshot_from_rows(project_id)
        except Exception as exc:
            logger.exception("snapshot write at head failed for %s", project_id)
            raise HTTPException(
                status_code=503, detail="snapshot store unavailable"
            ) from exc
        snap = content.get_snapshot(db, project_id, head)
        assert snap is not None

    return _descriptor(snap, request)


@router.get("/replica/snapshots/{rev}")
def get_snapshot_blob(
    project_id: str,
    rev: int,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> Response:
    # never a Content-Encoding: the bytes are the gzip member as stored
    missing = HTTPException(status_code=404, detail=f"no v2 snapshot at rev {rev}")
    row = content.get_snapshot(db, project_id, rev)
    if row is None or row.format != "v2":
        raise missing
    try:
        blob = get_snapshot_store().get(row.key)
    except KeyError:
        raise missing from None
    return Response(
        content=blob,
        media_type="application/gzip",
        headers={"Cache-Control": "no-store"},
    )


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
