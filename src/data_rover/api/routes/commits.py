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

import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.validation.issue import IssueCategory
from data_rover.core.validation.pipeline import default_pipeline

from ..authz import require_membership
from ..feed import commit_event, lock_event
from .. import content
from ..db import get_db
from ..db_models import Commit, Membership, User
from ..deps import Session, get_request_session, require_model
from ..hydration import deserialize_ops
from ..identity import get_current_user
from ..locking import required_locks
from ..settings import get_settings
from ..schemas import (
    CommitHistoryResponse,
    CommitRequest,
    CommitResponse,
    CommitSummaryOut,
    ElementOut,
    IssueOut,
    OpenResponse,
    PreviewRequest,
    PreviewResponse,
    RelationshipOut,
    RevertRequest,
)
from ..session import AppliedBatch
from .ops import (
    _apply_batch,
    _ensure_validation_seeded,
    _maybe_periodic_snapshot,
    _persist_commit,
    _rollback,
)

logger = logging.getLogger(__name__)

router = APIRouter()

#: op-dict keys that carry a resource id. In CANONICAL stored ops every one of
#: these holds a real id — a create op's ``temp_id`` was rewritten to the
#: assigned canonical id at apply time (see session.py / _apply_one).
_ID_KEYS = ("id", "temp_id", "source_id", "target_id")


def _affected_ids(commits: list[Commit]) -> set[str]:
    """Resource ids touched by the forward ops of these commits.

    Used by revert's peer-lock guard: any active lease over one of these ids
    means a peer is mid-edit on something the revert would change, so the
    revert is refused (409) rather than stomping their uncommitted work.
    """
    ids: set[str] = set()
    for c in commits:
        for op in c.ops:
            for key in _ID_KEYS:
                v = op.get(key)
                if isinstance(v, str):
                    ids.add(v)
    return ids


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
        lock_ttl_seconds=get_settings().lock_ttl_seconds,
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


