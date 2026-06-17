"""Resource-lease endpoints (Phase 4 check-out). Holder == authenticated user.

Leases live in the per-project ``Session.lock_table`` (resolved via
``get_request_session``, so membership is already authorized). All times use
``time.monotonic()`` — the same clock the lifespan sweeper uses.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ..deps import Session, get_request_session, require_model
from ..identity import get_current_user
from ..db_models import User
from ..locking import Lease, LockIntent, LockMode, expand_targets
from ..schemas import (
    LeaseOut,
    LockRequest,
    LockResponse,
    ReleaseRequest,
    RenewRequest,
    RenewResponse,
)
from ..settings import get_settings

router = APIRouter()


def _lease_out(le: Lease) -> LeaseOut:
    return LeaseOut(
        resource_id=le.resource_id,
        mode=le.mode.value,
        holder=le.holder,
        token=le.token,
        intent=le.intent.value,
        expires_at=le.expires_at,
    )


@router.post("/locks", response_model=None)
def acquire_locks(
    payload: LockRequest,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> LockResponse | JSONResponse:
    _, model = require_model(session)
    targets = [(t.resource_id, LockMode(t.mode)) for t in payload.targets]
    reqs = expand_targets(model, targets, LockIntent(payload.intent))
    now = time.monotonic()
    ttl = float(get_settings().lock_ttl_seconds)
    with session.write_mutex:
        token, leases, conflicts = session.lock_table.acquire(
            user.id, reqs, now=now, ttl=ttl, steal=payload.steal
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
                        "held_mode": c.held_mode.value,
                    }
                    for c in conflicts
                ],
            },
        )
    return LockResponse(token=token, leases=[_lease_out(le) for le in leases])


@router.post("/locks/release")
def release_locks(
    payload: ReleaseRequest,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> dict[str, int]:
    with session.write_mutex:
        released = session.lock_table.release(user.id, payload.token)
    return {"released": len(released)}


@router.post("/locks/renew")
def renew_locks(
    payload: RenewRequest,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> RenewResponse:
    now = time.monotonic()
    ttl = float(get_settings().lock_ttl_seconds)
    with session.write_mutex:
        ok = session.lock_table.renew(user.id, payload.token, now=now, ttl=ttl)
    return RenewResponse(ok=ok)


@router.get("/locks")
def list_locks(
    session: Session = Depends(get_request_session),
) -> dict[str, list[LeaseOut]]:
    leases = session.lock_table.active_leases(time.monotonic())
    return {"leases": [_lease_out(le) for le in leases]}
