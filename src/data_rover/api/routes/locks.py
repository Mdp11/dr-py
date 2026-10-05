"""Resource-lease endpoints (check-out). Holder == authenticated user.

Leases live in the per-project ``ProjectState.lock_table`` (resolved via
``get_project_state``, so membership is already authorized). All times use
``time.monotonic()`` — the same clock the lifespan sweeper uses.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from sqlalchemy.orm import Session as DbSession

from ..commit_load import subtree_ids
from ..db import get_db
from ..deps import require_metamodel
from ..feed import lock_event
from ..identity import get_current_user
from ..db_models import User
from ..lock_mirror import mirror_project_leases
from ..project_state import ProjectState, get_project_state
from ..rebind_check import containment_types
from ..locking import (
    METAMODEL_RESOURCE,
    Lease,
    LockIntent,
    LockMode,
    artifact_resource,
    expand_targets,
    folder_resource,
    view_resource,
)
from ..schemas import (
    LeaseOut,
    LockRequest,
    LockResponse,
    LockTargetIn,
    ReleaseRequest,
    RenewRequest,
    RenewResponse,
)
from ..settings import get_settings

router = APIRouter()


def _lease_event_dicts(leases: list[Lease]) -> list[dict[str, str]]:
    return [
        {
            "resource_id": le.resource_id,
            "mode": le.mode.value,
            "holder_id": le.holder,
            "holder_email": le.holder_email,
        }
        for le in leases
    ]


def _lease_out(le: Lease) -> LeaseOut:
    return LeaseOut(
        resource_id=le.resource_id,
        mode=le.mode.value,
        holder=le.holder,
        holder_email=le.holder_email,
        token=le.token,
        intent=le.intent.value,
        expires_at=le.expires_at,
    )


@router.post("/locks", response_model=None)
def acquire_locks(
    project_id: str,
    payload: LockRequest,
    state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LockResponse | JSONResponse:
    metamodel = require_metamodel(state)

    def _canonical(t: LockTargetIn) -> str:
        if t.type == "artifact":
            return artifact_resource(t.resource_id)
        if t.type == "metamodel":
            return METAMODEL_RESOURCE
        if t.type == "folder":
            return folder_resource(t.resource_id)
        if t.type == "view":
            return view_resource(t.resource_id)
        return t.resource_id

    targets = [(_canonical(t), LockMode(t.mode)) for t in payload.targets]
    containment = containment_types(metamodel)
    # a delete's cascade is read from the head rows
    reqs = expand_targets(
        lambda root: subtree_ids(db, project_id, [root], containment),
        state.views,
        targets,
        LockIntent(payload.intent),
    )
    now = time.monotonic()
    ttl = float(get_settings().lock_ttl_seconds)
    with state.write_mutex:
        token, leases, conflicts = state.lock_table.acquire(
            user.id,
            reqs,
            now=now,
            ttl=ttl,
            steal=payload.steal,
            holder_email=user.email,
        )
    if conflicts:
        return JSONResponse(
            status_code=409,
            content={
                "detail": "lock conflict",
                "conflicts": [
                    {
                        "resource_id": c.resource_id,
                        "held_by": c.held_by,
                        "held_by_email": c.held_by_email,
                        "held_mode": c.held_mode.value,
                    }
                    for c in conflicts
                ],
            },
        )
    state.hub.broadcast(lock_event("acquired", _lease_event_dicts(leases)))
    mirror_project_leases(project_id, state)
    return LockResponse(token=token, leases=[_lease_out(le) for le in leases])


@router.post("/locks/release")
def release_locks(
    project_id: str,
    payload: ReleaseRequest,
    state: ProjectState = Depends(get_project_state),
    user: User = Depends(get_current_user),
) -> dict[str, int]:
    with state.write_mutex:
        released = state.lock_table.release(user.id, payload.token)
    if released:
        state.hub.broadcast(lock_event("released", _lease_event_dicts(released)))
        mirror_project_leases(project_id, state)
    return {"released": len(released)}


@router.post("/locks/renew")
def renew_locks(
    project_id: str,
    payload: RenewRequest,
    state: ProjectState = Depends(get_project_state),
    user: User = Depends(get_current_user),
) -> RenewResponse:
    now = time.monotonic()
    ttl = float(get_settings().lock_ttl_seconds)
    with state.write_mutex:
        ok = state.lock_table.renew(user.id, payload.token, now=now, ttl=ttl)
    if ok:
        mirror_project_leases(project_id, state)
    return RenewResponse(ok=ok)


@router.get("/locks")
def list_locks(
    state: ProjectState = Depends(get_project_state),
) -> dict[str, list[LeaseOut]]:
    leases = state.lock_table.active_leases(time.monotonic())
    return {"leases": [_lease_out(le) for le in leases]}
