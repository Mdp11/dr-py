"""Check-out/commit endpoints (Phase 4 spec §7): open, preview, commit.

Reuses the delta machinery from ``routes/ops.py`` — ``_apply_batch`` (atomic
apply with inverse collection; raises 422 on a mutation-boundary error),
``_rollback`` (undo a previewed batch), and ``_ensure_validation_seeded``
(full-run baseline). Preview runs apply → validate dirty set → roll back,
all under ``session.write_mutex`` (spec §11). This module deliberately imports
those module-private helpers — they are part of the ops package's internal
surface, shared with this sibling.
"""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.validation.issue import IssueCategory
from data_rover.core.validation.pipeline import default_pipeline

from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership, User
from ..deps import Session, get_request_session, require_model
from ..identity import get_current_user
from ..locking import required_locks
from ..schemas import (
    CommitRequest,
    CommitResponse,
    ElementOut,
    IssueOut,
    OpenResponse,
    PreviewRequest,
    PreviewResponse,
    RelationshipOut,
)
from ..session import AppliedBatch
from .ops import (
    _apply_batch,
    _ensure_validation_seeded,
    _maybe_periodic_snapshot,
    _persist_commit,
    _rollback,
)

router = APIRouter()


@router.get("/open", response_model=None)
def open_project(
    session: Session = Depends(get_request_session),
    membership: Membership = Depends(require_membership),
) -> OpenResponse:
    _, model = require_model(session)
    state = _ensure_validation_seeded(session, model)
    return OpenResponse(
        model_rev=session.model_rev,
        role=membership.role.value,
        element_count=len(model.elements),
        relationship_count=len(model.relationships),
        issue_counts=state.counts(),
    )


@router.post("/commits/preview", response_model=None)
def preview_commit(
    payload: PreviewRequest,
    session: Session = Depends(get_request_session),
) -> PreviewResponse | JSONResponse:
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    with session.write_mutex:
        # _apply_batch raises 422 on a mutation-boundary structural error
        # (unknown type, missing endpoint, unknown property) — the safety net.
        res = _apply_batch(model, payload.ops, restore=False)
        try:
            scoped = default_pipeline().validate(model, res.dirty.to_scope())
        finally:
            _rollback(model, res.inverse_units)  # always restore the model
    structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
    conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
    return PreviewResponse(
        conformance_error_count=len(conformance),
        structural_blockers=[IssueOut.from_core(i) for i in structural],
        issues=[IssueOut.from_core(i) for i in scoped],
    )


@router.post("/commits", response_model=None)
def create_commit(
    payload: CommitRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommitResponse | JSONResponse:
    """Lock-verified, structural-gated commit (Phase 4 spec §7).

    Flow:
    1. Stale-rev check (before the mutex — mirrors preview and apply_ops).
    2. Seed the validation baseline.
    3. Under the write mutex:
       a. Verify the caller still holds every required lock (409 if any gone).
       b. Apply the batch (422 on mutation-boundary error from _apply_batch).
       c. Hard-reject structural blockers (422; rolls back).
       d. Splice conformance issues into the issue store, bump rev, record batch.
       e. Persist to the durable journal (500 + full rollback on failure).
       f. Release the caller's locks (explicit loop).
    4. Return CommitResponse with full delta + commit metadata.
    """
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    state = _ensure_validation_seeded(session, model)
    with session.write_mutex:
        # a. verify the caller still holds every required lock
        reqs = required_locks(model, payload.ops)
        missing = session.lock_table.verify_held(
            user.id, payload.lock_tokens, reqs, now=time.monotonic()
        )
        if missing:
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "required lock not held",
                    "missing": [
                        {"resource_id": m.resource_id, "mode": m.mode.value}
                        for m in missing
                    ],
                },
            )
        # b. apply (422 on mutation-boundary error — let it propagate)
        res = _apply_batch(model, payload.ops, restore=False)
        # c. hard-reject structural blockers
        scoped = default_pipeline().validate(model, res.dirty.to_scope())
        structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
        if structural:
            _rollback(model, res.inverse_units)
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "structural validation blocker",
                    "structural_blockers": [
                        IssueOut.from_core(i).model_dump() for i in structural
                    ],
                },
            )
        # d. commit accepted: splice issues, bump rev, record batch
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        delta = state.replace(res.dirty.ids, scoped)
        session.model_rev += 1
        session.record_batch(
            AppliedBatch(
                ops=res.canonical_ops,
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
            )
        )
        # e. persist to the durable journal; mirror apply_ops 500 pattern exactly
        commit_id = uuid.uuid4().hex
        issues_json = [IssueOut.from_core(i).model_dump() for i in conformance]
        try:
            persisted = _persist_commit(
                db,
                project_id,
                rev=session.model_rev,
                author_id=user.id,
                res=res,
                _commit_id=commit_id,
                _message=payload.message,
                _validation_error_count=len(conformance),
                _issues=issues_json,
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)
            session.model_rev -= 1
            session.op_log.pop()
            db.rollback()
            raise HTTPException(
                status_code=500, detail="failed to persist commit"
            ) from exc
        # f. periodic snapshot: mirrors apply_ops so a hot commit-only project
        #    doesn't accumulate an unbounded replay tail.
        if persisted:
            _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
        # g. release the caller's locks (explicit loop — no helper)
        for tok in payload.lock_tokens:
            session.lock_table.release(user.id, tok)
    return CommitResponse(
        model_rev=session.model_rev,
        id_map=dict(res.id_map),
        changed_elements=[
            ElementOut.from_core(model.elements[eid])
            for eid in res.changed_element_ids
        ],
        changed_relationships=[
            RelationshipOut.from_core(model.relationships[rid])
            for rid in res.changed_relationship_ids
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
        commit_id=commit_id,
        message=payload.message,
        validation_error_count=len(conformance),
    )