@router.get("/commits", response_model=None)
def list_commits(
    project_id: str,
    limit: int = 50,
    before_rev: int | None = None,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> CommitHistoryResponse:
    """Durable commit history, newest-first (distinct from GET /model/changes,
    which reports the capped in-memory op_log). Read endpoint — any member.

    The ``session`` dependency ensures the caller is an authenticated project
    member (``get_request_session`` depends on ``require_membership``). No
    write-allowlist entry is needed because reads are open to all roles.

    Pagination: pass ``before_rev=<last_rev_on_page>`` to fetch older commits.
    ``limit`` is clamped to [1, 200] to bound response sizes.
    """
    limit = max(1, min(limit, 200))
    rows = content.list_commits(db, project_id, before_rev=before_rev, limit=limit + 1)
    has_more = len(rows) > limit
    rows = rows[:limit]
    return CommitHistoryResponse(
        commits=[
            CommitSummaryOut(
                rev=r.rev,
                commit_id=r.commit_id,
                author_id=r.author_id,
                ts=r.ts,
                message=r.message,
                validation_error_count=r.validation_error_count,
                op_count=len(r.ops),
                is_rebind=(r.from_metamodel_id is not None
                           or r.to_metamodel_id is not None),
            )
            for r in rows
        ],
        has_more=has_more,
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
       f. Periodic snapshot (mirrors apply_ops to bound replay tail).
       g. Release the caller's locks (explicit loop).
       h. Broadcast commit delta + lock-release events (inside mutex for
          enqueue-order == rev-order guarantee; broadcast is non-blocking).
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
        #    doesn't accumulate an unbounded replay tail. The durable commit has
        #    already landed; a snapshot failure here is recoverable (hydration
        #    rebuilds the snapshot on the next cache-miss), so we log and proceed
        #    rather than returning a 500 that would mislead the client into
        #    thinking the commit failed.
        if persisted:
            try:
                _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
            except Exception:
                logger.warning(
                    "post-commit snapshot failed for project %s at rev %s; "
                    "commit is durable, hydration will rebuild",
                    project_id,
                    session.model_rev,
                    exc_info=True,
                )
        # g. release the caller's locks (explicit loop — no helper)
        released = []
        for tok in payload.lock_tokens:
            released.extend(session.lock_table.release(user.id, tok))
        # h. broadcast commit delta + lock-release events (inside the mutex so
        #    enqueue order == rev order across concurrent commits).
        changed_elements = [
            ElementOut.from_core(model.elements[eid]).model_dump()
            for eid in res.changed_element_ids
        ]
        changed_relationships = [
            RelationshipOut.from_core(model.relationships[rid]).model_dump()
            for rid in res.changed_relationship_ids
        ]
        session.hub.broadcast(
            commit_event(
                rev=session.model_rev,
                commit_id=commit_id,
                author_id=user.id,
                message=payload.message,
                validation_error_count=len(conformance),
                changed_elements=changed_elements,
                changed_relationships=changed_relationships,
                deleted_element_ids=list(res.deleted_element_ids),
                deleted_relationship_ids=list(res.deleted_relationship_ids),
            )
        )
        if released:
            session.hub.broadcast(
                lock_event(
                    "released",
                    [
                        {"resource_id": le.resource_id, "mode": le.mode.value, "holder_id": le.holder}
                        for le in released
                    ],
                )
            )
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


@router.post("/commits/revert", response_model=None)
def revert_commit(
    payload: RevertRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommitResponse | JSONResponse:
    """Revert the model to the state at ``target_rev`` (Phase 8 spec §3.2).

    Mechanism (the proven POST /model/undo compensating-commit shape, applied
    to a *range*): apply the inverse_ops of every commit after target_rev,
    newest-first, in restore mode, recorded as ONE new forward commit. The
    journal stays append-only; model_rev only moves forward; the revert is
    itself revertible.

    Guards (Tasks 5–7) are layered on top of this core; broadcast is Task 8.
    """
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    state = _ensure_validation_seeded(session, model)
    if payload.target_rev < 0 or payload.target_rev > session.model_rev:
        return JSONResponse(
            status_code=422,
            content={"detail": "target_rev out of range",
                     "model_rev": session.model_rev},
        )
    if payload.target_rev == session.model_rev:
        # no-op: nothing to revert. Mirror the empty-batch path in apply_ops —
        # return current state WITHOUT bumping model_rev or recording a commit.
        return CommitResponse(
            model_rev=session.model_rev,
            id_map={},
            changed_elements=[],
            changed_relationships=[],
            deleted_element_ids=[],
            deleted_relationship_ids=[],
            issues_removed_owner_ids=[],
            issues_added=[],
            issue_counts=state.counts(),
            commit_id="",
            message="",
            validation_error_count=0,
        )
    with session.write_mutex:
        commits = content.commits_after(db, project_id, payload.target_rev)
        for c in commits:
            if c.from_metamodel_id is not None or c.to_metamodel_id is not None:
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "revert across a metamodel swap is not yet "
                                  "supported",
                        "rebind_rev": c.rev,
                    },
                )
        affected = _affected_ids(commits)
        held = [
            le
            for le in session.lock_table.active_leases(time.monotonic())
            if le.resource_id in affected
        ]
        if held:
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "resource locked by a peer",
                    "conflicts": [
                        {"resource_id": le.resource_id, "mode": le.mode.value,
                         "holder_id": le.holder}
                        for le in held
                    ],
                },
            )
        # apply inverse_ops newest-first; deserialize the stored JSON op dicts
        combined = deserialize_ops(
            [op for c in reversed(commits) for op in c.inverse_ops]
        )
        res = _apply_batch(model, combined, restore=True)
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
        commit_id = uuid.uuid4().hex
        message = payload.message or f"Revert to rev {payload.target_rev}"
        issues_json = [IssueOut.from_core(i).model_dump() for i in conformance]
        try:
            persisted = _persist_commit(
                db, project_id, rev=session.model_rev, author_id=user.id, res=res,
                _commit_id=commit_id, _message=message,
                _validation_error_count=len(conformance), _issues=issues_json,
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)
            session.model_rev -= 1
            session.op_log.pop()
            db.rollback()
            raise HTTPException(
                status_code=500, detail="failed to persist commit"
            ) from exc
        if persisted:
            try:
                _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
            except Exception:
                logger.warning(
                    "post-revert snapshot failed for project %s at rev %s; "
                    "commit is durable, hydration will rebuild",
                    project_id, session.model_rev, exc_info=True,
                )
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
        message=message,
        validation_error_count=len(conformance),
    )
