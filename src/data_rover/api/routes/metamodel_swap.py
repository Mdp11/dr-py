"""Phase 6B metamodel swap: read-only sandbox diff + non-destructive rebind.

``/metamodel/diff`` validates the live model against a CANDIDATE metamodel via
a no-copy ``build_rebind_view`` (shares the instance payload, rebuilds indexes)
and returns a conformance diff. ``/metamodel/rebind`` (Task 6) changes the
model's metamodel binding as a journaled commit. Both run under the per-project
``write_mutex`` so the validation sweep can't race a concurrent commit.
"""

from __future__ import annotations

import time
import uuid

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str
from data_rover.core.model.model import build_rebind_view
from data_rover.core.validation.issue import Issue
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from .. import content
from ..authz import require_membership, require_owner
from ..db import get_db
from ..db_models import Membership, User
from ..deps import Session, get_request_session, require_model
from ..feed import rebind_event
from ..hydration import write_snapshot
from ..identity import get_current_user
from ..schemas import IssueOut, MetamodelDiffResponse, RebindResponse
from .ops import _ensure_validation_seeded

router = APIRouter()


async def _read_metamodel_blob(request: Request) -> str:
    """Decode a metamodel request body to a YAML blob (JSON or YAML body),
    mirroring ``routes/metamodel.py``'s ``upload_metamodel`` content handling."""
    body = (await request.body()).decode("utf-8")
    if "json" in request.headers.get("content-type", ""):
        data = await request.json() if body else {}
        return yaml.safe_dump(data)
    return body


def _issue_key(issue: Issue) -> tuple[str, str, str, tuple[str, ...]]:
    """Stable identity for diffing two validation runs (Issue has no code)."""
    return (
        issue.category.value,
        issue.severity.value,
        issue.message,
        tuple(sorted(issue.target_ids)),
    )


def _load_candidate(blob: str):  # type: ignore[return]
    try:
        return load_metamodel_str(blob)
    except (MetamodelError, yaml.YAMLError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/metamodel/diff", response_model=None)
async def diff_metamodel(
    request: Request,
    session: Session = Depends(get_request_session),
    membership: Membership = Depends(require_membership),
) -> MetamodelDiffResponse:
    _, model = require_model(session)
    candidate = _load_candidate(await _read_metamodel_blob(request))
    with session.write_mutex:
        current = _ensure_validation_seeded(session, model).all_issues()
        candidate_issues = default_pipeline().validate(
            build_rebind_view(model, candidate)
        )
    cur_by_key = {_issue_key(i): i for i in current}
    cand_by_key = {_issue_key(i): i for i in candidate_issues}
    now_failing = [v for k, v in cand_by_key.items() if k not in cur_by_key]
    now_passing = [v for k, v in cur_by_key.items() if k not in cand_by_key]
    unchanged = len(cur_by_key.keys() & cand_by_key.keys())
    return MetamodelDiffResponse(
        now_failing=[IssueOut.from_core(i) for i in now_failing],
        now_passing=[IssueOut.from_core(i) for i in now_passing],
        unchanged_count=unchanged,
        current_error_count=len(current),
        candidate_error_count=len(candidate_issues),
    )


@router.post("/metamodel/rebind", response_model=None)
async def rebind_metamodel(
    request: Request,
    project_id: str,
    base_rev: int,
    message: str = "",
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
    membership: Membership = Depends(require_owner),
) -> RebindResponse | JSONResponse:
    """Owner-only, non-destructive metamodel rebind journaled as a commit.

    Refuses (409) when any lease is active — a rebind retypes the whole model
    and must not silently invalidate an open check-out. Mirrors the commit
    route's durable-failure pattern: a DB error fully restores in-memory state.

    Correction A applied: persists the original request blob rather than a
    pydantic re-serialization, avoiding any round-trip mismatch on hydration.
    """
    _, model = require_model(session)
    if base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    # Correction A: capture raw blob BEFORE parsing; persist the original source.
    raw_blob = await _read_metamodel_blob(request)
    candidate = _load_candidate(raw_blob)
    state = _ensure_validation_seeded(session, model)
    with session.write_mutex:
        if session.lock_table.active_leases(time.monotonic()):
            return JSONResponse(
                status_code=409,
                content={"detail": "active locks; rebind requires a quiet project"},
            )
        # capture rollback state — session.metamodel is guaranteed non-None
        # because require_model() already verified the model is loaded, which
        # requires a prior metamodel upload (session.set_metamodel called first).
        old_mm = session.metamodel
        assert old_mm is not None, "metamodel must be set before rebind"
        old_rev = session.model_rev
        model_row = content.get_model_row(db, project_id)
        from_id = model_row.metamodel_id if model_row is not None else None

        # persist the candidate as a new metamodel version (using the original blob)
        prior_version = 0
        if from_id is not None:
            prior = content.get_metamodel_row(db, from_id)
            prior_version = prior.version if prior is not None else 0
        mm_row = content.create_metamodel(
            db, name="", version=prior_version + 1, blob=raw_blob
        )

        # swap live metamodel + rebuild indexes + re-validate the whole model
        session.metamodel = candidate
        model.metamodel = candidate
        model.indexes.rebuild()
        issues = default_pipeline().validate(model, Scope.all())
        state.set_full(issues)
        session.validation = state
        session.model_rev += 1

        commit_id = uuid.uuid4().hex
        issues_json = [IssueOut.from_core(i).model_dump() for i in issues]
        try:
            content.upsert_model_row(db, project_id, metamodel_id=mm_row.id)
            content.set_model_rev(db, project_id, session.model_rev)
            content.append_commit(
                db, project_id,
                rev=session.model_rev, commit_id=commit_id, author_id=user.id,
                ops=[], inverse_ops=[], id_map={},
                message=message, validation_error_count=len(issues),
                issues=issues_json,
                from_metamodel_id=from_id, to_metamodel_id=mm_row.id,
            )
            db.commit()
        except Exception as exc:
            db.rollback()
            session.metamodel = old_mm
            model.metamodel = old_mm
            model.indexes.rebuild()
            session.model_rev = old_rev
            session.validation = None  # force a re-seed on next read
            raise HTTPException(status_code=500, detail="failed to persist rebind") from exc

        write_snapshot(project_id, session, session.model_rev)
        session.hub.broadcast(
            rebind_event(
                rev=session.model_rev,
                from_metamodel_id=from_id,
                to_metamodel_id=mm_row.id,
                validation_error_count=len(issues),
            )
        )
    return RebindResponse(
        model_rev=session.model_rev,
        metamodel_id=mm_row.id,
        validation_error_count=len(issues),
        issue_counts=state.counts(),
        issues=[IssueOut.from_core(i) for i in issues],
    )
